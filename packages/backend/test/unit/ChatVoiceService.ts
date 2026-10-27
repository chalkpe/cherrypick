/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 通話に残れるか (入ったとき・定期的な読み直し・設定の変更や停止の後) と、他のサーバーを断るかのテストは ChatVoiceService.admission.ts にある

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindOperator, IsNull } from 'typeorm';
import { Redis } from 'ioredis';
import { loadConfig } from '@/config.js';
import { KNOWN_USERS, TEST_CLOCK, createFixture, fakeRedis, localRoom, matchesWhere, mirrorRoom, pauseNextCall, remoteUser } from '../misc/chat-voice-fixture.js';

describe('ChatVoiceService', () => {
	let f: ReturnType<typeof createFixture>;

	beforeEach(() => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		f = createFixture();
	});

	afterEach(() => {
		f.service.onApplicationShutdown();
		vi.useRealTimers();
	});

	test('a worker with delayed meta events cannot store or show a host blocked in authoritative settings', async () => {
		const other = createFixture(f.redis);
		const room = mirrorRoom();
		for (const worker of [f, other]) worker.rooms.set('r1', room);
		const authoritative = { ...f.meta };
		for (const worker of [f, other]) worker.metaService.fetch.mockImplementation(async () => ({ ...authoritative }));
		try {
			await f.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK);
			authoritative.blockedHosts = ['remote.test'];
			// 消す前の現況が残っているあいだに、遅れたワーカーの一覧が共有設定で隠すことを確かめる
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(true);
			expect(await other.service.getStates({ id: 'm1' }, ['r1'])).toEqual([]);
			await f.service.clearMirrorSnapshots(true);
			expect(other.meta.blockedHosts).toEqual([]);
			expect(await other.service.isRoomVoiceVisible(room)).toBe(false);
			expect(await other.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK + 1)).toBe('disabled');
		} finally {
			other.service.onApplicationShutdown();
		}
	});

	test('captures mirror generation before an authoritative policy read that races a different worker clear', async () => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		let resume!: () => void;
		const paused = new Promise<void>(resolve => { resume = resolve; });
		f.metaService.fetch.mockImplementationOnce(async () => {
			const old = { ...f.meta };
			await paused;
			return old;
		});
		const storing = f.service.storeRemoteSnapshot(room, [], TEST_CLOCK);
		// 旧実装は共有設定を読まないため、停止点を待たずに失敗を判定できるようにする。
		for (let i = 0; i < 30; i++) await Promise.resolve();
		await f.redis.incr('chatVoice:remoteGeneration');
		resume();
		expect(await storing).toBe('disabled');
		expect(f.metaService.fetch).toHaveBeenCalledWith(true);
	});

	test('coalesces mirror fanout across workers while the first empty after active remains immediate', async () => {
		vi.useFakeTimers({ now: TEST_CLOCK });
		const other = createFixture(f.redis);
		const room = mirrorRoom();
		for (const worker of [f, other]) worker.rooms.set('r1', room);
		const people = [{ identity: 'https://local.test/users/u1', screenSharing: false }];
		const calls = () => [f, other].flatMap(worker => worker.globalEventService.publishMainStream.mock.calls).map(call => call[2]);
		try {
			await f.service.storeRemoteSnapshot(room, people, TEST_CLOCK);
			for (let i = 1; i <= 20; i++) await (i % 2 ? f : other).service.storeRemoteSnapshot(room, people, TEST_CLOCK + i);
			expect(calls()).toHaveLength(1);
			await other.service.storeRemoteSnapshot(room, [], TEST_CLOCK + 21);
			expect(calls()).toHaveLength(2);
			expect(calls()[1].participants).toEqual([]);
			await f.service.storeRemoteSnapshot(room, [], TEST_CLOCK + 22);
			await other.service.storeRemoteSnapshot(room, people, TEST_CLOCK + 23);
			expect(calls()).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(10_001);
			expect(calls()).toHaveLength(3);
			expect(calls()).toContainEqual(expect.objectContaining({ updatedAt: TEST_CLOCK + 23, participants: [expect.anything()] }));
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			other.service.onApplicationShutdown();
		}
	});

	test('reads the authoritative policy once for one stored and announced mirror snapshot, and filters participant hosts with it', async () => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		// このワーカーの設定にはまだ届いていないブロック
		f.metaService.fetch.mockImplementation(async () => ({ ...f.meta, blockedHosts: ['other.test'] }));
		expect(await f.service.storeRemoteSnapshot(room, [
			{ identity: 'https://local.test/users/u1', screenSharing: false },
			{ identity: 'https://other.test/users/x', screenSharing: false },
		], TEST_CLOCK)).toBe('stored');
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledTimes(1);
		expect(f.metaService.fetch).toHaveBeenCalledTimes(1);
		expect(f.metaService.fetch).toHaveBeenCalledWith(true);
		expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants.map((p: { userId: string }) => p.userId)).toEqual(['u1']);
	});

	test('reads the authoritative policy once for one getStates batch, and not at all for rooms owned here', async () => {
		const participants = [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }];
		for (const id of ['mr1', 'mr2']) {
			f.rooms.set(id, { ...mirrorRoom(), id });
			f.redis.store.set(`chatVoice:state:${id}`, JSON.stringify({ participants, updatedAt: TEST_CLOCK }));
		}
		f.redis.store.set('chatVoice:state:r1', JSON.stringify({ participants, updatedAt: TEST_CLOCK }));
		expect((await f.service.getStates({ id: 'm1' }, ['r1'])).map(state => state.roomId)).toEqual(['r1']);
		expect(f.metaService.fetch).not.toHaveBeenCalled();
		expect((await f.service.getStates({ id: 'm1' }, ['r1', 'mr1', 'mr2'])).map(state => state.roomId)).toEqual(['r1', 'mr1', 'mr2']);
		expect(f.metaService.fetch).toHaveBeenCalledTimes(1);
	});

	test('reads the authoritative policy once for one batch of a refused-owner clear', async () => {
		for (const id of ['mr1', 'mr2']) {
			f.rooms.set(id, { ...mirrorRoom(), id });
			f.redis.store.set(`chatVoice:state:${id}`, JSON.stringify({ participants: [], updatedAt: TEST_CLOCK }));
		}
		f.metaService.fetch.mockImplementation(async () => ({ ...f.meta, blockedHosts: ['remote.test'] }));
		await f.service.clearMirrorSnapshots(true);
		expect(f.redis.store.has('chatVoice:state:mr1')).toBe(false);
		expect(f.redis.store.has('chatVoice:state:mr2')).toBe(false);
		expect(f.metaService.fetch).toHaveBeenCalledTimes(1);
	});

	test('schedules no timer that keeps the process alive once shut down', async () => {
		vi.useFakeTimers({ now: TEST_CLOCK });
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		const people = [{ identity: 'https://local.test/users/u1', screenSharing: false }];
		await f.service.storeRemoteSnapshot(room, people, TEST_CLOCK);
		f.service.onApplicationShutdown();
		// 止めた後に終わった保存は、待たせた通知を予定しない
		expect(await f.service.storeRemoteSnapshot(room, people, TEST_CLOCK + 1)).toBe('stored');
		f.service.scheduleRefresh('r1');
		expect(vi.getTimerCount()).toBe(0);
	});

	test('keeps a quiet participant under sweep coverage after the first LiveKit read fails', async () => {
		const participant = { identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false, micTrackSid: null };
		f.liveKitService.listParticipants.mockRejectedValueOnce(new Error('transient')).mockResolvedValue([participant]);
		await expect(f.service.refresh('r1')).rejects.toThrow('transient');
		f.nonMembers.add('u1');
		await f.service.sweep();
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('r1', participant.identity);
	});

	test.each(['blocked', 'suspended', 'unreadable'])('refuses the mirror owner when %s, including cached state', async reason => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		await f.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK);
		if (reason === 'blocked') f.meta.blockedHosts = ['remote.test'];
		if (reason === 'suspended') f.instancesRepository.rows.push({ host: 'remote.test', suspensionState: 'manuallySuspended' });
		if (reason === 'unreadable') f.instancesRepository.findBy.mockRejectedValue(new Error('unavailable'));
		expect(await f.service.getStates({ id: 'm1' }, ['r1'])).toEqual([]);
		f.globalEventService.publishMainStream.mockClear();
		expect(await f.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK + 1)).toBe('disabled');
		expect(f.globalEventService.publishMainStream.mock.calls.every(call => call[2].participants.length === 0)).toBe(true);
	});

	test('an unrelated TURN meta event preserves an in-flight mirror read and its publication gate', async () => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		f.service.onModuleInit();
		await f.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK);
		const published = await f.redis.get('chatVoice:mirrorPublished:r1');
		const paused = pauseNextCall(f.userEntityService.packMany);
		const reading = f.service.getStates({ id: 'm1' }, ['r1']);
		await paused.reached;
		f.redisForSub.emit('message', 'local', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before: { ...f.meta, voiceCallCloudflareTurnKeyId: 'old' }, after: { ...f.meta, voiceCallCloudflareTurnKeyId: 'new' } } } }));
		paused.resume();
		expect(await reading).toEqual([expect.objectContaining({ participants: [expect.anything()], updatedAt: TEST_CLOCK })]);
		expect(await f.redis.get('chatVoice:mirrorPublished:r1')).toBe(published);
		expect(await f.redis.get('chatVoice:remoteGeneration')).toBeNull();
	});

	test('a policy event clears cached mirror state and invalidates late packing across unblock', async () => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		f.service.onModuleInit();
		await f.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK + 100);
		f.globalEventService.publishMainStream.mockClear();
		const paused = pauseNextCall(f.userEntityService.packMany);
		const reading = f.service.getStates({ id: 'm1' }, ['r1']);
		await paused.reached;
		const before = { ...f.meta };
		f.meta.blockedHosts = ['remote.test'];
		f.redisForSub.emit('message', 'local', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before, after: f.meta } } }));
		await vi.waitFor(() => expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', { roomId: 'r1', participants: [], updatedAt: TEST_CLOCK + 100 }));
		f.meta.blockedHosts = [];
		paused.resume();
		expect(await reading).toEqual([]);
		expect(await f.service.getStates({ id: 'm1' }, ['r1'])).toEqual([]);
	});

	test('stores the participant snapshot and announces it to the room\'s members', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: true, micTrackSid: 'TR' }]);

		await f.service.refresh('r1');

		expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([{ identity: 'i1', userId: 'u1', screenSharing: true }]);
		expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0]).sort()).toEqual(['m1', 'owner']);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('owner', 'chatRoomVoiceState', {
			roomId: 'r1',
			participants: [{ identity: 'i1', user: expect.objectContaining({ id: 'u1' }), screenSharing: true }],
			updatedAt: JSON.parse(f.redis.store.get('chatVoice:state:r1')!).updatedAt,
		});
	});

	// 空になった現況も時刻ごと残し、遅れて読み終えた古い現況で上書きされないようにする
	test('clears the snapshot when the call becomes empty', async () => {
		f.redis.store.set('chatVoice:state:r1', JSON.stringify({ participants: [{ identity: 'i1', userId: 'u1', screenSharing: false }], updatedAt: 1 }));
		f.liveKitService.listParticipants.mockResolvedValue([]);

		await f.service.refresh('r1');

		expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toEqual({ participants: [], updatedAt: TEST_CLOCK });
		expect(await f.service.getStates({ id: 'me' }, ['r1'])).toEqual([]);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('owner', 'chatRoomVoiceState', { roomId: 'r1', participants: [], updatedAt: expect.any(Number) });
	});

	test('leaves out participants whose user no longer exists', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([
			{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null },
			{ identity: 'gone', userId: 'deleted', screenSharing: false, micTrackSid: null },
		]);
		f.userEntityService.packMany.mockImplementation(async (ids: string[]) => ids.filter(id => id !== 'deleted').map(id => ({ id, username: id })));

		await f.service.refresh('r1');

		expect(f.globalEventService.publishMainStream.mock.calls[0][2].participants.map((p: { identity: string }) => p.identity)).toEqual(['i1']);
	});

	test('expires snapshots so a lost LiveKit cannot leave phantom calls', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);

		await f.service.refresh('r1');

		expect(f.redis.eval).toHaveBeenCalledWith(expect.any(String), 2, 'chatVoice:state:r1', 'chatVoice:active', expect.any(String), TEST_CLOCK, 120, 'r1', '0');
	});

	test('tracks rooms with an active call', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);
		await f.service.refresh('r1');
		expect([...f.redis.sets.get('chatVoice:active') ?? []]).toEqual(['r1']);

		// 時刻は Redis で決めるので、同じミリ秒に読み直しても後の現況として書く
		f.liveKitService.listParticipants.mockResolvedValue([]);
		await f.service.refresh('r1');
		expect([...f.redis.sets.get('chatVoice:active') ?? []]).toEqual([]);
	});

	test('logs a failed refresh with only the room and the error message', async () => {
		vi.useFakeTimers();
		f.liveKitService.listParticipants.mockRejectedValue(new Error('LiveKit is down'));

		// webhook を受けて予定した読み直しと、定期的な読み直し
		f.service.handleWebhook({ event: 'participant_left', room: { name: 'chatRoom:r1' } } as any);
		await vi.advanceTimersByTimeAsync(500);
		f.redis.sets.set('chatVoice:active', new Set(['r2']));
		await f.service.sweep();

		expect(f.logger.warn.mock.calls.filter(([message]) => String(message).startsWith('Failed to refresh'))).toEqual([
			['Failed to refresh the voice call in r1: LiveKit is down'],
			['Failed to refresh the voice call in r2: LiveKit is down'],
		]);
	});

	test('coalesces bursts of webhooks into one refresh per room', async () => {
		vi.useFakeTimers();
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();

		f.service.handleWebhook({ event: 'participant_joined', room: { name: 'chatRoom:r1' } } as any);
		f.service.handleWebhook({ event: 'track_published', room: { name: 'chatRoom:r1' } } as any);
		await vi.advanceTimersByTimeAsync(500);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith('r1');
	});

	test('ignores webhooks for rooms that are not chat rooms', async () => {
		vi.useFakeTimers();
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();

		f.service.handleWebhook({ event: 'participant_joined', room: { name: 'other:x' } } as any);
		await vi.advanceTimersByTimeAsync(500);

		expect(refresh).not.toHaveBeenCalled();
	});

	test('ignores webhook events that do not change who is in the call', async () => {
		vi.useFakeTimers();
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();

		f.service.handleWebhook({ event: 'egress_started', room: { name: 'chatRoom:r1' } } as any);
		await vi.advanceTimersByTimeAsync(500);

		expect(refresh).not.toHaveBeenCalled();
	});

	test('returns only rooms that have participants', async () => {
		f.redis.store.set('chatVoice:state:r1', JSON.stringify({ participants: [{ identity: 'i1', userId: 'u1', screenSharing: false }], updatedAt: 1 }));

		const states = await f.service.getStates({ id: 'me' }, ['r1', 'r2']);

		expect(states.map(state => state.roomId)).toEqual(['r1']);
		expect(f.userEntityService.packMany).toHaveBeenCalledWith(['u1'], { id: 'me' });
	});

	// 届く順が前後しても古い現況で上書きしないよう、受け取る側は現況の時刻を比べる
	test('tells the time of each snapshot, for rooms on this server and mirror rooms alike', async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);
		await f.service.refresh('r1');
		f.rooms.set('m1', { ...mirrorRoom(), id: 'm1' });
		await f.service.storeRemoteSnapshot({ ...mirrorRoom(), id: 'm1' }, [{ identity: 'https://local.test/users/u1', screenSharing: false }], 990_000);

		expect(f.globalEventService.publishMainStream.mock.calls.map(([, , packed]) => [packed.roomId, packed.updatedAt])).toEqual(expect.arrayContaining([['r1', 1_000_000], ['m1', 990_000]]));
		const states = await f.service.getStates({ id: 'me' }, ['r1', 'm1']);
		expect(states.map(state => [state.roomId, state.updatedAt])).toEqual([['r1', 1_000_000], ['m1', 990_000]]);
	});

	test('issues a join token for the room after making sure it exists', async () => {
		const result = await f.service.issueJoinToken({ id: 'u1', host: null, uri: null } as any, { id: 'r1' } as any, false);

		expect(f.liveKitService.ensureRoom).toHaveBeenCalledWith('r1', 51);
		expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith({ roomId: 'r1', identity: 'https://local.test/users/u1', userId: 'u1', canScreenShare: false });
		expect(result).toEqual({ url: 'https://local.test/livekit', token: 'jwt', iceServers: null });
	});

	test('hands out the TURN servers with the join token when they are configured', async () => {
		const iceServers = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
		f.cloudflareTurnService.getIceServers.mockResolvedValue(iceServers);

		const result = await f.service.issueJoinToken({ id: 'u1', host: null, uri: null } as any, { id: 'r1' } as any, false);

		expect(result).toEqual({ url: 'https://local.test/livekit', token: 'jwt', iceServers });
	});

	describe('remote members', () => {
		test('issues a join token to a remote room member and includes the current participants', async () => {
			f.redis.store.set('chatVoice:state:r1', JSON.stringify({ participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }], updatedAt: 1234 }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(f.chatRoomsRepository.findOne).toHaveBeenCalledWith({ where: { id: 'r1' }, relations: { owner: true } });
			expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalledWith({ where: { roomId: 'r1', userId: 'ru1' } });
			expect(f.liveKitService.ensureRoom).toHaveBeenCalledWith('r1', 51);
			expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith({ roomId: 'r1', identity: 'https://remote.test/users/ru1', userId: 'ru1', canScreenShare: false });
			expect(result).toEqual({
				url: 'https://local.test/livekit',
				token: 'jwt',
				iceServers: null,
				participants: [{ identity: 'https://local.test/users/u1', screenSharing: true }],
				updatedAt: 1234,
			});
		});

		test('hands this server\'s TURN servers to remote members too', async () => {
			const iceServers = [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }];
			f.cloudflareTurnService.getIceServers.mockResolvedValue(iceServers);

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toMatchObject({ token: 'jwt', iceServers });
		});

		test('refuses a room that does not exist', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'gone', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		// ルームがあるかどうかで、読んだものと、読めなかったときの結果が変わらないようにする
		test('reads the room, the membership, the server\'s records and the role policies before deciding', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'gone', false);

			expect(result).toBe('forbidden');
			expect(f.chatRoomsRepository.findOne).toHaveBeenCalledWith({ where: { id: 'gone' }, relations: { owner: true } });
			expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalledWith({ where: { roomId: 'gone', userId: 'ru1' } });
			expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
			expect(f.roleService.getUserPolicies).toHaveBeenCalledWith('ru1');
		});

		test.each([
			['the room', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomsRepository.findOne.mockRejectedValue(new Error('db is down'))],
			['the membership', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomMembershipsRepository.exists.mockRejectedValue(new Error('db is down'))],
			['the server\'s records', (fixture: ReturnType<typeof createFixture>) => fixture.instancesRepository.findBy.mockRejectedValue(new Error('db is down'))],
			['the role policies', (fixture: ReturnType<typeof createFixture>) => fixture.roleService.getUserPolicies.mockRejectedValue(new Error('db is down'))],
		])('fails the same way for a missing room and a room it has when %s cannot be read', async (_label, breakLookup) => {
			breakLookup(f);

			await expect(f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).rejects.toThrow('db is down');
			await expect(f.service.issueRemoteJoinToken(remoteUser(), 'gone', false)).rejects.toThrow('db is down');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user who is not a member', async () => {
			f.chatRoomMembershipsRepository.exists.mockResolvedValue(false);

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('allows screen sharing only when both servers allow it', async () => {
			const cases = [
				{ requested: true, hostAllows: true, expected: true },
				{ requested: true, hostAllows: false, expected: false },
				{ requested: false, hostAllows: true, expected: false },
			];
			for (const { requested, hostAllows, expected } of cases) {
				f.liveKitService.createJoinToken.mockClear();
				f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: true, canScreenShare: hostAllows, chatAvailability: 'available' });

				await f.service.issueRemoteJoinToken(remoteUser(), 'r1', requested);

				expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith(expect.objectContaining({ canScreenShare: expected }));
			}
			expect(f.roleService.getUserPolicies).toHaveBeenCalledWith('ru1');
		});

		test('refuses a room this server does not own', async () => {
			f.rooms.set('r1', localRoom({ ownerId: 'remoteOwner', owner: { id: 'remoteOwner', host: 'other.test' } }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a suspended remote user', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser({ isSuspended: true }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		// 通話に残れるか (isAdmitted) と同じく、削除されたユーザーには発行しない
		test('refuses a deleted remote user', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser({ isDeleted: true }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose role here cannot join voice calls', async () => {
			f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: false, canScreenShare: true, chatAvailability: 'available' });

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user who may not write in chats here, as for local members', async () => {
			for (const chatAvailability of ['readonly', 'unavailable']) {
				f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: true, canScreenShare: true, chatAvailability });

				const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

				expect(result, chatAvailability).toBe('forbidden');
			}
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses an archived room, as for local members', async () => {
			f.rooms.set('r1', localRoom({ isArchived: true }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		// 他のサーバーは、この時刻と後で送る現況の時刻を比べる。同じ Redis の時刻の列から決め、この時計が遅れていても前に決めた時刻より後にする
		test('reports an empty call stamped from the room\'s stamps when nothing is stored', async () => {
			vi.useFakeTimers({ now: 5000 });

			expect(await f.service.snapshotOf('r1')).toEqual({ participants: [], updatedAt: 5000 });

			await f.redis.set('chatVoice:federateDecided:r1', '7000', 'EX', 3600);
			expect(await f.service.snapshotOf('r1')).toEqual({ participants: [], updatedAt: 7001 });
			expect(await f.redis.get('chatVoice:localStamp:r1')).toBe('7001');
		});
	});

	// 通話の参加者はルームの今のメンバーにだけ知らせる。ルームのストリーム (chatRoom) は、メンバーでないモデレーターも購読でき、
	// 抜けたメンバーの購読も続くので使わない
	describe('who hears about the participants', () => {
		/** ルームのメンバーを userIds にする。メンバーの引き方 (このサーバーのユーザーだけ・userId の In) はそのまま当てる */
		function withMembers(userIds: string[]) {
			f.chatRoomMembershipsRepository.findBy.mockImplementation(async (where: Record<string, unknown> = {}) => {
				const localOnly = (where.user as { host?: unknown } | undefined)?.host instanceof FindOperator;
				const userIdIn = where.userId instanceof FindOperator ? where.userId.value as string[] : null;
				return userIds
					.filter(userId => !localOnly || KNOWN_USERS.find(user => user.id === userId)?.host == null)
					.filter(userId => userIdIn == null || userIdIn.includes(userId))
					.map(userId => ({ roomId: 'r1', userId }));
			});
		}

		const recipients = () => f.globalEventService.publishMainStream.mock.calls.map(call => call[0]).sort();

		test('refresh sends nothing to the chat room stream', async () => {
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: true, micTrackSid: null }]);
			await f.service.refresh('r1');
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');

			expect(f.globalEventService.publishMainStream).toHaveBeenCalled();
			expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
		});

		test('storeRemoteSnapshot sends nothing to the chat room stream', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: true }], 2000);
			await f.service.storeRemoteSnapshot(mirrorRoom(), [], 3000);

			expect(f.globalEventService.publishMainStream).toHaveBeenCalled();
			expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
		});

		test('refresh tells exactly the local members and the local owner', async () => {
			withMembers(['u1', 'u2', 'rm1']);
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);

			await f.service.refresh('r1');

			expect(recipients()).toEqual(['owner', 'u1', 'u2']);
		});

		test('refresh does not tell an owner on another server', async () => {
			withMembers(['u1', 'rm1']);
			f.chatRoomsRepository.findOneBy.mockResolvedValue({ id: 'r1', ownerId: 'rm3' });
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);

			await f.service.refresh('r1');

			expect(recipients()).toEqual(['u1']);
		});

		test('refresh stops telling a member who left the room', async () => {
			withMembers(['u1', 'u2']);
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);
			await f.service.refresh('r1');
			expect(recipients()).toEqual(['owner', 'u1', 'u2']);

			withMembers(['u1']);
			f.globalEventService.publishMainStream.mockClear();
			vi.setSystemTime(TEST_CLOCK + 1_000);
			await f.service.refresh('r1');

			expect(recipients()).toEqual(['owner', 'u1']);
		});

		test('storeRemoteSnapshot tells exactly the local members', async () => {
			withMembers(['u1', 'u2', 'rm1']);

			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(recipients()).toEqual(['u1', 'u2']);
		});
	});

	describe('mirror rooms', () => {
		test('storeRemoteSnapshot resolves identities to local users and ignores older snapshots', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/u1', screenSharing: true },
				{ identity: 'https://other.test/users/x', screenSharing: false },
				{ identity: 'https://gone.test/users/y', screenSharing: false },
			], 2000);

			expect(f.redis.eval).toHaveBeenCalledWith(expect.any(String), 3, 'chatVoice:state:r1', 'chatVoice:lastSeen:r1', 'chatVoice:remoteGeneration', expect.any(String), 2000, 600, 172_800, '0');
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toEqual({
				participants: [
					{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true },
					{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
				],
				updatedAt: 2000,
			});

			const stored = f.redis.store.get('chatVoice:state:r1');
			f.globalEventService.publishMainStream.mockClear();
			for (const updatedAt of [1000, 2000]) {
				await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://other.test/users/x', screenSharing: true }], updatedAt);
			}
			expect(f.redis.store.get('chatVoice:state:r1')).toBe(stored);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			await f.service.storeRemoteSnapshot(mirrorRoom(), [], 3000);
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toEqual({ participants: [], updatedAt: 3000 });
		});

		test('storeRemoteSnapshot announces to the room\'s local members, not the remote owner', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledWith({ roomId: 'r1', user: { host: IsNull() } });
			expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0])).toEqual(['m1']);
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', {
				roomId: 'r1',
				participants: [{ identity: 'https://local.test/users/u1', user: expect.objectContaining({ id: 'u1' }), screenSharing: false }],
				updatedAt: 2000,
			});
		});

		test('storeRemoteSnapshot keeps mirror rooms out of the periodic LiveKit re-read', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(f.redis.sets.get('chatVoice:active') ?? new Set()).not.toContain('r1');
			expect(f.redis.sadd).not.toHaveBeenCalled();
		});

		test('storeRemoteSnapshot looks up at most as many identities as a room can hold', async () => {
			const participants = Array.from({ length: 60 }, (_, i) => ({ identity: `https://far.test/users/${i}`, screenSharing: false }));

			await f.service.storeRemoteSnapshot(mirrorRoom(), participants, 2000);

			const lookedUp = f.usersRepository.findBy.mock.calls.flatMap(([where]) => (where.uri as FindOperator<string[]>).value);
			expect(lookedUp).toHaveLength(51);
		});

		test('storeRemoteSnapshot drops identities this server does not know, without fetching them', async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			try {
				await f.service.storeRemoteSnapshot(mirrorRoom(), [
					{ identity: 'https://other.test/users/x', screenSharing: false },
					{ identity: 'https://evil.test/users/fresh', screenSharing: false },
				], 2000);
			} finally {
				fetchSpy.mockRestore();
			}

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([
				{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
			]);
			expect(fetchSpy).not.toHaveBeenCalled();
			// 他のサーバーのユーザーは uri の完全一致で探す
			expect(f.usersRepository.findBy).toHaveBeenCalledWith({ uri: expect.any(FindOperator), isDeleted: false });
		});

		test('storeRemoteSnapshot drops a local-looking identity that is not a local user of this server', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/x1', screenSharing: false },
				{ identity: 'https://local.test/users/nobody', screenSharing: false },
				{ identity: 'https://local.test/users/u2', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([
				{ identity: 'https://local.test/users/u2', userId: 'u2', screenSharing: false },
			]);
		});

		test('storeRemoteSnapshot drops deleted users', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/deletedLocal', screenSharing: false },
				{ identity: 'https://other.test/users/deleted', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([]);
		});

		test('storeRemoteSnapshot ignores local identities that are not plain user ids', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/u1/followers', screenSharing: false },
				{ identity: 'https://local.test/users/', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([]);
			expect(f.usersRepository.findBy).not.toHaveBeenCalled();
		});

		// ホストは、このサーバーのユーザーなら誰でも参加者として送れる。このサーバーのユーザーはメンバーかどうかが分かるので、
		// メンバーでなければ外す。他のサーバーのユーザー (持ち主を含む) がメンバーかはこのサーバーでは分からないので残す
		test('storeRemoteSnapshot drops local users who are not members, keeps users of other servers, and checks local users in one query', async () => {
			f.nonMembers.add('u2');
			// 他のサーバーのユーザーの行はこのサーバーには無い
			f.nonMembers.add('x1');
			f.nonMembers.add('remoteOwner');

			const result = await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://remote.test/users/remoteOwner', screenSharing: true },
				{ identity: 'https://local.test/users/u1', screenSharing: false },
				{ identity: 'https://local.test/users/u2', screenSharing: false },
				{ identity: 'https://other.test/users/x', screenSharing: false },
			], 2000);

			expect(result).toBe('stored');
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([
				{ identity: 'https://remote.test/users/remoteOwner', userId: 'remoteOwner', screenSharing: true },
				{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false },
				{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
			]);
			const membershipChecks = f.chatRoomMembershipsRepository.findBy.mock.calls.filter(([where]) => where?.userId instanceof FindOperator);
			expect(membershipChecks).toHaveLength(1);
			expect(membershipChecks[0][0]).toEqual({ roomId: 'r1', userId: expect.any(FindOperator) });
			// このサーバーのユーザーかどうかは、送られた identity ではなく DB のユーザーで決める
			expect((membershipChecks[0][0]!.userId as FindOperator<string[]>).value).toEqual(['u1', 'u2']);
		});

		test('storeRemoteSnapshot deduplicates identities while preserving host order and first screen-sharing state', async () => {
			const identities = ['https://other.test/users/x', 'https://remote.test/users/remoteOwner', 'https://local.test/users/u1'];
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				...identities.map(identity => ({ identity, screenSharing: false })),
				{ identity: identities[0], screenSharing: true },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants.map((p: { identity: string; screenSharing: boolean }) => [p.identity, p.screenSharing])).toEqual(identities.map(identity => [identity, false]));
		});

		test.each([
			['blocked', { blockedHosts: ['OTHER.test.:8443'] }, []],
			['not allowed', { federation: 'specified', federationHosts: ['remote.test'] }, []],
			['suspended', {}, [{ host: 'other.test', suspensionState: 'manuallySuspended' }]],
			['quarantined', {}, [{ host: 'other.test', suspensionState: 'none', quarantineLimited: true }]],
		])('storeRemoteSnapshot drops participants on a %s host while preserving remote owner and local membership semantics', async (_label, meta, instances) => {
			f = createFixture(undefined, instances);
			Object.assign(f.meta, meta);
			f.nonMembers.add('u2');
			f.nonMembers.add('remoteOwner');
			f.nonMembers.add('x1');
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://other.test/users/x', screenSharing: false },
				{ identity: 'https://remote.test/users/remoteOwner', screenSharing: true },
				{ identity: 'https://local.test/users/u1', screenSharing: false },
				{ identity: 'https://local.test/users/u2', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants.map((p: { userId: string }) => p.userId)).toEqual(['remoteOwner', 'u1']);
		});

		test('storeRemoteSnapshot does not look up memberships when no user of this server is named', async () => {
			f.nonMembers.add('x1');

			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://evil.test/users/fresh', screenSharing: false },
				{ identity: 'https://other.test/users/x', screenSharing: false },
				// 他のサーバーのユーザーの id を、このサーバーのユーザーの形で名乗っても、このサーバーのユーザーにはならない
				{ identity: 'https://local.test/users/x1', screenSharing: false },
			], 2000);

			expect(f.chatRoomMembershipsRepository.findBy.mock.calls.filter(([where]) => where?.userId instanceof FindOperator)).toHaveLength(0);
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([
				{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
			]);
		});

		// 他のサーバーの言う現況を、このサーバーが持つルームに書かせない
		test.each([
			['a room owned on this server', () => localRoom()],
			['a room whose owner was not loaded', () => ({ id: 'r1', ownerId: 'remoteOwner', isArchived: false }) as any],
		])('storeRemoteSnapshot refuses %s', async (_label, room) => {
			await expect(f.service.storeRemoteSnapshot(room(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000)).rejects.toThrow();

			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});

		// 比べてから書くまでを一つの操作にして、同時に届いた古い現況が新しい現況を上書きしないようにする
		// 同時に始めた二つの保存は、始めた順に書き込みまで進む。後から書く古い現況は捨てる
		test.each([
			{ label: 'the newer one first', times: [3000, 2000], results: ['stored', 'stale'] },
			{ label: 'the older one first', times: [2000, 3000], results: ['stored', 'stored'] },
		])('storeRemoteSnapshot keeps the newer of two snapshots stored at the same time ($label)', async ({ times, results }) => {
			const identityAt = (updatedAt: number) => (updatedAt === 3000 ? 'https://local.test/users/u1' : 'https://local.test/users/u2');

			const stored = await Promise.all(times.map(updatedAt => f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: identityAt(updatedAt), screenSharing: false }], updatedAt)));

			expect(stored).toEqual(results);
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toEqual({
				participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }],
				updatedAt: 3000,
			});
		});

		test('storeRemoteSnapshot tells why it did not store a snapshot, and only announces what it stored', async () => {
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [], 2000)).toBe('stored');
			f.globalEventService.publishMainStream.mockClear();

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000)).toBe('stale');
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1000)).toBe('stale');
			// 保存した現況の寿命が切れても、最後に受け入れた時刻以前のものは捨てる
			f.redis.store.delete('chatVoice:state:r1');
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1500)).toBe('stale');
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});

		test('storeRemoteSnapshot ignores a snapshot stamped more than five minutes ahead of this server\'s clock', async () => {
			vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1_000_000 + 300_001)).toBe('ahead');
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			// ちょうど五分先までは時計のずれとして受け入れる
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1_000_000 + 300_000)).toBe('stored');
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).updatedAt).toBe(1_000_000 + 300_000);
		});

		// 最後に受け入れた時刻を覚えておく 2 日が過ぎた後に、それより前の現況が届いても書かない。
		// ホストの時計は 5 分まで進んでいてよいので、その分を引いた古さを境にする (inbox と、参加したときの応答のどちらもここを通る)
		test('storeRemoteSnapshot ignores an empty snapshot older than two days minus five minutes', async () => {
			const now = 1_000_000_000;
			const maxAge = 172_800_000 - 300_000;
			vi.useFakeTimers({ now, toFake: ['Date'] });

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [], now - maxAge - 1)).toBe('old');
			expect(f.redis.eval).not.toHaveBeenCalled();
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [], now - maxAge)).toBe('stored');
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).updatedAt).toBe(now - maxAge);
		});

		// 参加者のいる現況は、ミラーでの寿命 (10 分) を過ぎていれば表示しないので、それにホストの時計のずれ (5 分) を足した古さを境にする
		test('storeRemoteSnapshot ignores a snapshot with participants older than ten minutes plus five minutes', async () => {
			const now = 1_000_000_000;
			const maxAge = 600_000 + 300_000;
			vi.useFakeTimers({ now, toFake: ['Date'] });
			const participants = [{ identity: 'https://local.test/users/u1', screenSharing: false }];

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), participants, now - maxAge - 1)).toBe('old');
			expect(f.redis.eval).not.toHaveBeenCalled();
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), participants, now - maxAge)).toBe('stored');
			// 同じ古さでも、空の現況 (通話の終わり) は受け入れる
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [], now - maxAge + 1)).toBe('stored');
		});

		// 他のサーバーの通話を止めた後で、止める前に始まった参加の応答が届いても保存しない
		test.each([
			['remote calls are turned off', { enableRemoteVoiceCall: false }],
			['federation is turned off', { federation: 'none' }],
		])('storeRemoteSnapshot stores nothing once %s', async (_label, changes) => {
			Object.assign(f.meta, changes);

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000)).toBe('disabled');
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});
	});

	// 他のサーバーの通話を止めたら、ミラーの現況を寿命 (10 分) まで残さず消す
	describe('clearing mirror snapshots when calls on other servers are turned off', () => {
		function publishMetaUpdated(changes: Record<string, unknown>, options: { withoutBefore?: boolean } = {}) {
			const before = { ...f.meta };
			Object.assign(f.meta, changes);
			const body = options.withoutBefore ? { after: { ...f.meta } } : { before, after: { ...f.meta } };
			f.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body } }));
		}

		test('deletes the stored snapshot of every mirror room, and nothing else', async () => {
			// 一度に引くより多くのミラー
			for (let i = 0; i < 1200; i++) {
				const id = `m${String(i).padStart(4, '0')}`;
				f.rooms.set(id, { ...mirrorRoom(), id });
				f.redis.store.set(`chatVoice:state:${id}`, JSON.stringify({ participants: [], updatedAt: 1 }));
			}
			f.redis.store.set('chatVoice:state:r1', JSON.stringify({ participants: [], updatedAt: 1 }));
			f.redis.store.set('chatVoice:federated:r1', '{}');

			await f.service.clearMirrorSnapshots();

			// 残るのは、このサーバーのルームの現況と、ほかの記録と、止めた回数 (世代) だけ
			expect([...f.redis.store.keys()].sort()).toEqual(['chatVoice:federated:r1', 'chatVoice:remoteGeneration', 'chatVoice:state:r1']);
			expect(f.chatRoomsRepository.find.mock.calls.length).toBeGreaterThan(1);
			// 何度消しても同じ (ほかのワーカーも同じように消す)
			await expect(f.service.clearMirrorSnapshots()).resolves.toBeUndefined();
		});

		test.each([
			['remote calls are turned off', { enableRemoteVoiceCall: false }],
			['federation is turned off', { federation: 'none' }],
		])('clears the mirror snapshots when %s', async (_label, changes) => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);

			await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
		});

		test('clears the mirror snapshots when the previous settings are unknown and remote calls are off', async () => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated({ enableRemoteVoiceCall: false }, { withoutBefore: true });

			await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
		});

		test.each([
			['the server name changes', { name: 'renamed' }],
		])('does not clear the mirror snapshots when only %s', async (_label, changes) => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);
			// 後から届いた変更でだけ消したことを確かめる
			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(clear).toHaveBeenCalled());
			expect(clear).toHaveBeenCalledTimes(1);
		});

		test('does not clear anything while remote calls stay off or are turned on', async () => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.meta.enableRemoteVoiceCall = false;
			f.service.onModuleInit();

			publishMetaUpdated({ name: 'renamed' });
			publishMetaUpdated({ enableRemoteVoiceCall: true });
			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(clear).toHaveBeenCalled());
			expect(clear).toHaveBeenCalledTimes(1);
		});

		// 戻したときは新しい消去を始めないので、止めたときの消去を途中でやめない。消したルームには空の状態を知らせる
		test('a clear started by turning remote calls off finishes and announces every deleted room when they are turned back on midway', async () => {
			const participants = [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }];
			for (const id of ['mr1', 'mr2']) {
				f.rooms.set(id, { ...mirrorRoom(), id });
				f.redis.store.set(`chatVoice:state:${id}`, JSON.stringify({ participants, updatedAt: TEST_CLOCK }));
			}
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots');
			f.service.onModuleInit();
			// 最初のルームを消す (CAS) 直前で止め、そのあいだに戻す
			const paused = pauseNextCall(f.redis.eval);
			publishMetaUpdated({ enableRemoteVoiceCall: false });
			await paused.reached;
			publishMetaUpdated({ enableRemoteVoiceCall: true });
			paused.resume();
			expect(clear).toHaveBeenCalledTimes(1);
			await clear.mock.results[0].value;

			expect(f.redis.store.has('chatVoice:state:mr1')).toBe(false);
			expect(f.redis.store.has('chatVoice:state:mr2')).toBe(false);
			expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[2])).toEqual([
				{ roomId: 'mr1', participants: [], updatedAt: TEST_CLOCK },
				{ roomId: 'mr2', participants: [], updatedAt: TEST_CLOCK },
			]);
		});

		// ミラーの現況は、このサーバーに LiveKit が無くても保存される
		test('clears the mirror snapshots on a server without its own LiveKit', async () => {
			f.liveKitService.isEnabled = false;
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			const recheck = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });
			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(2));
			// 確かめ直す通話が無いので、参加者の確かめ直しはしない
			expect(recheck).not.toHaveBeenCalled();
		});

		// 止めた後は、どのワーカーで始まった保存も書けないようにする (書き込みのスクリプトが、始めたときの値と比べる)
		test('changes the remote voice generation before deleting the mirror snapshots', async () => {
			f.rooms.set('m1', { ...mirrorRoom(), id: 'm1' });
			f.redis.store.set('chatVoice:state:m1', JSON.stringify({ participants: [], updatedAt: 1 }));

			await f.service.clearMirrorSnapshots();
			// 最初の消去の世代の更新と、同じ消去の CAS の順番を比べる
			expect(f.redis.incr).toHaveBeenCalledTimes(1);
			expect(f.redis.eval).toHaveBeenCalledTimes(1);
			expect(f.redis.eval.mock.calls[0][0]).toMatch(/^-- CLEAR_MIRROR_IF_CURRENT/);
			expect(f.redis.incr.mock.invocationCallOrder[0]).toBeLessThan(f.redis.eval.mock.invocationCallOrder[0]);
			expect(f.redis.store.has('chatVoice:state:m1')).toBe(false);
			await f.service.clearMirrorSnapshots();

			expect(f.redis.store.get('chatVoice:remoteGeneration')).toBe('2');
		});

		describe('turning remote calls off while a snapshot is being stored', () => {
			const u1 = [{ identity: 'https://local.test/users/u1', screenSharing: false }];

			/** Redis を共有する二つのワーカー。b が先に設定の変更を受け取り、ミラーの現況を消す */
			function workers() {
				const redis = fakeRedis();
				const a = createFixture(redis);
				const b = createFixture(redis);
				b.rooms.set('r1', mirrorRoom());
				return { redis, a, b };
			}

			// 書き込み (EVAL) が届くのが遅れ、その前に別のワーカーが現況を消した
			test('refuses a write that reaches Redis after another worker cleared the mirror snapshots', async () => {
				const { redis, a, b } = workers();
				const evalPaused = pauseNextCall(redis.eval);

				const storing = a.service.storeRemoteSnapshot(mirrorRoom(), u1, 2000);
				await evalPaused.reached;
				b.meta.enableRemoteVoiceCall = false;
				await b.service.clearMirrorSnapshots();
				evalPaused.resume();

				expect(await storing).toBe('disabled');
				expect(redis.store.has('chatVoice:state:r1')).toBe(false);
				expect(a.globalEventService.publishMainStream).not.toHaveBeenCalled();
			});

			// 書いた後、知らせる前 (pack) で止まっている間に、同じワーカーで止められて現況が消された
			test('does not announce a snapshot whose packing was paused while remote calls were turned off', async () => {
				f.rooms.set('r1', mirrorRoom());
				f.service.onModuleInit();
				const packPaused = pauseNextCall(f.userEntityService.packMany);

				const storing = f.service.storeRemoteSnapshot(mirrorRoom(), u1, 2000);
				await packPaused.reached;
				expect(f.redis.store.has('chatVoice:state:r1')).toBe(true);
				publishMetaUpdated({ enableRemoteVoiceCall: false });
				await vi.waitFor(() => expect(f.redis.store.has('chatVoice:state:r1')).toBe(false));
				packPaused.resume();

				expect(await storing).toBe('disabled');
				expect(f.globalEventService.publishMainStream.mock.calls.every(call => call[2].participants.length === 0)).toBe(true);
			});

			// 同じく止まっている間に、設定の変更をまだ受け取っていないワーカーで、別のワーカーが現況を消した
			test('does not announce a snapshot whose packing was paused while another worker cleared the mirror snapshots', async () => {
				const { redis, a, b } = workers();
				const packPaused = pauseNextCall(a.userEntityService.packMany);

				const storing = a.service.storeRemoteSnapshot(mirrorRoom(), u1, 2000);
				await packPaused.reached;
				b.meta.enableRemoteVoiceCall = false;
				await b.service.clearMirrorSnapshots();
				packPaused.resume();

				expect(await storing).toBe('disabled');
				expect(a.globalEventService.publishMainStream).not.toHaveBeenCalled();
				expect(redis.store.has('chatVoice:state:r1')).toBe(false);
			});
		});

		test('logs a failed clear', async () => {
			vi.spyOn(f.service, 'clearMirrorSnapshots').mockRejectedValue(new Error('db is down'));
			f.service.onModuleInit();

			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
		});
	});

	describe('federating the participants', () => {
		const ROOM_URI = 'https://local.test/chat/rooms/r1';
		const u1 = { identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false, micTrackSid: null };

		function withRemoteMembers(fixture = f) {
			fixture.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'u1' }, { userId: 'rm1' }, { userId: 'rm2' }, { userId: 'rm3' }]);
		}

		/** 共有 inbox を持たない、別々のサーバーの count 人のメンバー */
		function withManyRemoteMembers(count: number) {
			const members = Array.from({ length: count }, (_, i) => ({
				id: `many${i}`,
				host: `s${i}.test`,
				uri: `https://s${i}.test/users/many${i}`,
				isDeleted: false,
				inbox: `https://s${i}.test/users/many${i}/inbox`,
				sharedInbox: null,
			}));
			f.chatRoomMembershipsRepository.findBy.mockResolvedValue(members.map(member => ({ userId: member.id })));
			f.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => [...KNOWN_USERS, ...members].filter(user => matchesWhere(user, where)));
		}

		function deliveredObjects(fixture = f) {
			return fixture.queueService.deliver.mock.calls.map(([, activity]) => activity.object);
		}

		/** inbox ごとの、送った時刻と参加者 */
		function recordDeliveries() {
			const sent = new Map<string, { at: number; participants: unknown[] }[]>();
			f.queueService.deliver.mockImplementation((_user: unknown, activity: { object: { participants: unknown[] } }, to: string) => {
				if (!sent.has(to)) sent.set(to, []);
				sent.get(to)!.push({ at: Date.now(), participants: activity.object.participants });
			});
			return sent;
		}

		/** 参加者の現況を変えて webhook を受ける (LiveKit からは 600 ミリ秒ごとに届く) */
		async function changeEvery600ms(states: (typeof u1)[][], event: string) {
			for (const participants of states) {
				f.liveKitService.listParticipants.mockResolvedValue(participants);
				f.service.handleWebhook({ event, room: { name: 'chatRoom:r1' } } as any);
				await vi.advanceTimersByTimeAsync(600);
			}
		}

		test('delivers one Update per remote server, from the room owner', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: Date.parse('2026-10-27T00:00:00.000Z'), toFake: ['Date'] });
			f.liveKitService.listParticipants.mockResolvedValue([{ ...u1, screenSharing: true }]);

			await f.service.refresh('r1');

			// 読み直し (refresh) が、このサーバーの現況に 0 ミリ秒の時刻を使ったので、送るかを決めた時刻はその 1 ミリ秒後になる
			expect(f.queueService.deliver.mock.calls.map(([, , to, isSharedInbox]) => [to, isSharedInbox]).sort()).toEqual([
				['https://far.test/users/rm3/inbox', false],
				['https://remote.test/inbox', true],
			]);
			for (const [user, activity] of f.queueService.deliver.mock.calls) {
				expect(user).toEqual(expect.objectContaining({ id: 'owner', host: null }));
				expect(activity).toEqual(expect.objectContaining({
					'@context': expect.arrayContaining([expect.objectContaining({ ChatRoomVoiceState: 'cherrypick:ChatRoomVoiceState' })]),
					type: 'Update',
					actor: 'https://local.test/users/owner',
					object: {
						id: `${ROOM_URI}/voice`,
						type: 'ChatRoomVoiceState',
						room: ROOM_URI,
						participants: [{ id: 'https://local.test/users/u1', screenSharing: true }],
						updated: '2026-10-27T00:00:00.001Z',
					},
				}));
				// 通話の参加者はルームのメンバーにだけ知らせるもので、公開の情報ではない
				expect(activity.to).toBeUndefined();
			}
		});

		test('delivers nothing when every member is local', async () => {
			f.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('delivers nothing for a room owned on another server', async () => {
			withRemoteMembers();
			f.chatRoomsRepository.findOneBy.mockResolvedValue({ id: 'r1', ownerId: 'x1' });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		// 他のサーバーのメンバーがいないルームでは、送る間隔の鍵も送った記録も使わず、読み直しも予定しない。このサーバーのメンバーには今までどおり知らせる
		test('takes no federation budget and schedules nothing for a room without members on other servers', async () => {
			f.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
			vi.useFakeTimers({ now: 1_000_000 });

			for (const participants of [[u1], [{ ...u1, screenSharing: true }], [u1], []]) {
				f.liveKitService.listParticipants.mockResolvedValue(participants);
				await f.service.refresh('r1');
				vi.setSystemTime(Date.now() + 1_000);
			}

			// 残っているのは、このサーバーの (空になった) 現況と、その時刻の列だけ
			expect([...f.redis.store.keys()].sort()).toEqual(['chatVoice:localStamp:r1', 'chatVoice:state:r1']);
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
			expect(f.queueService.deliver).not.toHaveBeenCalled();
			expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0]).sort()).toEqual(['owner', 'owner', 'owner', 'owner', 'u1', 'u1', 'u1', 'u1', 'u2', 'u2', 'u2', 'u2']);
		});

		test('rechecks current members immediately before enqueueing federation', async () => {
			withRemoteMembers();
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
			expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledTimes(2);
			expect(f.usersRepository.findBy).toHaveBeenCalledTimes(2);
		});

		test('records what was sent only after every delivery is queued', async () => {
			withRemoteMembers();
			let queueAll!: () => void;
			const queued = new Promise<void>(resolve => {
				queueAll = resolve;
			});
			f.queueService.deliver.mockImplementation(() => queued);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			const refreshing = f.service.refresh('r1');
			await vi.waitFor(() => expect(f.queueService.deliver).toHaveBeenCalledTimes(2));
			expect(f.redis.store.has('chatVoice:federated:r1')).toBe(false);

			queueAll();
			await refreshing;
			expect(f.redis.store.has('chatVoice:federated:r1')).toBe(true);
		});

		test('resends at the next normal decision after returning a newer empty join snapshot', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await f.service.refresh('r1');
			const earlier = deliveredObjects().at(-1)!;
			// 保存した現況の寿命が切れているが、同じ参加者を送った記録はまだある。
			await f.redis.del('chatVoice:state:r1');
			const emptyJoin = await f.service.snapshotOf('r1');
			expect(emptyJoin.updatedAt).toBeGreaterThan(Date.parse(earlier.updated));
			expect(emptyJoin.participants).toEqual([]);
			await vi.advanceTimersByTimeAsync(10_001);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(4);
			expect(Date.parse(deliveredObjects().at(-1)!.updated)).toBeGreaterThan(emptyJoin.updatedAt);
		});

		// 空の join 応答より古い配送の記録は無効にし、接続も参加者の変化も無くても送り直す。
		test('rejects a delayed pre-join decision and recovers unchanged without a connecting client', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			f.queueService.deliver.mockResolvedValue(undefined);
			const paused = pauseNextCall(f.queueService.deliver);
			const refreshing = f.service.refresh('r1');
			await paused.reached;
			await f.redis.del('chatVoice:state:r1');
			const emptyJoin = await f.service.snapshotOf('r1');
			const remote = createFixture();
			try {
				expect(await remote.service.storeRemoteSnapshot(mirrorRoom(), emptyJoin.participants, emptyJoin.updatedAt)).toBe('stored');
				paused.resume();
				await refreshing;
				const oldDecision = deliveredObjects()[0];
				const oldUpdatedAt = Date.parse(oldDecision.updated);
				expect(oldUpdatedAt).toBeLessThan(emptyJoin.updatedAt);
				expect(await remote.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: u1.identity, screenSharing: false }], oldUpdatedAt)).toBe('stale');
				expect(await f.redis.get('chatVoice:federated:r1')).toBeNull();
				await vi.advanceTimersByTimeAsync(10_001);
				const fresh = deliveredObjects().at(-1)!;
				expect(f.queueService.deliver).toHaveBeenCalledTimes(4);
				expect(Date.parse(fresh.updated)).toBeGreaterThan(emptyJoin.updatedAt);
				expect(await remote.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: u1.identity, screenSharing: false }], Date.parse(fresh.updated))).toBe('stored');
			} finally {
				paused.resume();
				remote.service.onApplicationShutdown();
			}
		});

		test('keeps the federation record when handing out an existing snapshot', async () => {
			withRemoteMembers();
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await f.service.refresh('r1');
			const record = await f.redis.get('chatVoice:federated:r1');
			expect(record).not.toBeNull();
			await f.service.snapshotOf('r1');
			expect(await f.redis.get('chatVoice:federated:r1')).toBe(record);
		});

		test('does not record what could not be queued, and sends it again later', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.queueService.deliver.mockImplementationOnce(() => {
				const failed = Promise.reject(new Error('queue is down'));
				failed.catch(() => {});
				return failed;
			});
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await expect(f.service.refresh('r1')).rejects.toThrow('queue is down');
			expect(f.redis.store.has('chatVoice:federated:r1')).toBe(false);

			// ほかに読み直すきっかけが無くても、間隔の鍵が切れた後に読み直して送り直す
			f.queueService.deliver.mockClear();
			await vi.advanceTimersByTimeAsync(10_001);
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
			expect(f.redis.store.has('chatVoice:federated:r1')).toBe(true);
		});

		test.each([false, true])('stops delivery-failure followups after 600 seconds even with intermittent LiveKit failures (%s)', async intermittent => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.queueService.deliver.mockRejectedValue(new Error('queue is down'));
			let reads = 0;
			f.liveKitService.listParticipants.mockImplementation(async () => {
				reads++;
				if (intermittent && reads % 3 === 0) throw new Error('LiveKit is down');
				return [u1];
			});
			await expect(f.service.refresh('r1')).rejects.toThrow('queue is down');
			await vi.advanceTimersByTimeAsync(620_000);
			const attempts = f.queueService.deliver.mock.calls.length;
			expect(attempts).toBeGreaterThan(2);
			expect(vi.getTimerCount()).toBe(0);
			expect(f.logger.warn).toHaveBeenCalledWith('Gave up sending the voice call in r1 to other servers after failing for 600 seconds');
			await vi.advanceTimersByTimeAsync(600_000);
			expect(f.queueService.deliver).toHaveBeenCalledTimes(attempts);
		});

		// 一部のサーバーにだけ積めたときは、相手に届いている現況が分からない。前に送った終わりの記録で、次の終わりを送らずに済ませない
		test('still sends the end of a call after sending the participants failed for one server', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			const sent = recordDeliveries();
			const record = f.queueService.deliver.getMockImplementation()!;
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(30_000);

			f.queueService.deliver.mockImplementationOnce((...args: Parameters<typeof record>) => {
				record(...args);
				const failed = Promise.reject(new Error('queue is down'));
				failed.catch(() => {});
				return failed;
			});
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await expect(f.service.refresh('r1')).rejects.toThrow('queue is down');

			f.liveKitService.listParticipants.mockResolvedValue([]);
			await vi.advanceTimersByTimeAsync(1_000);
			await f.service.refresh('r1');

			expect(sent.size).toBe(2);
			for (const deliveries of sent.values()) {
				expect(deliveries.at(-1)!.participants).toEqual([]);
			}
		});

		test('does not record anything when the members cannot be read', async () => {
			withRemoteMembers();
			f.usersRepository.findBy.mockRejectedValueOnce(new Error('db is down'));
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await expect(f.service.refresh('r1')).rejects.toThrow('db is down');
			expect(f.queueService.deliver).not.toHaveBeenCalled();
			expect(f.redis.store.has('chatVoice:federated:r1')).toBe(false);

			// 送る間隔も使っていないので、読めるようになれば待たずに送る
			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
		});

		test('does not resend an unchanged snapshot within 240 seconds', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);

			f.queueService.deliver.mockClear();
			vi.setSystemTime(1_000_000 + 239_000);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).not.toHaveBeenCalled();

			vi.setSystemTime(1_000_000 + 240_000);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);

			// 前に送ってから 10 秒を過ぎていれば、参加者の変化は間を置かずに送る (10 秒ちょうどでは、間隔の鍵がまだ残っている)
			f.queueService.deliver.mockClear();
			vi.setSystemTime(1_000_000 + 250_001);
			f.liveKitService.listParticipants.mockResolvedValue([{ ...u1, screenSharing: true }]);
			await f.service.refresh('r1');
			expect(deliveredObjects().map(object => object.participants)).toEqual([
				[{ id: 'https://local.test/users/u1', screenSharing: true }],
				[{ id: 'https://local.test/users/u1', screenSharing: true }],
			]);
		});

		test('always sends the empty snapshot that ends a call', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await f.service.refresh('r1');
			f.queueService.deliver.mockClear();

			// 参加者を送ったばかりでも、通話の終わりは待たずに送る
			vi.setSystemTime(1_001_000);
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');

			expect(deliveredObjects().map(object => object.participants)).toEqual([[], []]);
		});

		test('sends the end of a call only once while the call stays over', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([]);

			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);

			// 同じ終わりを読み直しても (続けて届いた webhook、間隔が空いた後の読み直し)、送った記録があるうちは送り直さない
			await vi.advanceTimersByTimeAsync(5_000);
			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(30_000);
			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(30_000);

			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
		});

		test('does not hold back the next end of a call after skipping a repeated one', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(30_000);
			// 送らなかった終わりは、送る間隔を使わない
			await f.service.refresh('r1');

			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await vi.advanceTimersByTimeAsync(1_000);
			await f.service.refresh('r1');
			f.queueService.deliver.mockClear();
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await vi.advanceTimersByTimeAsync(1_000);
			await f.service.refresh('r1');

			expect(deliveredObjects().map(object => object.participants)).toEqual([[], []]);
		});

		// 終わりを送るのを待たせた後で、ほかのワーカーがそれより前に読んだ参加者のいる現況を送っても、終わりを送る
		test('sends a held-back end of a call even when another worker sends an older state afterwards', async () => {
			const sharedRedis = fakeRedis();
			const workerA = createFixture(sharedRedis);
			const workerB = createFixture(sharedRedis);
			withRemoteMembers(workerA);
			withRemoteMembers(workerB);
			vi.useFakeTimers({ now: 1_000_000 });
			const sent: unknown[] = [];
			for (const worker of [workerA, workerB]) {
				worker.queueService.deliver.mockImplementation((_user: unknown, activity: { object: { participants: unknown[] } }) => {
					sent.push(activity.object.participants);
				});
			}

			try {
				workerA.liveKitService.listParticipants.mockResolvedValue([]);
				await workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(1_000);
				// 終わりを送ったばかりなので、この終わりは待たせる
				await workerA.service.refresh('r1');

				workerB.liveKitService.listParticipants.mockResolvedValue([u1]);
				await vi.advanceTimersByTimeAsync(1_000);
				await workerB.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(20_000);

				expect(sent.at(-1)).toEqual([]);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		/**
		 * 同じ LiveKit を読む二つのワーカー (A と B) と、remote.test の共有 inbox に届いた現況をミラーとして保存する他のサーバー (remote)。
		 * live.state が LiveKit のいまの参加者。stallNextRead(w) は、w が次に LiveKit を読むときに、その時点の参加者を読んだまま止め、
		 * resume() まで返さない。failNextRead(w) は、w が次に LiveKit を読むときに失敗させる
		 */
		function sharedLiveKit() {
			const sharedRedis = fakeRedis();
			const A = createFixture(sharedRedis);
			const B = createFixture(sharedRedis);
			withRemoteMembers(A);
			withRemoteMembers(B);
			const remote = createFixture(fakeRedis());
			const live = { state: [] as (typeof u1)[] };
			const faults = new Map<unknown, { kind: 'stall'; resumed: Promise<void>; reached: () => void } | { kind: 'fail' }>();
			const sent: { by: 'A' | 'B'; updatedAt: number; n: number }[] = [];
			for (const [name, w] of [['A', A], ['B', B]] as const) {
				w.liveKitService.listParticipants.mockImplementation(async () => {
					const snapshot = [...live.state];
					const fault = faults.get(w);
					faults.delete(w);
					if (fault?.kind === 'fail') throw new Error('LiveKit is down');
					if (fault?.kind === 'stall') {
						fault.reached();
						await fault.resumed;
					}
					return snapshot;
				});
				w.queueService.deliver.mockImplementation(async (_user: unknown, activity: { object: { participants: { id: string; screenSharing: boolean }[]; updated: string } }, to: string) => {
					if (to !== 'https://remote.test/inbox') return;
					const updatedAt = Date.parse(activity.object.updated);
					sent.push({ by: name, updatedAt, n: activity.object.participants.length });
					await remote.service.storeRemoteSnapshot(mirrorRoom(), activity.object.participants.map(p => ({ identity: p.id, screenSharing: p.screenSharing })), updatedAt);
				});
			}
			return {
				A, B, remote, live, sent, sharedRedis,
				stallNextRead(w: unknown) {
					let resume!: () => void;
					const resumed = new Promise<void>(resolve => {
						resume = resolve;
					});
					let markReached!: () => void;
					const reached = new Promise<void>(resolve => {
						markReached = resolve;
					});
					faults.set(w, { kind: 'stall', resumed, reached: markReached });
					return { reached, resume };
				},
				failNextRead(w: unknown) {
					faults.set(w, { kind: 'fail' });
				},
				/** remote に保存されているミラーの参加者の数。保存されていなければ null */
				remoteParticipants() {
					const raw = remote.redis.store.get('chatVoice:state:r1');
					return raw == null ? null : (JSON.parse(raw) as { participants: unknown[] }).participants.length;
				},
				shutdown() {
					A.service.onApplicationShutdown();
					B.service.onApplicationShutdown();
				},
			};
		}

		// S2: A が参加者を、B が通話の終わりを、同じミリ秒の時刻で決めた。受け取る側は時刻の新しいものしか受け入れないので、終わりの時刻を後にする
		test('delivers the end of a call decided in the same millisecond as the participants', async () => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				s.live.state = [u1];
				await s.A.service.refresh('r1');
				s.live.state = [];
				await s.B.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(120_000);

				expect(s.sent.map(x => x.n)).toEqual([1, 0]);
				expect(s.sent[1].updatedAt).toBeGreaterThan(s.sent[0].updatedAt);
				expect(s.remoteParticipants()).toBe(0);
			} finally {
				s.shutdown();
			}
		});

		// S2b: B の時計は 1.5 秒遅れている。後で決めた終わりの時刻を、前の決定より後にする
		test('delivers the end of a call decided by a worker whose clock is behind', async () => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_001_500 });

			try {
				s.live.state = [u1];
				await s.A.service.refresh('r1');
				vi.setSystemTime(1_000_000);
				s.live.state = [];
				await s.B.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(5_000);

				expect(s.sent.at(-1)).toMatchObject({ by: 'B', n: 0 });
				expect(s.remoteParticipants()).toBe(0);
			} finally {
				s.shutdown();
			}
		});

		// S4: B の時計は 2 分遅れている。時計が追いつくのを待たず、前の決定より後の時刻ですぐに決める (決めるのに読む LiveKit は一度)
		test('decides at once on a worker whose clock is two minutes behind, stamped after the last decision', async () => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_120_250 });

			try {
				s.live.state = [u1];
				await s.A.service.refresh('r1');
				vi.setSystemTime(1_000_000);
				s.live.state = [];
				s.B.liveKitService.listParticipants.mockClear();

				await s.B.service.refresh('r1');

				// A の現況が 1_120_250、A の決定が 1_120_251、B の現況が 1_120_252 で、B の決定はその次
				expect(s.sent.at(-1)).toMatchObject({ by: 'B', n: 0, updatedAt: 1_120_253 });
				expect(s.remoteParticipants()).toBe(0);
				// 読み直し (refresh) の一度と、決めるときの一度
				expect(s.B.liveKitService.listParticipants).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(125_000);
				expect(s.B.liveKitService.listParticipants).toHaveBeenCalledTimes(2);
			} finally {
				s.shutdown();
			}
		});

		// S5: 読み直し (refresh) がルームを通話中の一覧から外した直後に、順番の鍵を取って LiveKit を読むのに失敗した。
		// 定期的な読み直しはもうこのルームを見ないので、間隔を延ばしながら決め直し、LiveKit が答えるようになったら終わりを送る
		test('sends the end of a call once LiveKit answers again after the read under the room lock failed', async () => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				s.live.state = [u1];
				await s.A.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(11_000);

				s.live.state = [];
				// 読み直しの一度目は答え、決めるときの二度目に失敗する
				const read = s.A.liveKitService.listParticipants.getMockImplementation()!;
				s.A.liveKitService.listParticipants.mockImplementationOnce(read);
				s.A.liveKitService.listParticipants.mockImplementationOnce(async () => {
					throw new Error('LiveKit is down');
				});
				await expect(s.A.service.refresh('r1')).rejects.toThrow('LiveKit is down');
				expect([...(s.sharedRedis.sets.get('chatVoice:active') ?? [])]).toEqual([]);

				await vi.advanceTimersByTimeAsync(5_000);
				expect(s.sent.at(-1)).toMatchObject({ n: 0 });
				expect(s.remoteParticipants()).toBe(0);
			} finally {
				s.shutdown();
			}
		});

		// P1 の順番: A が LiveKit から参加者を読んだまま止まっているあいだに、通話が終わり、B が終わりを保存して知らせた。
		// A は止まる前に読んだ古い現況で、このサーバーの現況を上書きせず、通話中の一覧にも戻さず、メンバーにも知らせない
		test('does not let an older read overwrite the local snapshot of a newer one', async () => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				s.live.state = [u1];
				const paused = s.stallNextRead(s.A);
				const aRefresh = s.A.service.refresh('r1');
				await paused.reached;
				await vi.advanceTimersByTimeAsync(1_000);

				s.live.state = [];
				await s.B.service.refresh('r1');
				s.A.globalEventService.publishMainStream.mockClear();
				paused.resume();
				await aRefresh;

				expect(JSON.parse((await s.sharedRedis.get('chatVoice:state:r1'))!)).toMatchObject({ participants: [] });
				expect([...(s.sharedRedis.sets.get('chatVoice:active') ?? [])]).toEqual([]);
				expect(s.A.globalEventService.publishMainStream).not.toHaveBeenCalled();
			} finally {
				s.shutdown();
			}
		});

		/** このサーバーの現況が u1 の参加を示し、通話中のルームの一覧にあり、メンバーに通話が見えている */
		async function expectLocalCall(s: ReturnType<typeof sharedLiveKit>) {
			expect(JSON.parse((await s.sharedRedis.get('chatVoice:state:r1'))!)).toMatchObject({ participants: [{ identity: u1.identity }] });
			expect([...(s.sharedRedis.sets.get('chatVoice:active') ?? [])]).toEqual(['r1']);
			expect(await s.A.service.getStates({ id: 'u1' }, ['r1'])).toHaveLength(1);
		}

		/** 5 分のあいだ、両方のワーカーが定期的に読み直す */
		async function sweepForFiveMinutes(s: ReturnType<typeof sharedLiveKit>) {
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(60_000);
				await s.A.service.sweep();
				await s.B.service.sweep();
			}
		}

		// K1: 一方のワーカーの時計が 100 ミリ秒進んでいる。A が u1 の入る前に空の現況を読んで保存し、u1 が入った後で (その webhook で)
		// B が読み直す。時刻は読み始める前に Redis で決めるので、後から読み始めた B の現況が、どちらの時計が進んでいても新しい
		test.each(['A', 'B'] as const)('keeps showing a call that started right after another worker read it empty, with worker %s\'s clock ahead', async (ahead) => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_000 });
			const at = (worker: 'A' | 'B', real: number) => vi.setSystemTime(real + (worker === ahead ? 100 : 0));

			try {
				at('A', 1_000_000);
				await s.A.service.refresh('r1');
				s.live.state = [u1];
				at('B', 1_000_050);
				await s.B.service.refresh('r1');
				await expectLocalCall(s);

				await sweepForFiveMinutes(s);
				await expectLocalCall(s);
			} finally {
				s.shutdown();
			}
		});

		// K2: 一方のワーカーの時計が 100 ミリ秒進んでいる。A が u1 の入る前に空の現況を読んだまま止まり、そのあいだに u1 が入って
		// B がその現況を保存した。A は後から保存しようとしても、先に時刻を決めているので B の現況を上書きしない
		test.each(['A', 'B'] as const)('does not let a stalled empty read hide a call that another worker read later, with worker %s\'s clock ahead', async (ahead) => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_000 });
			const at = (worker: 'A' | 'B', real: number) => vi.setSystemTime(real + (worker === ahead ? 100 : 0));

			try {
				at('A', 1_000_000);
				const paused = s.stallNextRead(s.A);
				const aRefresh = s.A.service.refresh('r1');
				await paused.reached;
				s.live.state = [u1];
				at('B', 1_000_050);
				await s.B.service.refresh('r1');
				paused.resume();
				await aRefresh;
				await expectLocalCall(s);

				await sweepForFiveMinutes(s);
				await expectLocalCall(s);
			} finally {
				s.shutdown();
			}
		});

		// 同じミリ秒に読み始めた二つの読み直しでも、Redis で後に時刻を決めたほうが新しい。保存する順番にはよらない
		test.each([
			['in the order they started', false],
			['in the reverse order', true],
		])('keeps the later of two refreshes started in the same millisecond with different reads, stored %s', async (_label, reverse) => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				const paused = reverse ? s.stallNextRead(s.A) : null;
				const aRefresh = s.A.service.refresh('r1');
				if (paused != null) await paused.reached;
				else await aRefresh;
				s.live.state = [u1];
				await s.B.service.refresh('r1');
				paused?.resume();
				await aRefresh;

				expect(Date.now()).toBe(1_000_000);
				expect(JSON.parse((await s.sharedRedis.get('chatVoice:state:r1'))!)).toMatchObject({ participants: [{ identity: u1.identity }] });
				expect([...(s.sharedRedis.sets.get('chatVoice:active') ?? [])]).toEqual(['r1']);
			} finally {
				s.shutdown();
			}
		});

		// 参加を求めた他のサーバーのユーザーに渡す現況の時刻も、同じ Redis の時刻の列から決める。答えたワーカーの時計が進んでいても、
		// その後で決めて送る現況のほうが新しく、相手のサーバーが古いものとして捨てない
		test('stamps what it hands to a joining remote member before any later decision, even on a worker whose clock is ahead', async () => {
			const s = sharedLiveKit();
			vi.useFakeTimers({ now: 1_000_100 });

			try {
				// A (時計が 100 ミリ秒進んでいる) が参加の求めに答える。通話はまだ無い
				const joined = await s.A.service.issueRemoteJoinToken(remoteUser(), 'r1', false);
				if (joined === 'forbidden') throw new Error('the join was refused');
				expect(await s.remote.service.storeRemoteSnapshot(mirrorRoom(), joined.participants, joined.updatedAt)).toBe('stored');

				// u1 が入り、B が読み直して送る
				vi.setSystemTime(1_000_050);
				s.live.state = [u1];
				await s.B.service.refresh('r1');

				expect(s.sent.at(-1)).toMatchObject({ by: 'B', n: 1 });
				expect(s.sent.at(-1)!.updatedAt).toBeGreaterThan(joined.updatedAt);
				expect(s.remoteParticipants()).toBe(1);
			} finally {
				s.shutdown();
			}
		});

		// 順番の鍵を待つのをやめた (ルームが無くなった、他のサーバーのメンバーがいなくなった、読めなかった) ときは、待った回数を忘れ、
		// 次に鍵が空いていなかったときは、また 0.5 秒から待つ
		test.each([
			['the room is gone', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomsRepository.findOneBy.mockResolvedValueOnce(null as unknown as { id: string; ownerId: string })],
			['the room cannot be read', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomsRepository.findOneBy.mockRejectedValueOnce(new Error('db is down'))],
			['no member is on another server any more', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomMembershipsRepository.findBy.mockResolvedValueOnce([{ userId: 'u1' }])],
		])('starts waiting for the room lock from half a second again after it stopped waiting because %s', async (_label, stopWaiting) => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			await f.redis.set('chatVoice:federateLock:r1', 'crashed worker', 'PX', 30_000, 'NX');
			const tries: number[] = [];
			const set = f.redis.set.getMockImplementation()!;
			f.redis.set.mockImplementation(async (key: string, ...rest: [string, ...(string | number)[]]) => {
				if (key === 'chatVoice:federateLock:r1') tries.push(Date.now() - 1_000_000);
				return await set(key, ...rest);
			});
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(8_000);
			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500]);

			// 次の決め直し (11.5 秒) は、鍵を取る前に待つのをやめる
			stopWaiting(f);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500]);

			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(600);
			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500, 12_000, 12_500]);
		});

		// 順番の鍵を取るときや、決める時刻を決めるときに Redis が失敗したら、待つのをやめる (次の webhook か定期的な読み直しで決め直す)。
		// 待った回数も忘れ、次に鍵が空いていなかったときは、また 0.5 秒から待つ
		test.each([
			['taking the room lock', 'lock'],
			['stamping the decision', 'stamp'],
		] as const)('starts waiting for the room lock from half a second again after Redis failed while %s', async (_label, failing) => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			const lockKey = 'chatVoice:federateLock:r1';
			await f.redis.set(lockKey, 'crashed worker', 'PX', 30_000, 'NX');
			const tries: number[] = [];
			let fail: 'lock' | 'stamp' | null = null;
			const set = f.redis.set.getMockImplementation()!;
			f.redis.set.mockImplementation(async (key: string, ...rest: [string, ...(string | number)[]]) => {
				if (key === lockKey) {
					tries.push(Date.now() - 1_000_000);
					if (fail === 'lock') {
						fail = null;
						throw new Error('Redis is down');
					}
				}
				return await set(key, ...rest);
			});
			const evaluate = f.redis.eval.getMockImplementation()!;
			f.redis.eval.mockImplementation(async (script: string, numKeys: number, ...args: (string | number)[]) => {
				if (args[0] === 'chatVoice:federateDecided:r1' && fail === 'stamp') {
					fail = null;
					throw new Error('Redis is down');
				}
				return await evaluate(script, numKeys, ...args);
			});
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(8_000);
			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500]);

			// 次の決め直し (11.5 秒) で Redis が失敗する。決める時刻で失敗させるときは、その前に鍵を空けておく
			fail = failing;
			if (failing === 'stamp') await f.redis.del(lockKey);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500, 11_500]);
			expect(f.logger.warn).toHaveBeenCalledWith('Failed to send the voice call in r1 to other servers: Redis is down');
			expect(vi.getTimerCount()).toBe(0);

			await set(lockKey, 'crashed worker', 'PX', 30_000, 'NX');
			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(600);
			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500, 11_500, 12_000, 12_500]);
		});

		/** 二つのワーカー。届けたものは送った順に sent に入る。A の配送は queueA を呼ぶまで積み終わらない (true のとき) */
		function twoWorkers() {
			const sharedRedis = fakeRedis();
			const workerA = createFixture(sharedRedis);
			const workerB = createFixture(sharedRedis);
			withRemoteMembers(workerA);
			withRemoteMembers(workerB);
			const sent: unknown[] = [];
			let pendingA: Promise<void> | null = null;
			let queueA!: () => void;
			const holdA = () => {
				pendingA = new Promise<void>(resolve => {
					queueA = resolve;
				});
			};
			workerA.queueService.deliver.mockImplementation((_user: unknown, activity: { object: { participants: unknown[] } }) => {
				sent.push(activity.object.participants);
				return pendingA ?? undefined;
			});
			workerB.queueService.deliver.mockImplementation((_user: unknown, activity: { object: { participants: unknown[] } }) => {
				sent.push(activity.object.participants);
			});
			return { workerA, workerB, sent, holdA, queueA: () => queueA() };
		}

		// P1: A が LiveKit を読んでから順番の鍵を取るまでのあいだ (ルームやメンバーを読んでいるあいだ) に止まり、その間に通話が終わって
		// B が終わりを決めた。A は止まる前に読んだ古い現況で送らない (二つのワーカーは同じ LiveKit を読むので、A が読み直しても終わっている)
		test('does not send participants read before another worker decided on the end of the call', async () => {
			const { workerA, workerB, sent } = twoWorkers();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				workerA.liveKitService.listParticipants.mockResolvedValue([]);
				await workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(30_000);

				workerA.liveKitService.listParticipants.mockResolvedValue([u1]);
				const paused = pauseNextCall(workerA.chatRoomsRepository.findOneBy);
				const activeRefresh = workerA.service.refresh('r1');
				await paused.reached;
				await vi.advanceTimersByTimeAsync(1_000);

				// 通話が終わった
				workerA.liveKitService.listParticipants.mockResolvedValue([]);
				workerB.liveKitService.listParticipants.mockResolvedValue([]);
				await workerB.service.refresh('r1');

				paused.resume();
				await activeRefresh;
				await vi.advanceTimersByTimeAsync(60_000);

				expect(sent.at(-1)).toEqual([]);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		// P3: A が積むのに順番の鍵の寿命 (30 秒) より長くかかり、その間に通話が終わって B が終わりを (前に送った終わりの記録で) 送らずに済ませた。
		// A は積み終えた後に自分の決めたことが古いと分かるので、記録を消して決め直し、終わりを送る
		test('sends the end of a call when an enqueue outlasts the room lock and another worker skipped the end meanwhile', async () => {
			const { workerA, workerB, sent, holdA, queueA } = twoWorkers();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				workerA.liveKitService.listParticipants.mockResolvedValue([]);
				await workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(30_000);

				holdA();
				workerA.liveKitService.listParticipants.mockResolvedValue([u1]);
				const activeSend = workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(31_000);

				// 通話が終わった
				workerA.liveKitService.listParticipants.mockResolvedValue([]);
				workerB.liveKitService.listParticipants.mockResolvedValue([]);
				await workerB.service.refresh('r1');
				queueA();
				await activeSend;
				await vi.advanceTimersByTimeAsync(60_000);

				expect(sent.at(-1)).toEqual([]);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		// 鍵を持ったまま止まったワーカーを待つあいだ、このサーバーのメンバーに知らせ直したり LiveKit を読み直したりしない
		test('waits for a busy room lock without telling this server\'s members again or re-reading LiveKit', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			await f.redis.set('chatVoice:federateLock:r1', 'crashed worker', 'PX', 30_000, 'NX');
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			const notified = f.globalEventService.publishMainStream.mock.calls.length;
			await vi.advanceTimersByTimeAsync(29_000);

			expect(notified).toBeGreaterThan(0);
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledTimes(notified);
			expect(f.liveKitService.listParticipants).toHaveBeenCalledTimes(1);
			expect(f.queueService.deliver).not.toHaveBeenCalled();

			// 鍵が切れたら、そのとき読んだ現況で決めて送る
			await vi.advanceTimersByTimeAsync(10_000);
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledTimes(notified);
		});

		test('backs off while the room lock stays busy: 0.5, 1 and 2 seconds, then every 4 seconds', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			await f.redis.set('chatVoice:federateLock:r1', 'crashed worker', 'PX', 30_000, 'NX');
			const tries: number[] = [];
			const set = f.redis.set.getMockImplementation()!;
			f.redis.set.mockImplementation(async (key: string, ...rest: [string, ...(string | number)[]]) => {
				if (key === 'chatVoice:federateLock:r1') tries.push(Date.now() - 1_000_000);
				return await set(key, ...rest);
			});
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(20_000);

			expect(tries).toEqual([0, 500, 1_500, 3_500, 7_500, 11_500, 15_500, 19_500]);
		});

		// LiveKit に届かないままなら、最初に決められなかったときからミラーの寿命 (600 秒) を過ぎた後は決め直さない。
		// そのころには、他のサーバーのミラーの現況 (最後に送ったのは最初に決められなかったときより前) は切れている
		test('stops deciding again once LiveKit has been unreachable for longer than a mirror snapshot lives', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			const reads: number[] = [];
			f.liveKitService.listParticipants.mockImplementation(async () => {
				reads.push(Date.now() - 1_000_000);
				// 読み直し (refresh) の一度目だけ答え、その後は届かない
				if (reads.length === 1) return [u1];
				throw new Error('LiveKit is down');
			});

			await expect(f.service.refresh('r1')).rejects.toThrow('LiveKit is down');
			await vi.advanceTimersByTimeAsync(1_200_000);

			// 鍵を取って読むのに失敗した後、0.5, 1, 2 秒、その後は 4 秒ごとに決め直し、最初の失敗から 600 秒を過ぎたらやめる
			expect(reads.slice(1, 6)).toEqual([0, 500, 1_500, 3_500, 7_500]);
			expect(reads.at(-1)).toBeGreaterThan(600_000);
			expect(reads.at(-1)).toBeLessThanOrEqual(604_000);
			expect(vi.getTimerCount()).toBe(0);
			expect(f.logger.warn).toHaveBeenCalledWith('Gave up sending the voice call in r1 to other servers after failing for 600 seconds');
		});

		// 送るかを決めた現況の時刻は増える一方。送らずに済ませたときも進める
		test('advances the decided time even when it skips a repeated end of a call', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');
			await vi.advanceTimersByTimeAsync(30_000);

			await f.service.refresh('r1');

			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
			// 2 回目の読み直しのこのサーバーの現況が 1_030_000 を使い、決めた時刻はその 1 ミリ秒後
			expect(await f.redis.get('chatVoice:federateDecided:r1')).toBe(String(1_030_001));
		});

		// 時計の進んだ別のワーカーが後の時刻で決めた後でも、この時計が追いつくのを待たず、その後の時刻ですぐに決める。
		// 読み直しのこのサーバーの現況が前に決めた時刻の 1 ミリ秒後を使うので、決める時刻はさらにその 1 ミリ秒後になる
		test('stamps a decision just after the last one instead of waiting for a clock that is behind', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			await f.redis.set('chatVoice:federateDecided:r1', String(1_002_000), 'EX', 3600);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toMatchObject({ updatedAt: 1_002_001 });
			expect(deliveredObjects().map(object => object.updated)).toEqual([new Date(1_002_002).toISOString(), new Date(1_002_002).toISOString()]);
			expect(await f.redis.get('chatVoice:federateDecided:r1')).toBe(String(1_002_002));
			expect(vi.getTimerCount()).toBe(0);
		});

		// 記録を書けなかった (後の現況の記録や決定があった) ときは、相手に届いた現況が分からないので、記録を消して決め直す
		test('forgets what it sent and decides again when its record is refused', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			await f.redis.set('chatVoice:federated:r1', JSON.stringify({ hash: 'other', at: 0, updatedAt: 1_060_000 }), 'EX', 240);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
			expect(await f.redis.get('chatVoice:federated:r1')).toBeNull();

			// 間隔の鍵が切れた後に決め直して、もう一度送る
			await vi.advanceTimersByTimeAsync(11_000);
			expect(f.queueService.deliver).toHaveBeenCalledTimes(4);
		});

		// 参加者のいる現況を積んでいる途中に、ほかのワーカーが新しい終わりを読んでも、その終わりは後で送る
		test('sends a newer end of a call that arrives while another worker is still queueing the participants', async () => {
			const { workerA, workerB, sent, holdA, queueA } = twoWorkers();
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				// 終わりを送った記録がある
				workerA.liveKitService.listParticipants.mockResolvedValue([]);
				await workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(30_000);

				// A が参加者のいる現況を積んでいる途中に、B が新しい終わりを読む
				holdA();
				workerA.liveKitService.listParticipants.mockResolvedValue([u1]);
				const activeSend = workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(1_000);
				expect(sent.at(-1)).toEqual([{ id: u1.identity, screenSharing: false }]);
				workerB.liveKitService.listParticipants.mockResolvedValue([]);
				await workerB.service.refresh('r1');

				queueA();
				await activeSend;
				await vi.advanceTimersByTimeAsync(20_000);

				expect(sent.at(-1)).toEqual([]);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		// 積むのに手間取ったワーカーの古い現況が、後から送られた新しい現況の記録を上書きしない
		// 積むのに手間取ったワーカーの古い現況は、後から決めた現況の記録を上書きしない。古い現況は相手に届いたかもしれないので、
		// 記録を消して LiveKit から決め直し、最新の現況を送り直す
		test('does not record an older send that finishes after a newer decision, and sends the newest state again', async () => {
			const { workerA, workerB, sent, holdA, queueA } = twoWorkers();
			vi.useFakeTimers({ now: 1_000_000 });
			const sharing = [{ ...u1, screenSharing: true }];

			try {
				holdA();
				workerA.liveKitService.listParticipants.mockResolvedValue([u1]);
				const oldSend = workerA.service.refresh('r1');
				await vi.advanceTimersByTimeAsync(31_000);

				// 画面共有が始まった。二つのワーカーは同じ LiveKit を読む
				workerA.liveKitService.listParticipants.mockResolvedValue(sharing);
				workerB.liveKitService.listParticipants.mockResolvedValue(sharing);
				await workerB.service.refresh('r1');
				const newer = JSON.parse((await workerB.redis.get('chatVoice:federated:r1'))!) as { updatedAt: number };
				queueA();
				await oldSend;

				expect(await workerB.redis.get('chatVoice:federated:r1')).toBeNull();
				await vi.advanceTimersByTimeAsync(20_000);
				expect(sent.at(-1)).toEqual([{ id: u1.identity, screenSharing: true }]);
				expect((JSON.parse((await workerB.redis.get('chatVoice:federated:r1'))!) as { updatedAt: number }).updatedAt).toBeGreaterThan(newer.updatedAt);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		test('still sends a held-back end of a call when a refresh in between fails', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			const sent = recordDeliveries();
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await vi.advanceTimersByTimeAsync(1_000);
			await f.service.refresh('r1');
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await vi.advanceTimersByTimeAsync(1_000);
			// 終わりを送ったばかりなので、この終わりは待たせる
			await f.service.refresh('r1');

			// 待っているあいだに webhook の読み直しが先に動き、LiveKit に届かず失敗する
			f.liveKitService.listParticipants.mockRejectedValueOnce(new Error('LiveKit is down'));
			f.service.handleWebhook({ event: 'room_finished', room: { name: 'chatRoom:r1' } } as any);
			await vi.advanceTimersByTimeAsync(20_000);

			expect(sent.size).toBe(2);
			for (const deliveries of sent.values()) {
				expect(deliveries.at(-1)!.participants).toEqual([]);
			}
		});

		test('federates rapid changes at most once every 10 seconds, ending with the latest state', async () => {
			withManyRemoteMembers(50);
			vi.useFakeTimers({ now: 1_000_000 });
			const sent = recordDeliveries();

			// 60 秒のあいだ、画面共有を 600 ミリ秒ごとに切り替える
			await changeEvery600ms(Array.from({ length: 100 }, (_, i) => [{ ...u1, screenSharing: i % 2 === 1 }]), 'track_published');
			await vi.advanceTimersByTimeAsync(20_000);

			expect(sent.size).toBe(50);
			for (const deliveries of sent.values()) {
				expect(deliveries.length).toBeLessThanOrEqual(7);
				expect(deliveries.at(-1)!.participants).toEqual([{ id: 'https://local.test/users/u1', screenSharing: true }]);
			}
		});

		test('sends one empty snapshot per 10 seconds while people keep joining and leaving', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			const sent = recordDeliveries();

			await changeEvery600ms(Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? [u1] : [])), 'participant_left');
			await vi.advanceTimersByTimeAsync(20_000);

			expect(sent.size).toBe(2);
			for (const deliveries of sent.values()) {
				const empties = deliveries.filter(delivery => delivery.participants.length === 0);
				expect(empties.length).toBeGreaterThan(1);
				for (let i = 1; i < empties.length; i++) {
					expect(empties[i].at - empties[i - 1].at).toBeGreaterThanOrEqual(10_000);
				}
				// 通話は空で終わったので、最後に送ったものも空
				expect(deliveries.at(-1)!.participants).toEqual([]);
			}
		});

		test('shares the 10 second budget between workers', async () => {
			const sharedRedis = fakeRedis();
			const workerA = createFixture(sharedRedis);
			const workerB = createFixture(sharedRedis);
			withRemoteMembers(workerA);
			withRemoteMembers(workerB);
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				workerA.liveKitService.listParticipants.mockResolvedValue([u1]);
				await workerA.service.refresh('r1');
				workerB.liveKitService.listParticipants.mockResolvedValue([{ ...u1, screenSharing: true }]);
				await workerB.service.refresh('r1');

				expect(workerA.queueService.deliver).toHaveBeenCalledTimes(2);
				expect(workerB.queueService.deliver).not.toHaveBeenCalled();

				// 送れなかった変化は、間隔の鍵が切れたときに最新の現況を読み直して送る
				await vi.advanceTimersByTimeAsync(10_001);
				expect(deliveredObjects(workerB).map(object => object.participants)).toEqual([
					[{ id: 'https://local.test/users/u1', screenSharing: true }],
					[{ id: 'https://local.test/users/u1', screenSharing: true }],
				]);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		test('sends after notifying this server\'s members', async () => {
			withRemoteMembers();
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			const notifiedAt = Math.max(...f.globalEventService.publishMainStream.mock.invocationCallOrder);
			expect(Math.min(...f.queueService.deliver.mock.invocationCallOrder)).toBeGreaterThan(notifiedAt);
		});
	});

	describe('receiving the participants of a mirror room', () => {
		const ROOM_URI = 'https://remote.test/chat/rooms/r1';
		const owner = { id: 'remoteOwner', host: 'remote.test', uri: 'https://remote.test/users/remoteOwner' } as any;

		function voiceState(overrides: Record<string, unknown> = {}) {
			return {
				id: `${ROOM_URI}/voice`,
				type: 'ChatRoomVoiceState',
				room: ROOM_URI,
				participants: [{ id: 'https://local.test/users/u1', screenSharing: true }],
				updated: new Date(2000).toISOString(),
				...overrides,
			} as any;
		}

		beforeEach(() => {
			f.rooms.set('r1', mirrorRoom());
		});

		test('accepts a voice state from the owner of the mirror room', async () => {
			const result = await f.service.receiveRemoteSnapshot(owner, voiceState());

			expect(result).toMatch(/^ok/);
			// 保存する前にミラーであることを確かめられるよう、持ち主ごと読む
			expect(f.chatRoomsRepository.findOne).toHaveBeenCalledWith({ where: { id: 'r1' }, relations: { owner: true } });
			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toEqual({
				participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }],
				updatedAt: 2000,
			});
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', expect.objectContaining({ roomId: 'r1' }));
		});

		test('ignores a voice state from someone who does not own the room', async () => {
			const someoneElse = { id: 'someoneElse', host: 'remote.test', uri: 'https://remote.test/users/someoneElse' } as any;

			const result = await f.service.receiveRemoteSnapshot(someoneElse, voiceState());

			expect(result).toMatch(/^skip:/);
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
		});

		test('ignores a voice state whose room lives on another server', async () => {
			const cases = [
				{ actor: owner, state: voiceState({ room: 'https://other.test/chat/rooms/r1', id: 'https://other.test/chat/rooms/r1/voice' }) },
				{ actor: owner, state: voiceState({ room: 'https://other.test/chat/rooms/r1' }) },
				{ actor: owner, state: voiceState({ id: 'https://other.test/chat/rooms/r1/voice' }) },
				{ actor: owner, state: voiceState({ room: 'http://remote.test/chat/rooms/r1', id: 'http://remote.test/chat/rooms/r1/voice' }) },
				{ actor: owner, state: voiceState({ room: 'https://remote.test:8443/chat/rooms/r1', id: 'https://remote.test:8443/chat/rooms/r1/voice' }) },
				// ポート付きのホストどうしも、別のサーバーとして扱う
				{
					actor: { ...owner, host: 'remote.test:8443', uri: 'https://remote.test:8443/users/remoteOwner' },
					state: voiceState({ room: 'https://other.test:8443/chat/rooms/r1', id: 'https://other.test:8443/chat/rooms/r1/voice' }),
				},
			];
			for (const { actor, state } of cases) {
				expect(await f.service.receiveRemoteSnapshot(actor, state), state.room).toMatch(/^skip:/);
			}
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
		});

		test('accepts a voice state from an owner on a server with a port', async () => {
			const portOwner = { ...owner, host: 'remote.test:8443', uri: 'https://remote.test:8443/users/remoteOwner' };

			const result = await f.service.receiveRemoteSnapshot(portOwner, voiceState({ room: 'https://remote.test:8443/chat/rooms/r1', id: 'https://remote.test:8443/chat/rooms/r1/voice' }));

			expect(result).toMatch(/^ok/);
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(true);
		});

		test('ignores a voice state for a room this server does not mirror', async () => {
			const result = await f.service.receiveRemoteSnapshot(owner, voiceState({ room: 'https://remote.test/chat/rooms/r9', id: 'https://remote.test/chat/rooms/r9/voice' }));

			expect(result).toMatch(/^skip:/);
			expect(f.redis.eval).not.toHaveBeenCalled();
		});

		test('ignores a malformed voice state', async () => {
			const store = vi.spyOn(f.service, 'storeRemoteSnapshot');
			const malformed = [
				{ id: undefined },
				{ room: undefined },
				{ room: `${ROOM_URI}?x=1` },
				{ room: `${ROOM_URI}#x` },
				{ room: `${ROOM_URI}/extra` },
				{ room: 'https://remote.test/chat/rooms/' },
				{ room: 'https://remote.test/chat/rooms/r-1' },
				{ room: 'not a url' },
				{ participants: undefined },
				{ participants: 'https://local.test/users/u1' },
				{ participants: Array.from({ length: 52 }, (_, i) => ({ id: `https://far.test/users/${i}`, screenSharing: false })) },
				{ participants: [null] },
				{ participants: [{ id: 1, screenSharing: false }] },
				{ participants: [{ id: 'https://local.test/users/u1' }] },
				{ participants: [{ id: 'https://local.test/users/u1', screenSharing: 'yes' }] },
				{ updated: undefined },
				{ updated: 2000 },
				{ updated: 'yesterday' },
			];
			for (const overrides of malformed) {
				expect(await f.service.receiveRemoteSnapshot(owner, voiceState(overrides)), JSON.stringify(overrides)).toMatch(/^skip:/);
			}
			expect(store).not.toHaveBeenCalled();
		});

		test('accepts as many participants as a room can hold', async () => {
			const participants = Array.from({ length: 51 }, (_, i) => ({ id: `https://far.test/users/${i}`, screenSharing: false }));

			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ participants }))).toMatch(/^ok/);
		});

		test('ignores voice states while this server does not join calls on other servers', async () => {
			for (const meta of [{ enableRemoteVoiceCall: false, federation: 'all' }, { enableRemoteVoiceCall: true, federation: 'none' }]) {
				Object.assign(f.meta, meta);

				expect(await f.service.receiveRemoteSnapshot(owner, voiceState()), JSON.stringify(meta)).toMatch(/^skip:/);
			}
			expect(f.redis.eval).not.toHaveBeenCalled();
		});

		test('keeps the newer snapshot when an older one arrives late', async () => {
			await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(3000).toISOString() }));
			await f.service.receiveRemoteSnapshot(owner, voiceState({
				updated: new Date(2000).toISOString(),
				participants: [{ id: 'https://local.test/users/u2', screenSharing: false }],
			}));

			expect(JSON.parse(f.redis.store.get('chatVoice:state:r1')!)).toEqual({
				participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }],
				updatedAt: 3000,
			});
		});

		test.each([
			['stored', 'ok: voice state stored'],
			['stale', 'skip: voice state is not newer than the last one accepted'],
			['ahead', 'skip: voice state is stamped too far ahead'],
			['disabled', 'skip: remote voice calls are disabled'],
		] as const)('reports a snapshot that was %s to the inbox as "%s"', async (reason, expected) => {
			vi.spyOn(f.service, 'storeRemoteSnapshot').mockResolvedValue(reason as any);

			expect(await f.service.receiveRemoteSnapshot(owner, voiceState())).toBe(expected);
		});

		test('expires a mirror snapshot after ten minutes, and remembers its time for two days', async () => {
			await f.service.receiveRemoteSnapshot(owner, voiceState());

			expect(f.redis.eval).toHaveBeenCalledWith(expect.any(String), 3, 'chatVoice:state:r1', 'chatVoice:lastSeen:r1', 'chatVoice:remoteGeneration', expect.any(String), 2000, 600, 172_800, '0');
			expect(f.redis.sadd).not.toHaveBeenCalled();
		});

		// 配送のやり直し (最大 12 回) で、終わった通話の古い現況が、終わりを保存した鍵が切れた後に届くことがある
		test('does not bring back an ended call when an older voice state arrives after the stored one expired', async () => {
			vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(990_000).toISOString() }))).toMatch(/^ok/);
			// 通話の終わりも、すぐに保存してこのサーバーのメンバーに知らせる
			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(995_000).toISOString(), participants: [] }))).toMatch(/^ok/);
			expect(f.globalEventService.publishMainStream).toHaveBeenLastCalledWith('m1', 'chatRoomVoiceState', { roomId: 'r1', participants: [], updatedAt: 995_000 });
			f.globalEventService.publishMainStream.mockClear();

			vi.setSystemTime(1_000_000 + 601_000);
			expect(await f.redis.get('chatVoice:state:r1')).toBeNull();
			for (const updated of [990_000, 995_000]) {
				expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(updated).toISOString() })), String(updated)).toMatch(/^skip:/);
			}
			expect(await f.redis.get('chatVoice:state:r1')).toBeNull();
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			// ホストが後から送ったものは受け入れる
			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(1_590_000).toISOString() }))).toMatch(/^ok/);
		});

		test('ignores a room URI with an empty query or fragment', async () => {
			for (const room of [`${ROOM_URI}?`, `${ROOM_URI}#`, `${ROOM_URI}?#`]) {
				expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ room, id: `${room}/voice` })), room).toMatch(/^skip:/);
			}
			expect(f.redis.eval).not.toHaveBeenCalled();
		});

		test('ignores a voice state whose id is not the voice state of its room', async () => {
			const ids = [
				ROOM_URI,
				`${ROOM_URI}/other`,
				`${ROOM_URI}/voice/`,
				`${ROOM_URI}/voice?x=1`,
				`${ROOM_URI}/voice#x`,
				'https://remote.test/chat/rooms/r2/voice',
				'https://remote.test/voice',
			];
			for (const id of ids) {
				expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ id })), id).toMatch(/^skip:/);
			}
			expect(f.redis.eval).not.toHaveBeenCalled();
		});

		// 先の時刻を付けた現況を受け入れると、寿命が切れるまでホストが新しい現況で上書きできなくなる
		test('ignores an empty voice state older than two days minus five minutes', async () => {
			const now = 1_000_000_000;
			const maxAge = 172_800_000 - 300_000;
			vi.useFakeTimers({ now, toFake: ['Date'] });

			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ participants: [], updated: new Date(now - maxAge - 1).toISOString() }))).toBe('skip: voice state is too old');
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ participants: [], updated: new Date(now - maxAge).toISOString() }))).toMatch(/^ok/);
		});

		test('ignores a voice state with participants older than ten minutes plus five minutes', async () => {
			const now = 1_000_000_000;
			const maxAge = 600_000 + 300_000;
			vi.useFakeTimers({ now, toFake: ['Date'] });

			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(now - maxAge - 1).toISOString() }))).toBe('skip: voice state is too old');
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(now - maxAge).toISOString() }))).toMatch(/^ok/);
		});

		// ルームを持つサーバーは `${url}/chat/rooms/${id}` (url は正規化した origin) をそのまま送る。それ以外の書き方は受け付けない
		test('ignores a room URI that is not written exactly as the sender\'s server writes it', async () => {
			const rooms = [
				'https://@remote.test/chat/rooms/r1',
				'https://:@remote.test/chat/rooms/r1',
				'https://remote.test/chat/rooms/x/../r1',
				'https://remote.test/chat/rooms/./r1',
				'https://remote.test/chat/../chat/rooms/r1',
				'https://remote.test:443/chat/rooms/r1',
				'https://REMOTE.test/chat/rooms/r1',
			];
			for (const room of rooms) {
				expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ room, id: `${room}/voice` })), room).toMatch(/^skip:/);
			}
			expect(f.redis.eval).not.toHaveBeenCalled();
		});

		test('ignores a voice state stamped more than five minutes ahead of this server\'s clock', async () => {
			vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });

			const result = await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(1_000_000 + 300_001).toISOString() }));

			expect(result).toMatch(/^skip:/);
			expect(f.redis.store.has('chatVoice:state:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});
	});
});

// 保存のスクリプトそのもの (Lua) は本物の Redis で確かめる
describe('ChatVoiceService storing mirror snapshots in Redis', () => {
	const prefix = `test-chatVoice-${randomUUID()}:`;
	let redis: Redis;
	let raw: Redis;
	let f: ReturnType<typeof createFixture>;

	beforeAll(() => {
		const config = loadConfig();
		redis = new Redis({ ...config.redis, keyPrefix: prefix });
		raw = new Redis({ ...config.redis, keyPrefix: undefined });
	});

	beforeEach(async () => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		f = createFixture(redis as any);
		await redis.del('chatVoice:mirrorPublished:r1', 'chatVoice:state:r1', 'chatVoice:lastSeen:r1', 'chatVoice:remoteGeneration', 'chatVoice:federated:r1', 'chatVoice:federateGate:r1', 'chatVoice:federateEmptyGate:r1', 'chatVoice:federateLock:r1', 'chatVoice:federateDecided:r1', 'chatVoice:localStamp:r1', 'chatVoice:active');
	});

	afterEach(() => {
		f.service.onApplicationShutdown();
		vi.useRealTimers();
	});

	afterAll(async () => {
		await redis.del('chatVoice:mirrorPublished:r1', 'chatVoice:state:r1', 'chatVoice:lastSeen:r1', 'chatVoice:remoteGeneration', 'chatVoice:federated:r1', 'chatVoice:federateGate:r1', 'chatVoice:federateEmptyGate:r1', 'chatVoice:federateLock:r1', 'chatVoice:federateDecided:r1', 'chatVoice:localStamp:r1', 'chatVoice:active');
		redis.disconnect();
		raw.disconnect();
	});

	const stored = async () => JSON.parse((await redis.get('chatVoice:state:r1'))!) as { participants: { identity: string }[]; updatedAt: number };
	const store = (updatedAt: number, identity = 'https://local.test/users/u1') => f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity, screenSharing: false }], updatedAt);

	test('the shared mirror gate preserves active cadence across empty toggles without delaying the first active', async () => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		const people = [{ identity: 'https://local.test/users/u1', screenSharing: false }];
		await f.service.storeRemoteSnapshot(room, [], TEST_CLOCK);
		await f.service.storeRemoteSnapshot(room, people, TEST_CLOCK + 1);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledTimes(2);
		await f.service.storeRemoteSnapshot(room, [], TEST_CLOCK + 2);
		await f.service.storeRemoteSnapshot(room, people, TEST_CLOCK + 3);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledTimes(3);
		expect(JSON.parse((await redis.get('chatVoice:mirrorPublished:r1'))!)).toMatchObject({ empty: true, updatedAt: TEST_CLOCK + 2 });
	});

	test.each([false, true])('policy clear uses host chronology and the first fresh host event recovers (snapshot absent: %s)', async absent => {
		vi.setSystemTime(1_240_000);
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		const participants = [{ identity: 'https://local.test/users/u1', screenSharing: false }];
		await f.service.storeRemoteSnapshot(room, participants, 1_000_000);
		if (absent) await redis.del('chatVoice:state:r1');
		f.globalEventService.publishMainStream.mockClear();
		f.meta.blockedHosts = ['remote.test'];
		await f.service.clearMirrorSnapshots(true);
		const cleared = f.globalEventService.publishMainStream.mock.calls.at(-1)![2];
		expect(cleared).toMatchObject({ participants: [], updatedAt: 1_000_000 });
		f.meta.blockedHosts = [];
		expect(await f.service.storeRemoteSnapshot(room, participants, 1_010_000)).toBe('stored');
		const resumed = f.globalEventService.publishMainStream.mock.calls.at(-1)![2];
		// use-chat-room-voice-states の isOutdated は、保持時刻より小さい場合だけ捨てる。
		expect(resumed.updatedAt < cleared.updatedAt).toBe(false);
		expect(resumed.participants).toHaveLength(1);
	});

	test.each([false, true])('an old clear cannot delete a newer post-unblock snapshot (superseding generation: %s)', async superseded => {
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		const participants = [{ identity: 'https://local.test/users/u1', screenSharing: false }];
		await f.service.storeRemoteSnapshot(room, participants, TEST_CLOCK);
		f.meta.blockedHosts = ['remote.test'];
		let reached!: () => void;
		let resume!: () => void;
		const waiting = new Promise<void>(resolve => { reached = resolve; });
		const paused = new Promise<void>(resolve => { resume = resolve; });
		vi.spyOn(f.service, 'isRoomVoiceVisible').mockImplementationOnce(async () => {
			reached();
			await paused;
			return false;
		});
		const clearing = f.service.clearMirrorSnapshots(true);
		try {
			await waiting;
			f.meta.blockedHosts = [];
			if (superseded) await f.service.clearMirrorSnapshots(true);
			expect(await f.service.storeRemoteSnapshot(room, participants, TEST_CLOCK + 10)).toBe('stored');
			const published = await redis.get('chatVoice:mirrorPublished:r1');
			f.globalEventService.publishMainStream.mockClear();
			resume();
			await clearing;
			expect(await redis.get('chatVoice:mirrorPublished:r1')).toBe(published);
			expect(JSON.parse((await redis.get('chatVoice:state:r1'))!)).toMatchObject({ updatedAt: TEST_CLOCK + 10 });
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		} finally {
			resume();
		}
	});

	test('a second worker raw-null join invalidates an older queued record in real Redis', async () => {
		const other = createFixture(redis as any);
		const participants = [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }];
		for (const worker of [f, other]) {
			worker.liveKitService.listParticipants.mockResolvedValue(participants);
			worker.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'rm1' }]);
		}
		f.queueService.deliver.mockResolvedValue(undefined);
		const paused = pauseNextCall(f.queueService.deliver);
		try {
			const refreshing = f.service.refresh('r1');
			await paused.reached;
			await redis.del('chatVoice:state:r1');
			const join = await other.service.snapshotOf('r1');
			paused.resume();
			await refreshing;
			expect(await redis.get('chatVoice:federated:r1')).toBeNull();
			await redis.del('chatVoice:federateGate:r1');
			await other.service.refresh('r1');
			expect(JSON.parse((await redis.get('chatVoice:federated:r1'))!).updatedAt).toBeGreaterThan(join.updatedAt);
		} finally {
			paused.resume();
			other.service.onApplicationShutdown();
			await redis.del('chatVoice:joinInvalidated:r1');
		}
	});

	test.each(['active', 'remoteGeneration'])('a remote room named %s cannot overwrite or clear control keys', async id => {
		await redis.sadd('chatVoice:active', 'local');
		await redis.set('chatVoice:remoteGeneration', '7');
		const room = { ...mirrorRoom(), id };
		f.rooms.set(id, room);
		expect(await f.service.storeRemoteSnapshot(room, [], TEST_CLOCK)).toBe('stored');
		expect(await redis.smembers('chatVoice:active')).toEqual(['local']);
		expect(await redis.get('chatVoice:remoteGeneration')).toBe('7');
		await f.service.clearMirrorSnapshots();
		expect(await redis.smembers('chatVoice:active')).toEqual(['local']);
		expect(await redis.get('chatVoice:remoteGeneration')).toBe('8');
		await redis.del(`chatVoice:state:${id}`, `chatVoice:lastSeen:${id}`);
	});

	test('stores a snapshot under the configured prefix for ten minutes', async () => {
		expect(await store(2000)).toBe('stored');

		expect(await stored()).toEqual({ participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }], updatedAt: 2000 });
		expect(await raw.exists(`${prefix}chatVoice:state:r1`)).toBe(1);
		const ttl = await redis.ttl('chatVoice:state:r1');
		expect(ttl).toBeGreaterThan(590);
		expect(ttl).toBeLessThanOrEqual(600);
	});

	test('stores only a snapshot strictly newer than the stored one', async () => {
		expect(await store(2000)).toBe('stored');
		expect(await store(2000, 'https://local.test/users/u2')).toBe('stale');
		expect(await store(1999, 'https://local.test/users/u2')).toBe('stale');
		expect((await stored()).participants.map(p => p.identity)).toEqual(['https://local.test/users/u1']);

		expect(await store(2000.5, 'https://local.test/users/u2')).toBe('stored');
		expect(await stored()).toMatchObject({ participants: [{ identity: 'https://local.test/users/u2' }], updatedAt: 2000.5 });
	});

	test('keeps the newest of many snapshots stored at the same time', async () => {
		const times = [5, 3, 9, 1, 7, 2, 8, 4, 6].map(n => 500_000 + n);

		await Promise.all(times.map(updatedAt => store(updatedAt)));

		expect((await stored()).updatedAt).toBe(500_009);
	});

	// 他のサーバーへ送るときの、送った記録と送る順番の鍵のスクリプト
	describe('federating', () => {
		const u1 = { identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false, micTrackSid: null };
		const record = async () => JSON.parse((await redis.get('chatVoice:federated:r1'))!) as { hash: string; updatedAt: number };

		beforeEach(() => {
			f.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'rm1' }]);
		});

		test('records what it sent and the time it decided on, and gives back its turn', async () => {
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await f.service.refresh('r1');

			// 読み直しのこのサーバーの現況が TEST_CLOCK を使い、決めた時刻はその 1 ミリ秒後
			expect(await record()).toMatchObject({ updatedAt: TEST_CLOCK + 1 });
			expect(await redis.get('chatVoice:federateDecided:r1')).toBe(String(TEST_CLOCK + 1));
			expect(await redis.exists('chatVoice:federateLock:r1')).toBe(0);

			// 厳密に後の現況なら書く
			await redis.del('chatVoice:federateGate:r1');
			vi.setSystemTime(TEST_CLOCK + 5_000);
			f.liveKitService.listParticipants.mockResolvedValue([{ ...u1, screenSharing: true }]);
			await f.service.refresh('r1');
			expect(await record()).toMatchObject({ updatedAt: TEST_CLOCK + 5_001 });
			expect(await redis.get('chatVoice:federateDecided:r1')).toBe(String(TEST_CLOCK + 5_001));
		});

		test('stamps a decision just after the time decided on when the clock is behind it', async () => {
			// 13 桁の時刻 (いまのミリ秒の時刻と同じ桁) でも、そのまま書いて返す
			const decided = 1_793_059_200_000;
			await redis.set('chatVoice:federateDecided:r1', String(decided), 'EX', 3600);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			// 読み直しのこのサーバーの現況が decided + 1 を使い、決めた時刻はさらにその 1 ミリ秒後
			expect(f.queueService.deliver).toHaveBeenCalledTimes(1);
			expect(await redis.get('chatVoice:federateDecided:r1')).toBe(String(decided + 2));
			expect(await record()).toMatchObject({ updatedAt: decided + 2 });
		});

		// このサーバーの現況は、後から読み始めた (Redis で後に時刻を決めた) ものだけを書き、通話中のルームの一覧も一緒に変える。
		// この時計が遅れていても、後から読み始めたほうを書く
		test('stores this server\'s snapshot and the active rooms only from the read that started later', async () => {
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await f.service.refresh('r1');
			expect(JSON.parse((await redis.get('chatVoice:state:r1'))!)).toMatchObject({ participants: [{ identity: u1.identity }], updatedAt: TEST_CLOCK });
			expect(await redis.smembers('chatVoice:active')).toEqual(['r1']);

			// 先に読み始めた読み直しが止まっているあいだに、時計の遅れた読み直しが後から読み始めて、通話の終わりを読む
			const paused = pauseNextCall(f.liveKitService.listParticipants);
			const older = f.service.refresh('r1');
			await paused.reached;
			vi.setSystemTime(TEST_CLOCK - 1_000);
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');
			const ended = JSON.parse((await redis.get('chatVoice:state:r1'))!) as { participants: unknown[]; updatedAt: number };
			expect(ended.participants).toEqual([]);
			expect(await redis.smembers('chatVoice:active')).toEqual([]);
			expect(await redis.ttl('chatVoice:state:r1')).toBeGreaterThan(110);

			// 先に読み始めた読み直しは、後から読み終えても書かない
			paused.resume();
			await older;
			expect(JSON.parse((await redis.get('chatVoice:state:r1'))!)).toEqual(ended);
			expect(await redis.smembers('chatVoice:active')).toEqual([]);
		});

		// このサーバーの現況の時刻は、読み始める前に Redis で決める。この時計が遅れていても、ルームの時刻の列 (このサーバーの現況の時刻と、
		// 送るかを決めた時刻) の最後の時刻より後にし、送るかを決める時刻はさらにその後にする
		test('stamps this server\'s snapshot after the room\'s last stamps, and the decision after that', async () => {
			// 13 桁の時刻 (いまのミリ秒の時刻と同じ桁) でも、そのまま書いて返す
			const last = 1_793_059_200_000;
			await redis.set('chatVoice:localStamp:r1', String(last), 'EX', 3600);
			await redis.set('chatVoice:federateDecided:r1', String(last - 5), 'EX', 3600);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(JSON.parse((await redis.get('chatVoice:state:r1'))!)).toMatchObject({ participants: [{ identity: u1.identity }], updatedAt: last + 1 });
			expect(await redis.get('chatVoice:localStamp:r1')).toBe(String(last + 1));
			expect(await redis.ttl('chatVoice:localStamp:r1')).toBeGreaterThan(3590);
			expect(await redis.get('chatVoice:federateDecided:r1')).toBe(String(last + 2));
			expect(await record()).toMatchObject({ updatedAt: last + 2 });
		});

		// ほかのワーカーが、送っている途中に後の現況を記録したか後の時刻で決めたなら、前の現況の記録を書かずに消す
		test.each([
			['a newer record', 'chatVoice:federated:r1', JSON.stringify({ hash: 'newer', at: 0, updatedAt: TEST_CLOCK + 5_000 })],
			['a newer decision', 'chatVoice:federateDecided:r1', String(TEST_CLOCK + 5_000)],
		])('drops its record when another worker writes %s while it sends', async (_label, key, value) => {
			f.queueService.deliver.mockImplementation(async () => {
				await redis.set(key, value, 'EX', 240);
			});
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(f.queueService.deliver).toHaveBeenCalled();
			expect(await redis.exists('chatVoice:federated:r1')).toBe(0);
		});

		test('waits for another worker\'s turn, and leaves its turn alone', async () => {
			await redis.set('chatVoice:federateLock:r1', 'another worker', 'PX', 30_000);
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			expect(f.queueService.deliver).not.toHaveBeenCalled();
			expect(await redis.get('chatVoice:federateLock:r1')).toBe('another worker');
			expect(await redis.exists('chatVoice:federated:r1')).toBe(0);
		});
	});

	test('replaces a stored value it cannot read', async () => {
		await redis.set('chatVoice:state:r1', 'not json', 'EX', 600);
		await redis.set('chatVoice:lastSeen:r1', 'not a time', 'EX', 600);

		expect(await store(2000)).toBe('stored');
		expect((await stored()).updatedAt).toBe(2000);
	});

	// 配送のやり直しで、終わった通話の古い現況が、終わりを保存した鍵が切れた後に届くことがある
	test('stores only a snapshot newer than the newest one accepted, even after the stored one expired', async () => {
		expect(await store(3000)).toBe('stored');
		// 寿命が切れたのと同じ
		await redis.del('chatVoice:state:r1');

		expect(await store(2000)).toBe('stale');
		expect(await store(3000)).toBe('stale');
		expect(await redis.get('chatVoice:state:r1')).toBeNull();

		expect(await store(3000.5, 'https://local.test/users/u2')).toBe('stored');
		expect(await stored()).toMatchObject({ participants: [{ identity: 'https://local.test/users/u2' }], updatedAt: 3000.5 });
	});

	// 他のワーカーが他のサーバーの通話を止めて現況を消した後に届いた書き込みは、スクリプトが断る
	test('refuses a write that started before another worker turned remote calls off', async () => {
		const other = createFixture(redis as any);
		other.rooms.set('r1', mirrorRoom());
		const resolving = pauseNextCall(f.usersRepository.findBy);

		const storing = store(2000);
		await resolving.reached;
		await other.service.clearMirrorSnapshots();
		resolving.resume();

		expect(await storing).toBe('disabled');
		expect(await redis.get('chatVoice:state:r1')).toBeNull();
		expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		// 消した後に始めた書き込みは、変わった後の値を読むので書ける
		expect(await store(3000)).toBe('stored');
	});

	test('remembers the time of the newest accepted snapshot for two days', async () => {
		expect(await store(2000)).toBe('stored');
		expect(await store(1000)).toBe('stale');

		expect(await redis.get('chatVoice:lastSeen:r1')).toBe('2000');
		expect(await raw.exists(`${prefix}chatVoice:lastSeen:r1`)).toBe(1);
		const ttl = await redis.ttl('chatVoice:lastSeen:r1');
		expect(ttl).toBeGreaterThan(172_790);
		expect(ttl).toBeLessThanOrEqual(172_800);
	});
});
