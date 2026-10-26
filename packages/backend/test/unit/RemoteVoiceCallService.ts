/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { RemoteVoiceCallError, RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';
import { StatusError } from '@/misc/status-error.js';

const me = { id: 'me', host: null, uri: null } as any;
const owner = { id: 'owner', host: 'remote.test', uri: 'https://remote.test/users/owner' } as any;
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

function createFixture(meta: { enableRemoteVoiceCall: boolean; federation: string } = { enableRemoteVoiceCall: true, federation: 'all' }) {
	const redis = fakeRedis();
	const apRequestService = {
		signedPostJson: vi.fn(async (..._args: unknown[]): Promise<unknown> => hostResponse()),
	};
	const chatVoiceService = {
		storeRemoteSnapshot: vi.fn(async () => {}),
	};
	const utilityService = {
		isFederationAllowedHost: vi.fn((_host: string) => true),
	};
	const service = new RemoteVoiceCallService(
		redis as any,
		meta as any,
		apRequestService as any,
		chatVoiceService as any,
		utilityService as any,
	);
	return { service, redis, apRequestService, chatVoiceService, utilityService };
}

function abortError() {
	return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
}

describe('RemoteVoiceCallService', () => {
	test('asks the host for a token with the room URI and screen share wish', async () => {
		const f = createFixture();

		const result = await f.service.requestJoin(me, room, owner, true);

		expect(result).toEqual({ url: 'https://remote.test/livekit', token: 'jwt' });
		expect(f.apRequestService.signedPostJson).toHaveBeenCalledTimes(1);
		expect(f.apRequestService.signedPostJson).toHaveBeenCalledWith(
			me,
			TOKEN_URL,
			{ room: 'https://remote.test/chat/rooms/r1', canScreenShare: true },
			10_000,
			{ redirect: 'manual', size: 64 * 1024 },
		);
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

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt' });
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
		const f = createFixture();
		f.utilityService.isFederationAllowedHost.mockReturnValue(false);

		await expect(f.service.requestJoin(me, room, owner, false)).rejects.toMatchObject({ reason: 'forbidden' });
		expect(f.utilityService.isFederationAllowedHost).toHaveBeenCalledWith('remote.test');
		expect(f.apRequestService.signedPostJson).not.toHaveBeenCalled();
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

		await expect(f.service.requestJoin(me, room, owner, false)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'jwt' });
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
