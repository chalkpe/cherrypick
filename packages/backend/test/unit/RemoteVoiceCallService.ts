/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { RemoteVoiceCallError, RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { StatusError } from '@/misc/status-error.js';

const me = { id: 'me', host: null, uri: null } as any;
const owner = { id: 'owner', host: 'remote.test', uri: 'https://remote.test/users/owner', isSuspended: false, isDeleted: false } as any;
const room = { id: 'r1', ownerId: 'owner', owner, isArchived: false } as any;
const TOKEN_URL = 'https://remote.test/livekit/federation/token';

function hostResponse(overrides: Record<string, unknown> = {}) {
	return {
		url: 'https://remote.test/livekit',
		token: 'jwt',
		participants: [{ identity: 'https://remote.test/users/owner', screenSharing: true }],
		updatedAt: 1234,
		...overrides,
	};
}

function fakeRedis() {
	const store = new Map<string, string>();
	return {
		store,
		exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
		set: vi.fn(async (key: string, value: string, ..._args: (string | number)[]) => {
			store.set(key, value);
			return 'OK';
		}),
	};
}

function portOwner(overrides: Record<string, unknown> = {}) {
	return { id: 'owner', host: 'evil.example:8443', uri: 'https://evil.example:8443/users/owner', isSuspended: false, isDeleted: false, ...overrides } as any;
}

function createFixture(metaOverrides: Record<string, unknown> = {}, instances: { host: string; suspensionState: string }[] = []) {
	const meta = { enableRemoteVoiceCall: true, federation: 'all', federationHosts: [], blockedHosts: [], ...metaOverrides };
	const redis = fakeRedis();
	const apRequestService = {
		signedPostJson: vi.fn(async (..._args: unknown[]): Promise<unknown> => hostResponse()),
	};
	// 実物を使い、ブロックの判定 (ポート付きのホストを含む) と記録を引く host の正規化 (toPuny はポート付きのホストに '' を返す) もそのまま確かめる
	const utilityService = new UtilityService({ host: 'local.test', url: 'https://local.test' } as any, meta as any);
	vi.spyOn(utilityService, 'isFederationAllowedHost');
	// instance.host は保存されたとおりの文字列で引かれる (where の host は In)。正規化はサービスの側でする
	const instancesRepository = {
		findBy: vi.fn(async ({ host }: { host: { value: string[] } }) => instances.filter(instance => host.value.includes(instance.host))),
	};
	// 持ち主のサーバーを断るかどうかは ChatVoiceService の判定 (isRefusedRemoteHost) をそのまま使う
	const chatVoiceService = Object.assign(Object.create(ChatVoiceService.prototype), { meta, utilityService, instancesRepository });
	Object.defineProperty(chatVoiceService, 'storeRemoteSnapshot', { value: vi.fn(async (): Promise<string> => 'stored') });
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const loggerService = { getLogger: () => logger };
	const service = new RemoteVoiceCallService(
		redis as any,
		meta as any,
		apRequestService as any,
		chatVoiceService,
		loggerService as any,
	);
	return { service, redis, apRequestService, chatVoiceService, utilityService, instancesRepository, logger };
}

function abortError() {
	return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
}

describe('RemoteVoiceCallService', () => {
	test('asks the host for a token with the room URI and screen share wish', async () => {
		const f = createFixture();

		const result = await f.service.requestJoin(me, room, owner, true);

		expect(result).toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
		expect(f.apRequestService.signedPostJson).toHaveBeenCalledTimes(1);
		expect(f.apRequestService.signedPostJson).toHaveBeenCalledWith(
			me,
			TOKEN_URL,
			{ room: 'https://remote.test/chat/rooms/r1', canScreenShare: true },
			10_000,
			{ redirect: 'manual', size: 64 * 1024 },
		);
	});

	test('passes on the TURN servers the host sent', async () => {
		const f = createFixture();
		const iceServers = [
			{ urls: ['stun:stun.cloudflare.com:3478'] },
			{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
		];
		f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse({ iceServers }));

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers });
	});

	test.each([
		['an older host that sends none', undefined],
		['null', null],
		['too many servers', Array.from({ length: 5 }, () => ({ urls: ['stun:stun.example'] }))],
		['too many urls', [{ urls: Array.from({ length: 9 }, (_, i) => `stun:stun${i}.example`) }]],
		['a url that is not STUN or TURN', [{ urls: ['https://evil.example/'] }]],
		['a url that is too long', [{ urls: [`turn:${'a'.repeat(257)}`] }]],
		['a credential that is too long', [{ urls: ['turn:turn.example'], username: 'u', credential: 'c'.repeat(513) }]],
		['a TURN url without credentials', [{ urls: ['turn:turn.example:3478'] }]],
		['a url on port 53', [{ urls: ['stun:stun.example:53'] }]],
		['something that is not a list', 'turn:turn.example'],
	])('joins without TURN servers when the host sends %s', async (_label, iceServers) => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse({ iceServers }));

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
	});

	test('stores the participants the host sent', async () => {
		const f = createFixture();
		const participants = [
			{ identity: 'https://remote.test/users/owner', screenSharing: true },
			{ identity: 'https://local.test/users/me2', screenSharing: false },
		];
		f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse({ participants, updatedAt: 777 }));

		await f.service.requestJoin(me, room, owner, false);

		// 鮮度はホストの時計で比べるので、応答の updatedAt をそのまま渡す
		expect(f.chatVoiceService.storeRemoteSnapshot).toHaveBeenCalledWith(room, participants, 777);
	});

	test('lets the user join even when storing the participants fails, and logs the failure', async () => {
		const f = createFixture();
		f.chatVoiceService.storeRemoteSnapshot.mockRejectedValueOnce(new Error('redis is down'));

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
		await vi.waitFor(() => expect(f.logger.warn).toHaveBeenCalledTimes(1));
		expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining('r1'), { error: expect.objectContaining({ message: 'redis is down' }) });
	});

	test('remembers a host without voice support for an hour', async () => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockRejectedValueOnce(new StatusError('404 Not Found', 404, 'Not Found'));

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'unsupported' });
		expect(f.redis.set).toHaveBeenCalledWith('chatVoice:unsupportedHost:remote.test', expect.any(String), 'EX', 3600);

		const second = f.service.requestJoin(me, room, owner, false);
		await expect(second).rejects.toBeInstanceOf(RemoteVoiceCallError);
		await expect(second).rejects.toMatchObject({ reason: 'unsupported' });
		expect(f.apRequestService.signedPostJson).toHaveBeenCalledTimes(1);
	});

	test('does not remember a host that timed out', async () => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockRejectedValueOnce(abortError());

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'unreachable' });
		expect(f.redis.set).not.toHaveBeenCalled();

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
		expect(f.apRequestService.signedPostJson).toHaveBeenCalledTimes(2);
	});

	test('maps a 403 to forbidden', async () => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockRejectedValueOnce(new StatusError('403 Forbidden', 403, 'Forbidden'));

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'forbidden' });
		expect(f.redis.set).not.toHaveBeenCalled();
	});

	test('maps a failed signature check (401) to forbidden', async () => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockRejectedValueOnce(new StatusError('401 Unauthorized', 401, 'Unauthorized'));

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'forbidden' });
		expect(f.redis.set).not.toHaveBeenCalled();
	});

	test.each([
		['a redirect', new StatusError('302 Found', 302, 'Found')],
		['rate limiting', new StatusError('429 Too Many Requests', 429, 'Too Many Requests')],
		['a server error', new StatusError('500 Internal Server Error', 500, 'Internal Server Error')],
		['a malformed request answer', new StatusError('400 Bad Request', 400, 'Bad Request')],
		['a network error', new Error('getaddrinfo ENOTFOUND remote.test')],
	])('treats %s as unreachable without remembering it', async (_label, error) => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockRejectedValueOnce(error);

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'unreachable' });
		expect(f.redis.set).not.toHaveBeenCalled();
		expect(f.chatVoiceService.storeRemoteSnapshot).not.toHaveBeenCalled();
	});

	test('refuses a host this server does not federate with, without contacting it', async () => {
		const f = createFixture({ blockedHosts: ['remote.test'] });

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'forbidden' });
		expect(f.utilityService.isFederationAllowedHost).toHaveBeenCalledWith('remote.test');
		expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
	});

	describe('trust in the owner and its server', () => {
		test('joins a call on a host with a port when nothing refuses it', async () => {
			const f = createFixture();
			f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse({ url: 'https://evil.example:8443/livekit' }));

			await expect(f.service.requestJoin(me, room, portOwner(), false)).resolves.toEqual({ url: 'https://evil.example:8443/livekit', token: 'jwt', iceServers: null });
			expect(f.apRequestService.signedPostJson).toHaveBeenCalledWith(
				me,
				'https://evil.example:8443/livekit/federation/token',
				{ room: 'https://evil.example:8443/chat/rooms/r1', canScreenShare: false },
				10_000,
				expect.anything(),
			);
		});

		test('refuses an owner on a port of a blocked domain without contacting it', async () => {
			const f = createFixture({ blockedHosts: ['evil.example'] });

			await expect(f.service.requestJoin(me, room, portOwner(), false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test('refuses an owner whose server is suspended', async () => {
			const f = createFixture({}, [{ host: 'remote.test', suspensionState: 'manuallySuspended' }]);

			await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test.each([
			// 管理画面で evil.example:8443 を停止すると、toPuny で '' になった記録が停止される (配送もこの記録で止まる)
			['the record the codebase keeps for hosts with a port', ''],
			['the record of the same domain', 'evil.example'],
			// domainToASCII を使う前は、ポート付きのホストがそのまま記録されていた
			['the record kept with its port', 'evil.example:8443'],
			['the record of the same domain with a trailing dot', 'evil.example.'],
			['the record kept with its port and a trailing dot', 'evil.example.:8443'],
		])('refuses an owner on a port whose server is suspended through %s', async (_label, storedHost) => {
			const f = createFixture({}, [{ host: storedHost, suspensionState: 'manuallySuspended' }]);

			await expect(f.service.requestJoin(me, room, portOwner(), false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test('refuses an owner on a host with a trailing dot and a port whose server is suspended through the record without them', async () => {
			const f = createFixture({}, [{ host: 'evil.example', suspensionState: 'manuallySuspended' }]);

			await expect(f.service.requestJoin(me, room, portOwner({ host: 'evil.example.:8443', uri: 'https://evil.example.:8443/users/owner' }), false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		// 停止の記録の host は punycode で保存される (管理画面も toPuny してから引く)
		test.each([
			['without a port', 'xn--vil-ima.example'],
			['with a port', 'xn--vil-ima.example:8443'],
		])('refuses an owner on an internationalized domain %s whose server is suspended', async (_label, host) => {
			const f = createFixture({}, [{ host: 'xn--vil-ima.example', suspensionState: 'manuallySuspended' }]);

			await expect(f.service.requestJoin(me, room, portOwner({ host, uri: `https://${host}/users/owner` }), false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test('reads every record of the owner\'s server in one query', async () => {
			const f = createFixture();
			f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse({ url: 'https://evil.example:8443/livekit' }));

			await f.service.requestJoin(me, room, portOwner(), false);

			expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
			expect(f.instancesRepository.findBy.mock.calls[0][0].host.value).toEqual(expect.arrayContaining(['', 'evil.example', 'evil.example.', 'evil.example:8443', 'evil.example.:8443']));
		});

		test('refuses an owner whose server is suspended through the record with a trailing dot', async () => {
			const f = createFixture({}, [{ host: 'remote.test.', suspensionState: 'manuallySuspended' }]);

			await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test('does not let the record shared by hosts with a port refuse an owner without one', async () => {
			const f = createFixture({}, [{ host: '', suspensionState: 'autoSuspendedForNotResponding' }]);

			await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
		});

		// inbox と同じく、ブロックはポート・末尾のドット・Unicode の違いを無視して当てる
		test.each([
			['a trailing dot', 'evil.example.', ['evil.example']],
			['a port and a trailing dot', 'evil.example.:8443', ['evil.example']],
			['a port, blocked by an entry with another port', 'evil.example:8443', ['evil.example:9999']],
			['no port, blocked by an entry with a port', 'evil.example', ['evil.example:8443']],
			['a port, blocked by an entry with a trailing dot', 'evil.example:8443', ['evil.example.']],
			['a port, blocked by a Unicode entry', 'xn--vil-ima.example:8443', ['ëvil.example']],
		])('refuses an owner on a host with %s whose domain is blocked', async (_label, host, blockedHosts) => {
			const f = createFixture({ blockedHosts });

			await expect(f.service.requestJoin(me, room, portOwner({ host, uri: `https://${host}/users/owner` }), false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test('ignores suspension records of other servers', async () => {
			const f = createFixture({}, [{ host: 'other.test', suspensionState: 'manuallySuspended' }, { host: 'remote.test', suspensionState: 'none' }]);

			await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
		});

		test.each([
			['suspended', { isSuspended: true }],
			['deleted', { isDeleted: true }],
		])('refuses a %s owner', async (_label, overrides) => {
			const f = createFixture();

			await expect(f.service.requestJoin(me, room, { ...owner, ...overrides }, false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test.each([
			['another server', 'https://other.test/users/owner'],
			['another port', 'https://remote.test:8443/users/owner'],
		])('refuses an owner whose URI points to %s than its host', async (_label, uri) => {
			const f = createFixture();

			await expect(f.service.requestJoin(me, room, { ...owner, uri }, false)).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});

		test('treats a malformed owner URI as forbidden', async () => {
			const f = createFixture();

			const joined = f.service.requestJoin(me, room, { ...owner, uri: 'not a url' }, false);

			await expect(joined).rejects.toBeInstanceOf(RemoteVoiceCallError);
			await expect(joined).rejects.toMatchObject({ reason: 'forbidden' });
			expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
		});
	});

	test.each([
		['a LiveKit URL on another server', { url: 'https://evil.test/livekit' }],
		['a LiveKit URL elsewhere on the host', { url: 'https://remote.test/livekit/../evil' }],
		['no token', { token: '' }],
		['a token that is not a string', { token: 42 }],
		['participants that are not a list', { participants: 'nobody' }],
		['a participant without an identity', { participants: [{ screenSharing: false }] }],
		['a participant without a screen sharing flag', { participants: [{ identity: 'https://remote.test/users/a' }] }],
		['more participants than a room can hold', { participants: Array.from({ length: 52 }, (_, i) => ({ identity: `https://remote.test/users/${i}`, screenSharing: false })) }],
		['a missing timestamp', { updatedAt: undefined }],
		['a timestamp that is not a finite number', { updatedAt: Number.NaN }],
	])('treats an answer with %s as unreachable', async (_label, overrides) => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse(overrides));

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'unreachable' });
		expect(f.chatVoiceService.storeRemoteSnapshot).not.toHaveBeenCalled();
	});

	test.each([null, 'text', []])('treats a non-object answer (%j) as unreachable', async body => {
		const f = createFixture();
		f.apRequestService.signedPostJson.mockResolvedValueOnce(body);

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'unreachable' });
	});

	test('accepts a full room', async () => {
		const f = createFixture();
		const participants = Array.from({ length: 51 }, (_, i) => ({ identity: `https://remote.test/users/${i}`, screenSharing: false }));
		f.apRequestService.signedPostJson.mockResolvedValueOnce(hostResponse({ participants }));

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt', iceServers: null });
	});

	test.each([
		[{ enableRemoteVoiceCall: true, federation: 'all' }, true],
		[{ enableRemoteVoiceCall: true, federation: 'specified' }, true],
		[{ enableRemoteVoiceCall: false, federation: 'all' }, false],
		[{ enableRemoteVoiceCall: true, federation: 'none' }, false],
	])('reports whether remote calls are enabled for %j', (meta, expected) => {
		expect(createFixture(meta).service.isEnabled).toBe(expected);
	});
});
