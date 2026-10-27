/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// ChatVoiceService のうち、通話に残れるか (admissionOf) を確かめて外すところと、他のサーバーを断るか (HostPolicyService) を使うところのテスト

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Fixture } from '../misc/chat-voice-fixture.js';
import UpdateInstanceEndpoint from '@/server/api/endpoints/admin/federation/update-instance.js';
import { KNOWN_USERS, TEST_CLOCK, createFixture, fakeRedis, pauseNextCall, remoteUser } from '../misc/chat-voice-fixture.js';

describe('ChatVoiceService admission', () => {
	let f: ReturnType<typeof createFixture>;

	beforeEach(() => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		f = createFixture();
	});

	afterEach(() => {
		f.service.onApplicationShutdown();
		vi.useRealTimers();
	});

	describe('refusing the server of a remote member when issuing a token', () => {
		test('refuses a remote user whose server is blocked or suspended', async () => {
			f.meta.blockedHosts = ['remote.test'];
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
			expect(f.utilityService.isFederationAllowedHost).toHaveBeenCalledWith('remote.test');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();

			f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'manuallySuspended' }]);
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		// inbox と同じく、ブロックはポート・末尾のドット・Unicode の違いを無視して当てる
		test.each([
			['a port', 'evil.example:8443', ['evil.example']],
			['a port and a trailing dot', 'evil.example.:8443', ['evil.example']],
			['a port, blocked by an entry with another port', 'evil.example:8443', ['evil.example:9999']],
			['a port, blocked by a Unicode entry', 'xn--vil-ima.example:8443', ['ëvil.example']],
		])('refuses a remote user on a host with %s whose domain is blocked', async (_label, host, blockedHosts) => {
			f.meta.blockedHosts = blockedHosts;

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host, uri: `https://${host}/users/ru1` }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test.each([
			// 管理画面で evil.example:8443 を停止すると、toPuny で '' になった記録が停止される (配送もこの記録で止まる)
			['the record the codebase keeps for hosts with a port', ''],
			['the record of the same domain', 'evil.example'],
			['the record kept with its port', 'evil.example:8443'],
			['the record of the same domain with a trailing dot', 'evil.example.'],
			['the record kept with its port and a trailing dot', 'evil.example.:8443'],
		])('refuses a remote user on a port whose server is suspended through %s', async (_label, storedHost) => {
			f = createFixture(undefined, [{ host: storedHost, suspensionState: 'manuallySuspended' }]);

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'evil.example:8443', uri: 'https://evil.example:8443/users/ru1' }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose server is suspended through the record with a trailing dot', async () => {
			f = createFixture(undefined, [{ host: 'remote.test.', suspensionState: 'autoSuspendedForNotResponding' }]);

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
		});

		test('refuses a dotted host listed only through a dotted entry under specified federation, as the inbox does', async () => {
			Object.assign(f.meta, { federation: 'specified', federationHosts: ['remote.test', 'evil.example.'] });
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).not.toBe('forbidden');

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'evil.example.', uri: 'https://evil.example./users/ru1' }), 'r1', false);

			expect(result).toBe('forbidden');
		});

		// inbox は連合を許すかを正規化したホスト (ポートと末尾のドットを除いた小文字の punycode) だけで決める
		test('admits a server on a port of a listed domain under specified federation, as the inbox does', async () => {
			Object.assign(f.meta, { federation: 'specified', federationHosts: ['remote.test'] });

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'remote.test:8443', uri: 'https://remote.test:8443/users/ru1' }), 'r1', false);

			expect(result).not.toBe('forbidden');
		});

		// ポート付きのホストの記録はすべて '' にまとめられる。停止は fetch() と同じくその記録にも従うが、
		// 隔離は inbox と同じく、そのサーバーの記録 (hostLookupCandidates) だけで決める
		test('does not let a quarantine of the record shared by hosts with a port refuse a server on a port, as the inbox does', async () => {
			f = createFixture(undefined, [{ host: '', suspensionState: 'none', quarantineLimited: true }]);

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'evil.example:8443', uri: 'https://evil.example:8443/users/ru1' }), 'r1', false);

			expect(result).not.toBe('forbidden');
		});

		test.each([
			['the record of the same domain', 'evil.example'],
			['the record kept with its port', 'evil.example:8443'],
		])('refuses a remote user on a port whose server is quarantined through %s', async (_label, storedHost) => {
			f = createFixture(undefined, [{ host: storedHost, suspensionState: 'none', quarantineLimited: true }]);

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'evil.example:8443', uri: 'https://evil.example:8443/users/ru1' }), 'r1', false);

			expect(result).toBe('forbidden');
		});

		test('refuses a remote user whose server is quarantined', async () => {
			f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none', quarantineLimited: true }]);

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('treats a server this server has no record of as not suspended', async () => {
			// 記録を引いたうえで、一つも無い
			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
			expect(await f.instancesRepository.findBy.mock.results[0].value).toEqual([]);
			expect(result).not.toBe('forbidden');
			expect(f.liveKitService.createJoinToken).toHaveBeenCalledTimes(1);
		});

		test('does not let the record shared by hosts with a port refuse a remote user without one', async () => {
			f = createFixture(undefined, [{ host: '', suspensionState: 'manuallySuspended' }, { host: 'remote.test', suspensionState: 'none' }]);

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).not.toBe('forbidden');
		});

		test('reads suspensions as they are now, not from a cache', async () => {
			f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none' }]);
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).not.toBe('forbidden');

			f.instancesRepository.rows[0].suspensionState = 'manuallySuspended';

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
		});
	});

	describe('keeping calls in line with federation moderation', () => {
		function participant(user: { id: string; host: string | null; uri: string | null }) {
			const identity = user.host == null ? `https://local.test/users/${user.id}` : user.uri!;
			return { identity, userId: user.id, screenSharing: false, micTrackSid: null };
		}

		const u1 = KNOWN_USERS.find(user => user.id === 'u1')!;
		const rm1 = KNOWN_USERS.find(user => user.id === 'rm1')!;
		const rm2 = KNOWN_USERS.find(user => user.id === 'rm2')!;
		const rm3 = KNOWN_USERS.find(user => user.id === 'rm3')!;
		const x1 = KNOWN_USERS.find(user => user.id === 'x1')!;

		function startCall(roomId: string, users: { id: string; host: string | null; uri: string | null }[]) {
			if (!f.redis.sets.has('chatVoice:active')) f.redis.sets.set('chatVoice:active', new Set());
			f.redis.sets.get('chatVoice:active')!.add(roomId);
			const previous = f.liveKitService.listParticipants.getMockImplementation();
			f.liveKitService.listParticipants.mockImplementation(async (id: string) => {
				if (id === roomId) return users.map(participant);
				return previous != null ? await previous(id) : [];
			});
		}

		/** 管理画面での設定の変更。GlobalModule の購読が先に DI.meta を書き換えるので、届いた時点で meta は after と同じ */
		function publishMetaUpdated(changes: Record<string, unknown>, options: { withoutBefore?: boolean } = {}) {
			const before = { ...f.meta };
			Object.assign(f.meta, changes);
			const body = options.withoutBefore ? { after: { ...f.meta } } : { before, after: { ...f.meta } };
			f.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body } }));
		}

		function removed() {
			return f.liveKitService.removeParticipant.mock.calls.map(([roomId, identity]) => `${roomId} ${identity}`).sort();
		}

		test('removes participants from a newly blocked server', async () => {
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			await vi.waitFor(() => expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('r1', rm1.uri));
		});

		test('leaves participants from other servers alone', async () => {
			startCall('r1', [u1, rm1, rm3]);
			startCall('r2', [rm2, x1]);
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${rm1.uri}`, `r2 ${rm2.uri}`]);
		});

		/** 内部イベントは Redis を通ってすべてのワーカーに届く (GlobalEventService.publishInternalEvent) */
		function internalEventBus() {
			return {
				publishInternalEvent: vi.fn((type: string, body: unknown) => {
					f.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type, body } }));
				}),
			};
		}

		test('removes participants when an admin suspends their server', async () => {
			f = createFixture(undefined, [{ id: 'i1', host: 'remote.test', suspensionState: 'none' }, { id: 'i2', host: 'far.test', suspensionState: 'none' }]);
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();
			const federatedInstanceService = {
				update: vi.fn(async (id: string, data: { suspensionState?: string }) => {
					const row = f.instancesRepository.rows.find(instance => instance.id === id)!;
					if (data.suspensionState != null) row.suspensionState = data.suspensionState;
				}),
			};
			// 管理画面のエンドポイントは通話のことを知らず、停止を内部イベントで知らせるだけ
			const endpoint = new (UpdateInstanceEndpoint as any)(
				{ findOneBy: async ({ host }: { host: string }) => f.instancesRepository.rows.find(instance => instance.host === host) ?? null },
				f.utilityService,
				federatedInstanceService,
				{ log: vi.fn() },
				internalEventBus(),
			);

			await endpoint.exec({ host: 'remote.test', isSuspended: true }, { id: 'admin' }, null, null);

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
		});

		test('leaves calls alone when an admin lifts a suspension', async () => {
			// 確かめ直せば外れる参加者 (ブロックされたサーバーのユーザー) がいても、停止を解いた知らせでは確かめ直さない
			startCall('r1', [u1, rm1]);
			f.meta.blockedHosts = ['remote.test'];
			f.service.onModuleInit();

			internalEventBus().publishInternalEvent('instanceSuspensionStateUpdated', { id: 'i1', host: 'other.test', suspensionState: 'none' });
			await new Promise(resolve => setTimeout(resolve, 10));

			expect(f.liveKitService.listParticipants).not.toHaveBeenCalled();
			expect(removed()).toEqual([]);

			// 停止の知らせなら確かめ直す
			internalEventBus().publishInternalEvent('instanceSuspensionStateUpdated', { id: 'i2', host: 'other.test', suspensionState: 'manuallySuspended' });

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
			expect(f.liveKitService.listParticipants.mock.calls).toEqual([['r1']]);
		});

		// 停止の知らせはすべてのワーカーに届く。ルームごとに一つのワーカーだけが LiveKit を読んで確かめ直す
		test('re-checks each room on one worker when a suspension reaches every worker', async () => {
			const sharedRedis = fakeRedis();
			const workers = [createFixture(sharedRedis), createFixture(sharedRedis)];
			sharedRedis.sets.set('chatVoice:active', new Set(['r1', 'r2']));
			for (const worker of workers) {
				worker.meta.blockedHosts = ['remote.test'];
				worker.liveKitService.listParticipants.mockImplementation(async (roomId: string) => [participant(roomId === 'r1' ? rm1 : rm2)]);
				worker.service.onModuleInit();
			}

			for (const worker of workers) {
				worker.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'instanceSuspensionStateUpdated', body: { id: 'i1', host: 'remote.test', suspensionState: 'manuallySuspended' } } }));
			}

			const removedByAll = () => workers.flatMap(worker => worker.liveKitService.removeParticipant.mock.calls.map(([roomId, identity]) => `${roomId} ${identity}`)).sort();
			await vi.waitFor(() => expect(removedByAll()).toEqual([`r1 ${rm1.uri}`, `r2 ${rm2.uri}`]));
			expect(workers.flatMap(worker => worker.liveKitService.listParticipants.mock.calls.map(([roomId]) => roomId)).sort()).toEqual(['r1', 'r2']);
			for (const worker of workers) worker.service.onApplicationShutdown();
		});

		test('re-checks the rooms again for a suspension of another server that follows at once', async () => {
			startCall('r1', [u1]);
			f.service.onModuleInit();

			internalEventBus().publishInternalEvent('instanceSuspensionStateUpdated', { id: 'i1', host: 'remote.test', suspensionState: 'manuallySuspended' });
			await vi.waitFor(() => expect(f.liveKitService.listParticipants).toHaveBeenCalledTimes(1));
			internalEventBus().publishInternalEvent('instanceSuspensionStateUpdated', { id: 'i2', host: 'far.test', suspensionState: 'manuallySuspended' });

			await vi.waitFor(() => expect(f.liveKitService.listParticipants).toHaveBeenCalledTimes(2));
		});

		test('logs a failed removal started by a suspension', async () => {
			vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockRejectedValue(new Error('LiveKit is down'));
			f.service.onModuleInit();

			internalEventBus().publishInternalEvent('instanceSuspensionStateUpdated', { id: 'i1', host: 'remote.test', suspensionState: 'manuallySuspended' });

			await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
		});

		test.each([
			['a subdomain of a blocked domain', 'sub.remote.test', ['remote.test']],
			['a port on a blocked domain', 'remote.test:8443', ['remote.test']],
			['a trailing dot', 'remote.test.', ['remote.test']],
			['a block entry in another case', 'remote.test', ['Remote.TEST']],
			['a block entry with a port', 'remote.test', ['remote.test:8443']],
		])('removes a participant on %s', async (_label, host, blockedHosts) => {
			const p = { id: 'p', host, uri: `https://${host}/users/p` };
			f.usersRepository.findBy.mockResolvedValue([p, u1, rm3] as any);
			startCall('r1', [p, u1, rm3]);
			f.meta.blockedHosts = blockedHosts;

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${p.uri}`]);
		});

		test('does not take a lookalike domain for a blocked one', async () => {
			const p = { id: 'p', host: 'notremote.test', uri: 'https://notremote.test/users/p' };
			f.usersRepository.findBy.mockResolvedValue([p] as any);
			startCall('r1', [p]);
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([]);
		});

		test('removes every remote participant when federation is turned off', async () => {
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();

			publishMetaUpdated({ federation: 'none' });

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm3.uri}`, `r1 ${rm1.uri}`]));
		});

		test('removes participants from servers left off the federation list', async () => {
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();

			publishMetaUpdated({ federation: 'specified', federationHosts: ['far.test'] });

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
		});

		test('removes participants from a server suspended through another record of it', async () => {
			f = createFixture(undefined, [{ host: 'remote.test.', suspensionState: 'manuallySuspended' }]);
			startCall('r1', [u1, rm1, rm3]);

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${rm1.uri}`]);
		});

		test('keeps going when one room cannot be read', async () => {
			startCall('r1', [rm1]);
			startCall('r2', [rm2]);
			const list = f.liveKitService.listParticipants.getMockImplementation()!;
			f.liveKitService.listParticipants.mockImplementation(async (roomId: string) => {
				if (roomId === 'r1') throw new Error('LiveKit is down');
				return await list(roomId);
			});
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r2 ${rm2.uri}`]);
			expect(f.logger.warn).toHaveBeenCalled();
		});

		test('keeps going when one participant cannot be removed', async () => {
			startCall('r1', [rm1, rm2]);
			f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${rm1.uri}`, `r1 ${rm2.uri}`]);
			expect(f.logger.warn).toHaveBeenCalled();
		});

		test.each([
			['blockedHosts', { blockedHosts: ['remote.test'] }],
			['federation', { federation: 'specified' }],
			['federationHosts', { federationHosts: ['far.test'] }],
		])('re-checks the calls when %s changes', async (_label, changes) => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);

			await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
		});

		test('re-checks the calls when the previous settings are unknown', async () => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated({}, { withoutBefore: true });

			await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
		});

		test.each([
			['the server name', { name: 'renamed' }],
			['remote voice calls', { enableRemoteVoiceCall: false }],
			['silenced servers', { silencedHosts: ['remote.test'] }],
			['nothing', {}],
			['the block list, to an equal list', { blockedHosts: [] }],
		])('does not re-check the calls when only %s changes', async (_label, changes) => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);
			// 後から届いた変更でだけ読み直したことを確かめる
			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
			expect(sweep).toHaveBeenCalledTimes(1);
		});

		test('stops listening for setting changes on shutdown', async () => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();
			f.service.onApplicationShutdown();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			expect(f.redisForSub.listenerCount('message')).toBe(0);
			expect(sweep).not.toHaveBeenCalled();
		});

		test('logs a failed sweep started by a setting change', async () => {
			vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockRejectedValue(new Error('redis is down'));
			f.service.onModuleInit();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
		});

		describe('re-checking who may stay on every sweep', () => {
			test('removes a refused participant from a room that became active after the moderation sweep ran', async () => {
				// 入ったときの確認は通ったが、ルームが通話中として記録される (refresh) 前にブロックされた
				f.liveKitService.listParticipants.mockResolvedValue([participant(rm1)]);
				f.meta.blockedHosts = ['remote.test'];
				await f.service.removeRefusedRemoteParticipants();
				expect(removed()).toEqual([]);

				await f.service.refresh('r1');
				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('retries a removal that failed on the next periodic sweep', async () => {
				startCall('r1', [u1, rm1]);
				f.meta.blockedHosts = ['remote.test'];
				f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));

				await f.service.removeRefusedRemoteParticipants();
				expect(f.logger.warn).toHaveBeenCalled();

				await f.service.sweep();

				expect(f.liveKitService.removeParticipant.mock.calls).toEqual([['r1', rm1.uri], ['r1', rm1.uri]]);
			});

			test.each(['goneSuspended', 'autoSuspendedForNotResponding'])('removes participants of a server that became %s without any admin action', async (suspensionState) => {
				f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none' }]);
				startCall('r1', [u1, rm1, rm3]);
				f.instancesRepository.rows[0].suspensionState = suspensionState;

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('removes participants of a quarantined server', async () => {
				f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none', quarantineLimited: true }]);
				startCall('r1', [u1, rm1, rm3]);

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('removes participants who left the room or whose identity is not their user\'s', async () => {
				const mismatched = { identity: 'https://evil.test/users/x', userId: 'u2', screenSharing: false, micTrackSid: null };
				startCall('r1', [u1, rm1, rm3]);
				const list = f.liveKitService.listParticipants.getMockImplementation()!;
				f.liveKitService.listParticipants.mockImplementation(async (roomId: string) => [...await list(roomId), mismatched]);
				f.nonMembers.add('rm3');

				await f.service.sweep();

				expect(removed()).toEqual(['r1 https://evil.test/users/x', `r1 ${rm3.uri}`]);
			});

			test('keeps everyone who may stay', async () => {
				startCall('r1', [u1, rm1, rm3]);

				await f.service.sweep();

				expect(removed()).toEqual([]);
			});

			test('re-reads each active room on one worker only, and removes who may not stay there', async () => {
				const sharedRedis = fakeRedis();
				sharedRedis.sets.set('chatVoice:active', new Set(['r1', 'r2']));
				const workers = [createFixture(sharedRedis), createFixture(sharedRedis)];
				for (const worker of workers) {
					worker.meta.blockedHosts = ['remote.test'];
					worker.liveKitService.listParticipants.mockImplementation(async (roomId: string) => [participant(u1), participant(roomId === 'r1' ? rm1 : rm2)]);
				}

				await Promise.all(workers.map(worker => worker.service.sweep()));

				expect(workers.flatMap(worker => worker.liveKitService.listParticipants.mock.calls.map(([roomId]) => roomId)).sort()).toEqual(['r1', 'r2']);
				expect(workers.flatMap(worker => worker.liveKitService.removeParticipant.mock.calls.map(([roomId, identity]) => `${roomId} ${identity}`)).sort()).toEqual([`r1 ${rm1.uri}`, `r2 ${rm2.uri}`]);
				for (const roomId of ['r1', 'r2']) {
					expect((JSON.parse(sharedRedis.store.get(`chatVoice:${roomId}`)!) as { participants: { identity: string }[] }).participants.map(p => p.identity)).toEqual(['https://local.test/users/u1']);
				}
				for (const worker of workers) worker.service.onApplicationShutdown();
			});

			// 読めなかったものがあっても、読めたものだけで残れないと決まった参加者は外す
			test('removes a participant known to be denied even when another participant\'s policy read fails', async () => {
				startCall('r1', [u1, rm3]);
				const findUsers = f.usersRepository.findBy.getMockImplementation()!;
				f.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => (await findUsers(where)).map(user => (user.id === 'rm3' ? { ...user, isSuspended: true } : user)));
				f.roleService.getUserPolicies.mockImplementation(async (userId: string) => {
					if (userId === 'u1') throw new Error('db is down');
					return { canVoiceCall: true, canScreenShare: true, chatAvailability: 'available' };
				});

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm3.uri}`]);
			});

			test('removes a participant from a refused server even when the room and the users cannot be read', async () => {
				startCall('r1', [u1, rm1]);
				f.meta.blockedHosts = ['remote.test'];
				f.chatRoomsRepository.findOneBy.mockRejectedValue(new Error('db is down'));
				f.usersRepository.findBy.mockRejectedValue(new Error('db is down'));

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			/** 次の定期的な読み直し。ルームごとの読み直しの鍵が切れるまで時計を進める */
			async function nextSweep() {
				vi.setSystemTime(Date.now() + 60_000);
				await f.service.sweep();
			}

			test('removes a participant after three sweeps in a row could not check it', async () => {
				startCall('r1', [u1, rm1]);
				f.roleService.getUserPolicies.mockImplementation(async (userId: string) => {
					if (userId === 'u1') throw new Error('db is down');
					return { canVoiceCall: true, canScreenShare: true, chatAvailability: 'available' };
				});

				await f.service.sweep();
				await nextSweep();
				expect(removed()).toEqual([]);

				await nextSweep();
				expect(removed()).toEqual(['r1 https://local.test/users/u1']);
			});

			test('starts counting again after a check that succeeds', async () => {
				startCall('r1', [u1]);
				let failing = true;
				f.roleService.getUserPolicies.mockImplementation(async () => {
					if (failing) throw new Error('db is down');
					return { canVoiceCall: true, canScreenShare: true, chatAvailability: 'available' };
				});

				await f.service.sweep();
				await nextSweep();
				failing = false;
				await nextSweep();
				failing = true;
				await nextSweep();
				await nextSweep();

				expect(removed()).toEqual([]);
				await nextSweep();
				expect(removed()).toEqual(['r1 https://local.test/users/u1']);
			});

			test('forgets the count after a few minutes without sweeps', async () => {
				startCall('r1', [u1]);
				f.roleService.getUserPolicies.mockRejectedValue(new Error('db is down'));

				await f.service.sweep();
				await nextSweep();
				vi.setSystemTime(Date.now() + 10 * 60_000);
				await nextSweep();

				expect(removed()).toEqual([]);
			});

			test('leaves a participant it cannot check alone when the settings change, and does not count it', async () => {
				startCall('r1', [u1]);
				f.roleService.getUserPolicies.mockRejectedValue(new Error('db is down'));

				await f.service.removeRefusedRemoteParticipants();
				await f.service.removeRefusedRemoteParticipants();
				await f.service.sweep();
				await nextSweep();

				expect(removed()).toEqual([]);
			});

			// 読み直しの時刻を決めてから読んだ一覧を、残れない参加者を外すのにも、保存するのにも使う
			test('reads each active room from LiveKit once per sweep, after taking the snapshot\'s stamp', async () => {
				startCall('r1', [u1, rm1]);
				startCall('r2', [rm3]);
				f.meta.blockedHosts = ['remote.test'];

				await f.service.sweep();

				expect(f.liveKitService.listParticipants.mock.calls.map(([roomId]) => roomId).sort()).toEqual(['r1', 'r2']);
				for (const roomId of ['r1', 'r2']) {
					const stampAt = f.redis.eval.mock.calls.findIndex(([, , key]) => key === `chatVoice:localStamp:${roomId}`);
					const listAt = f.liveKitService.listParticipants.mock.calls.findIndex(([id]) => id === roomId);
					expect(f.redis.eval.mock.invocationCallOrder[stampAt]).toBeLessThan(f.liveKitService.listParticipants.mock.invocationCallOrder[listAt]);
				}
				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('leaves the participants it removed out of the stored snapshot, and keeps those it could not remove', async () => {
				startCall('r1', [u1, rm1]);
				startCall('r2', [rm2]);
				f.meta.blockedHosts = ['remote.test'];
				f.liveKitService.removeParticipant.mockImplementation(async (roomId: string) => {
					if (roomId === 'r2') throw new Error('LiveKit is down');
				});

				await f.service.sweep();

				const identitiesOf = (roomId: string) => (JSON.parse(f.redis.store.get(`chatVoice:${roomId}`)!) as { participants: { identity: string }[] }).participants.map(p => p.identity);
				expect(identitiesOf('r1')).toEqual(['https://local.test/users/u1']);
				expect(identitiesOf('r2')).toEqual([rm2.uri]);
			});

			test('decides each server once per sweep, for every room', async () => {
				startCall('r1', [u1, rm1, rm3]);
				startCall('r2', [rm2, rm3]);

				await f.service.sweep();
				expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);

				// 次の読み直し (60 秒後。ルームごとの読み直しの鍵は切れている) では、いまの記録を読み直す
				vi.setSystemTime(Date.now() + 60_000);
				await f.service.sweep();
				expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(2);
			});

			test('decides each server once when the settings change, for every room', async () => {
				startCall('r1', [u1, rm1, rm3]);
				startCall('r2', [rm2, rm3]);

				await f.service.removeRefusedRemoteParticipants();

				expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
			});

			test('removes participants whose account was suspended, whose room was archived, or whose role may no longer call or write', async () => {
				startCall('r1', [u1, rm1, rm3]);
				startCall('r2', [rm2]);
				const findUsers = f.usersRepository.findBy.getMockImplementation()!;
				f.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => (await findUsers(where)).map(user => (user.id === 'rm3' ? { ...user, isSuspended: true } : user)));
				f.roleService.getUserPolicies.mockImplementation(async (userId: string) => ({ canVoiceCall: userId !== 'u1', canScreenShare: true, chatAvailability: userId === 'rm1' ? 'readonly' : 'available' }));
				f.chatRoomsRepository.findOneBy.mockImplementation(async ({ id }: { id: string }) => ({ id, ownerId: 'owner', isArchived: id === 'r2' }));

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm3.uri}`, 'r1 https://local.test/users/u1', `r1 ${rm1.uri}`, `r2 ${rm2.uri}`].sort());
			});

			test('removes a participant whose user is gone, as when it joins', async () => {
				const ghost = { identity: 'https://remote.test/users/ghost', userId: 'ghost', screenSharing: false, micTrackSid: null };
				startCall('r1', [u1]);
				const list = f.liveKitService.listParticipants.getMockImplementation()!;
				f.liveKitService.listParticipants.mockImplementation(async (roomId: string) => [...await list(roomId), ghost]);

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${ghost.identity}`]);
			});
		});

		describe('checking who joins', () => {
			function joined(user: { id: string; host: string | null; uri: string | null }, metadata = JSON.stringify({ userId: user.id })) {
				return { event: 'participant_joined', room: { name: 'chatRoom:r1' }, participant: { identity: participant(user).identity, metadata } } as any;
			}

			test('removes a participant who joins from a server this server now refuses', async () => {
				f.meta.blockedHosts = ['remote.test'];

				f.service.handleWebhook(joined(rm1));

				await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
			});

			test('removes a participant from a server on a port of a blocked domain', async () => {
				const p = { id: 'p', host: 'remote.test:8443', uri: 'https://remote.test:8443/users/p' };
				f.usersRepository.findBy.mockResolvedValue([p] as any);
				f.meta.blockedHosts = ['remote.test'];

				await f.service.removeUnadmittedParticipant('r1', joined(p).participant);

				expect(removed()).toEqual([`r1 ${p.uri}`]);
			});

			test('removes a participant who is no longer a member of the room', async () => {
				f.nonMembers.add('rm1');
				f.nonMembers.add('u1');

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await f.service.removeUnadmittedParticipant('r1', joined(u1).participant);

				expect(removed()).toEqual(['r1 https://local.test/users/u1', `r1 ${rm1.uri}`]);
			});

			test('removes a participant whose identity is not the one of the user its token names', async () => {
				await f.service.removeUnadmittedParticipant('r1', { identity: 'https://evil.test/users/x', metadata: JSON.stringify({ userId: 'rm1' }) });
				await f.service.removeUnadmittedParticipant('r1', { identity: rm1.uri!, metadata: JSON.stringify({ userId: 'u1' }) });

				expect(removed()).toEqual(['r1 https://evil.test/users/x', `r1 ${rm1.uri}`]);
			});

			test('removes a participant whose token names no user of this server', async () => {
				// LiveKit はメタデータの無い参加者に空文字を渡す
				await f.service.removeUnadmittedParticipant('r1', joined(rm1, '').participant);
				await f.service.removeUnadmittedParticipant('r1', joined({ id: 'ghost', host: 'remote.test', uri: 'https://remote.test/users/ghost' }).participant);

				expect(removed()).toEqual(['r1 https://remote.test/users/ghost', `r1 ${rm1.uri}`]);
			});

			test('keeps members who join', async () => {
				const owner = KNOWN_USERS.find(user => user.id === 'owner')!;

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await f.service.removeUnadmittedParticipant('r1', joined(u1).participant);
				// 持ち主はメンバーの記録が無くてもメンバー
				f.nonMembers.add('owner');
				await f.service.removeUnadmittedParticipant('r1', joined(owner).participant);

				expect(removed()).toEqual([]);
			});

			test.each([false, true])('successful join admission clears an earlier sweep failure count (second check: %s)', async secondCheck => {
				const identity = participant(rm1).identity;
				f.redis.store.set(`chatVoice:unverified:r1:${identity}`, '2');
				if (secondCheck) {
					vi.useFakeTimers();
					f.roleService.getUserPolicies.mockRejectedValueOnce(new Error('db is down'));
					const checking = f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
					await vi.advanceTimersByTimeAsync(2000);
					await checking;
				} else {
					await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				}
				expect(f.redis.store.has(`chatVoice:unverified:r1:${identity}`)).toBe(false);
				expect(removed()).toEqual([]);
			});

			test('still re-reads the call after checking who joined', async () => {
				vi.useFakeTimers();
				const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();
				f.meta.blockedHosts = ['remote.test'];

				f.service.handleWebhook(joined(rm1));
				await vi.advanceTimersByTimeAsync(500);

				expect(refresh).toHaveBeenCalledWith('r1');
				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			// トークンを発行するとき (issueRemoteJoinToken、chat/rooms/voice/join) と同じものを確かめる
			test.each([
				['whose account was suspended', (fx: ReturnType<typeof createFixture>) => {
					const findUsers = fx.usersRepository.findBy.getMockImplementation()!;
					fx.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => (await findUsers(where)).map(user => ({ ...user, isSuspended: true })));
				}],
				['whose account was deleted', (fx: ReturnType<typeof createFixture>) => {
					const findUsers = fx.usersRepository.findBy.getMockImplementation()!;
					fx.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => (await findUsers(where)).map(user => ({ ...user, isDeleted: true })));
				}],
				['in an archived room', (fx: ReturnType<typeof createFixture>) => fx.chatRoomsRepository.findOneBy.mockResolvedValue({ id: 'r1', ownerId: 'owner', isArchived: true } as any)],
				['whose role may no longer join voice calls', (fx: ReturnType<typeof createFixture>) => fx.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: false, canScreenShare: true, chatAvailability: 'available' })],
				['who may only read chats', (fx: ReturnType<typeof createFixture>) => fx.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: true, canScreenShare: true, chatAvailability: 'readonly' })],
				['who may not use chats', (fx: ReturnType<typeof createFixture>) => fx.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: true, canScreenShare: true, chatAvailability: 'unavailable' })],
			])('removes a participant %s', async (_label, change) => {
				const owner = KNOWN_USERS.find(user => user.id === 'owner')!;
				change(f);

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await f.service.removeUnadmittedParticipant('r1', joined(u1).participant);
				await f.service.removeUnadmittedParticipant('r1', joined(owner).participant);

				expect(removed()).toEqual(['r1 https://local.test/users/owner', 'r1 https://local.test/users/u1', `r1 ${rm1.uri}`]);
			});

			test('checks a joining participant with one read each of the room, the user, the membership, the role policies and the server records', async () => {
				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);

				expect(f.chatRoomsRepository.findOneBy).toHaveBeenCalledTimes(1);
				expect(f.usersRepository.findBy).toHaveBeenCalledTimes(1);
				expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledTimes(1);
				expect(f.roleService.getUserPolicies.mock.calls).toEqual([['rm1']]);
				expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
				expect(removed()).toEqual([]);
			});

			// 入ったときに読むものは、すべて同時に読み始める。サーバーの記録は、参加者の identity (他のサーバーのユーザーなら uri) のホストで先に読む
			test('checks a joining participant in one parallel round of reads', async () => {
				const room = pauseNextCall(f.chatRoomsRepository.findOneBy);

				const checked = f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await room.reached;

				expect(f.usersRepository.findBy).toHaveBeenCalledTimes(1);
				expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledTimes(1);
				expect(f.roleService.getUserPolicies.mock.calls).toEqual([['rm1']]);
				expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);

				room.resume();
				await checked;

				// 読み終えた後に読み足さない
				expect(f.chatRoomsRepository.findOneBy).toHaveBeenCalledTimes(1);
				expect(f.usersRepository.findBy).toHaveBeenCalledTimes(1);
				expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledTimes(1);
				expect(f.roleService.getUserPolicies).toHaveBeenCalledTimes(1);
				expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
				expect(removed()).toEqual([]);
			});

			test('reads the server records again only for a user whose stored host differs from its identity', async () => {
				const p = { id: 'p', host: 'legacy.test', uri: 'https://remote.test/users/p' };
				const findUsers = f.usersRepository.findBy.getMockImplementation()!;
				f.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => [...await findUsers(where), p] as any);
				f.meta.blockedHosts = ['legacy.test'];

				await f.service.removeUnadmittedParticipant('r1', { identity: p.uri, metadata: JSON.stringify({ userId: 'p' }) });

				expect(removed()).toEqual([`r1 ${p.uri}`]);
			});

			test('removes a participant whose token names no user at once, without reading anything', async () => {
				f.chatRoomsRepository.findOneBy.mockRejectedValue(new Error('db is down'));
				f.usersRepository.findBy.mockRejectedValue(new Error('db is down'));

				await f.service.removeUnadmittedParticipant('r1', { identity: 'https://remote.test/users/anonymous', metadata: '' });

				expect(removed()).toEqual(['r1 https://remote.test/users/anonymous']);
				expect(f.chatRoomsRepository.findOneBy).not.toHaveBeenCalled();
				expect(f.usersRepository.findBy).not.toHaveBeenCalled();
				expect(f.chatRoomMembershipsRepository.findBy).not.toHaveBeenCalled();
			});

			test('logs a failed removal apart from a failed check', async () => {
				f.meta.blockedHosts = ['remote.test'];
				f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);

				const messages = f.logger.warn.mock.calls.map(([message]) => String(message));
				expect(messages).toEqual([`Failed to remove ${rm1.uri}, who may not stay, from the voice call in r1`]);
			});

			test('removes a participant from a refused server at once, even when the room cannot be read', async () => {
				f.meta.blockedHosts = ['remote.test'];
				f.chatRoomsRepository.findOneBy.mockRejectedValue(new Error('db is down'));

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			/** 入った参加者を確かめ、確かめ直すまで (2 秒) 時計を進める */
			async function checkJoin(fixture: Fixture, participant: { identity: string; metadata?: string }) {
				vi.useFakeTimers({ now: TEST_CLOCK });
				const checked = fixture.service.removeUnadmittedParticipant('r1', participant);
				await vi.advanceTimersByTimeAsync(1_999);
				const removedBeforeRecheck = fixture.liveKitService.removeParticipant.mock.calls.length;
				await vi.advanceTimersByTimeAsync(1);
				await checked;
				return removedBeforeRecheck;
			}

			test('checks a joining participant again two seconds after a failed read, and removes it when the second check refuses it', async () => {
				const findUsers = f.usersRepository.findBy.getMockImplementation()!;
				f.usersRepository.findBy.mockRejectedValueOnce(new Error('db is down'));
				f.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => (await findUsers(where)).map(user => ({ ...user, isSuspended: true })));

				const removedBeforeRecheck = await checkJoin(f, joined(rm1).participant);

				expect(removedBeforeRecheck).toBe(0);
				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
				expect(f.usersRepository.findBy).toHaveBeenCalledTimes(2);
			});

			test('keeps a joining participant when the second check admits it', async () => {
				f.usersRepository.findBy.mockRejectedValueOnce(new Error('db is down'));

				await checkJoin(f, joined(rm1).participant);

				expect(removed()).toEqual([]);
				expect(f.usersRepository.findBy).toHaveBeenCalledTimes(2);
			});

			test('removes a joining participant it still cannot check two seconds later', async () => {
				f.roleService.getUserPolicies.mockRejectedValue(new Error('db is down'));

				await checkJoin(f, joined(rm1).participant);

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
				expect(f.logger.warn.mock.calls.map(([message]) => String(message))).toContainEqual(expect.stringContaining('could not be checked'));
			});

			test('does not check a joining participant again after shutdown', async () => {
				f.roleService.getUserPolicies.mockRejectedValue(new Error('db is down'));
				vi.useFakeTimers({ now: TEST_CLOCK });

				void f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await vi.advanceTimersByTimeAsync(0);
				f.service.onApplicationShutdown();
				await vi.advanceTimersByTimeAsync(5_000);

				expect(removed()).toEqual([]);
				expect(f.roleService.getUserPolicies).toHaveBeenCalledTimes(1);
			});
		});
	});
});
