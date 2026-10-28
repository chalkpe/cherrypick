/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import JoinEndpoint, { meta as joinMeta } from '@/server/api/endpoints/chat/rooms/voice/join.js';
import StatesEndpoint from '@/server/api/endpoints/chat/rooms/voice/states.js';
import KickEndpoint, { meta as kickMeta } from '@/server/api/endpoints/chat/rooms/voice/kick.js';
import MuteEndpoint, { meta as muteMeta } from '@/server/api/endpoints/chat/rooms/voice/mute.js';
import { ChatService } from '@/core/ChatService.js';
import { MetaEntityService } from '@/core/entities/MetaEntityService.js';
import { RemoteVoiceCallError } from '@/core/RemoteVoiceCallService.js';

const me = { id: 'me', host: null, uri: null } as any;
const liveKit = (isEnabled = true) => ({
	isEnabled,
	identityOf: (user: { id: string; host: string | null; uri: string | null }) => user.host == null ? `https://local.test/users/${user.id}` : user.uri,
	removeParticipant: vi.fn().mockResolvedValue(undefined),
	muteMicrophone: vi.fn().mockResolvedValue(undefined),
	deleteRoom: vi.fn().mockResolvedValue(undefined),
});

const remoteOwner = { id: 'owner', host: 'remote.test', uri: 'https://remote.test/users/owner' };

function joinFixture(overrides: { isEnabled?: boolean; remoteEnabled?: boolean; canVoiceCall?: boolean; canScreenShare?: boolean; isArchived?: boolean; isMember?: boolean; ownerHost?: string | null; noRoom?: boolean; failing?: 'room' | 'membership' } = {}) {
	const owner = overrides.ownerHost != null ? { ...remoteOwner, host: overrides.ownerHost } : { id: 'owner', host: null, uri: null };
	const dbError = new Error('db is down');
	const chatService = {
		checkChatAvailability: vi.fn().mockResolvedValue(undefined),
		findRoomById: overrides.failing === 'room'
			? vi.fn().mockRejectedValue(dbError)
			: vi.fn().mockResolvedValue(overrides.noRoom ? null : { id: 'r1', ownerId: 'owner', owner, isArchived: overrides.isArchived ?? false }),
	};
	// メンバーであることは、ルームを読むのと別に、渡された roomId で引く
	const chatRoomMembershipsRepository = {
		exists: overrides.failing === 'membership' ? vi.fn().mockRejectedValue(dbError) : vi.fn().mockResolvedValue(overrides.isMember ?? true),
	};
	const chatVoiceService = { issueJoinToken: vi.fn().mockResolvedValue({ url: 'https://local.test/livekit', token: 't' }) };
	const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ canVoiceCall: overrides.canVoiceCall ?? true, canScreenShare: overrides.canScreenShare ?? false }) };
	const remoteVoiceCallService = {
		isEnabled: overrides.remoteEnabled ?? true,
		requestJoin: vi.fn().mockResolvedValue({ url: 'https://remote.test/livekit', token: 'remote-jwt' }),
	};
	const endpoint = new JoinEndpoint(chatService as any, chatVoiceService as any, liveKit(overrides.isEnabled ?? true) as any, roleService as any, remoteVoiceCallService as any, chatRoomMembershipsRepository as any);
	return { endpoint, chatService, chatVoiceService, roleService, remoteVoiceCallService, chatRoomMembershipsRepository };
}

describe('chat/rooms/voice/join', () => {
	test('join returns a LiveKit url and token for a room member', async () => {
		const f = joinFixture();
		await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).resolves.toEqual({ url: 'https://local.test/livekit', token: 't' });
		expect(f.chatVoiceService.issueJoinToken).toHaveBeenCalledWith(me, expect.objectContaining({ id: 'r1' }), false);
	});

	test('join passes on the TURN servers and declares them in its response', async () => {
		const f = joinFixture();
		const iceServers = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
		f.chatVoiceService.issueJoinToken.mockResolvedValueOnce({ url: 'https://local.test/livekit', token: 't', iceServers });

		await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).resolves.toEqual({ url: 'https://local.test/livekit', token: 't', iceServers });
		expect(joinMeta.res.properties.iceServers).toMatchObject({
			type: 'array',
			optional: false, nullable: true,
			items: {
				type: 'object',
				properties: {
					urls: { type: 'array', optional: false, nullable: false, items: { type: 'string' } },
					username: { type: 'string', optional: true, nullable: false },
					credential: { type: 'string', optional: true, nullable: false },
				},
			},
		});
	});

	test.each([
		['feature disabled', { isEnabled: false, remoteEnabled: false }],
		['feature disabled here, even if calls on other servers are allowed', { isEnabled: false, remoteEnabled: true }],
		['policy disallows calls', { canVoiceCall: false }],
		['archived room', { isArchived: true }],
	])('join refuses when %s', async (_label, overrides) => {
		const f = joinFixture(overrides);
		await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'VOICE_CALL_UNAVAILABLE' });
		expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
		expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
	});

	// 通話に残れるか (ChatVoiceService の admissionOf) と同じく、削除されたユーザーには発行しない
	test.each([
		['a room on this server', null],
		['a mirror room', 'remote.test'],
	])('join refuses a deleted user for %s', async (_label, ownerHost) => {
		const f = joinFixture({ ownerHost });
		await expect(f.endpoint.exec({ roomId: 'r1' }, { ...me, isDeleted: true }, null, null)).rejects.toMatchObject({ code: 'VOICE_CALL_UNAVAILABLE' });
		expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
		expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
	});

	test('join requires the right to write in chat, since joining lets the user speak', async () => {
		const f = joinFixture();
		f.chatService.checkChatAvailability.mockRejectedValue(new Error('ROLE_PERMISSION_DENIED'));
		await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toThrow();
		expect(f.chatService.checkChatAvailability).toHaveBeenCalledWith('me', 'write');
		expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
	});

	test('join hides rooms the user is not a member of', async () => {
		const f = joinFixture({ isMember: false });
		await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
		expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
	});

	// このサーバーに LiveKit が無いとき、このサーバーのルームについては連合の前と同じ順で断る。
	// メンバーでない人には、ルームがあるかも、他のサーバーのルーム (ミラー) かも分からないようにする
	describe('without a LiveKit on this server, while calls on other servers are allowed', () => {
		test.each([
			['a member of a room on this server', { ownerHost: null }],
			['someone who is not a member of a room on this server', { ownerHost: null, isMember: false }],
			['a room that does not exist', { noRoom: true }],
			['someone who is not a member of a mirror room', { ownerHost: 'remote.test', isMember: false }],
		] as const)('join answers VOICE_CALL_UNAVAILABLE first for %s', async (_label, overrides) => {
			const f = joinFixture({ isEnabled: false, remoteEnabled: true, ...overrides });
			f.chatService.checkChatAvailability.mockRejectedValue(new Error('ROLE_PERMISSION_DENIED'));

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'VOICE_CALL_UNAVAILABLE' });
			expect(f.chatService.checkChatAvailability).not.toHaveBeenCalled();
			expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
			expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
		});

		test('join still requires the right to write in chat for a member of a mirror room', async () => {
			const f = joinFixture({ isEnabled: false, remoteEnabled: true, ownerHost: 'remote.test' });
			f.chatService.checkChatAvailability.mockRejectedValue(new Error('ROLE_PERMISSION_DENIED'));

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toThrow('ROLE_PERMISSION_DENIED');
			expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
		});
	});

	// ルームとメンバーであることは、ルームがあるかどうかに関わらず同じように読む。
	// どちらかが読めなかったときも、ルームがあるかどうかで答えが変わらないようにする
	describe('reading the room and the membership', () => {
		test('join reads the membership by the room id even for a room that does not exist', async () => {
			const f = joinFixture({ noRoom: true });

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
			expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalledWith({ where: { roomId: 'r1', userId: 'me' } });
		});

		test('join reads the room and the membership at the same time', async () => {
			const f = joinFixture();
			let resolveRoom: (room: unknown) => void = () => {};
			f.chatService.findRoomById.mockReturnValueOnce(new Promise(resolve => {
				resolveRoom = resolve;
			}));

			const joining = f.endpoint.exec({ roomId: 'r1' }, me, null, null);
			await vi.waitFor(() => expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalled());
			resolveRoom({ id: 'r1', ownerId: 'owner', owner: { id: 'owner', host: null, uri: null }, isArchived: false });

			await expect(joining).resolves.toEqual({ url: 'https://local.test/livekit', token: 't' });
		});

		test('join lets the owner in without a membership row', async () => {
			const f = joinFixture({ isMember: false });
			f.chatService.findRoomById.mockResolvedValueOnce({ id: 'r1', ownerId: 'me', owner: { id: 'me', host: null, uri: null }, isArchived: false });

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).resolves.toEqual({ url: 'https://local.test/livekit', token: 't' });
		});

		const rooms = [
			['a room that does not exist', { noRoom: true }],
			['a room on this server the user is not a member of', { isMember: false }],
			['a mirror room the user is not a member of', { ownerHost: 'remote.test', isMember: false }],
			['a mirror room the user is a member of', { ownerHost: 'remote.test' }],
		] as const;

		describe.each([
			['the membership', 'membership'],
			['the room', 'room'],
		] as const)('when %s cannot be read', (_label, failing) => {
			test.each(rooms)('join answers VOICE_CALL_UNAVAILABLE for %s without a LiveKit here', async (_room, overrides) => {
				const f = joinFixture({ isEnabled: false, remoteEnabled: true, failing, ...overrides });

				await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'VOICE_CALL_UNAVAILABLE' });
				expect(f.chatService.checkChatAvailability).not.toHaveBeenCalled();
				expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
			});

			test.each(rooms)('join fails the same way for %s with a LiveKit here', async (_room, overrides) => {
				const f = joinFixture({ failing, ...overrides });

				await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toThrow('db is down');
				expect(f.chatService.checkChatAvailability).not.toHaveBeenCalled();
			});
		});
	});

	test('join hides a room that does not exist', async () => {
		const f = joinFixture({ noRoom: true });

		await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
	});

	describe('rooms owned on another server', () => {
		test('join sends mirror rooms to the host and reports REMOTE_HOST_UNSUPPORTED', async () => {
			const f = joinFixture({ ownerHost: 'remote.test', canScreenShare: true });

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'remote-jwt' });
			// 画面共有の希望はこのサーバーのポリシーの値
			expect(f.remoteVoiceCallService.requestJoin).toHaveBeenCalledWith(me, expect.objectContaining({ id: 'r1' }), expect.objectContaining({ id: 'owner', host: 'remote.test' }), true);
			expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();

			f.remoteVoiceCallService.requestJoin.mockRejectedValueOnce(new RemoteVoiceCallError('unsupported'));
			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'REMOTE_HOST_UNSUPPORTED' });
		});

		test('join passes on the TURN servers the host sent, as they are', async () => {
			const f = joinFixture({ ownerHost: 'remote.test' });
			const result = {
				url: 'https://remote.test/livekit',
				token: 'remote-jwt',
				iceServers: [
					{ urls: ['stun:stun.cloudflare.com:3478'] },
					{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
				],
			};
			f.remoteVoiceCallService.requestJoin.mockResolvedValueOnce(result);

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).resolves.toEqual(result);
			expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
		});

		test.each([
			['forbidden', 'VOICE_CALL_UNAVAILABLE'],
			['unreachable', 'REMOTE_HOST_UNREACHABLE'],
		] as const)('join reports a %s host as %s', async (reason, code) => {
			const f = joinFixture({ ownerHost: 'remote.test' });
			f.remoteVoiceCallService.requestJoin.mockRejectedValueOnce(new RemoteVoiceCallError(reason));

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code });
		});

		test('join does not hide unexpected failures of the remote flow', async () => {
			const f = joinFixture({ ownerHost: 'remote.test' });
			f.remoteVoiceCallService.requestJoin.mockRejectedValueOnce(new Error('redis down'));

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toThrow('redis down');
		});

		test('join refuses mirror rooms when remote calls are disabled here', async () => {
			const f = joinFixture({ ownerHost: 'remote.test', remoteEnabled: false });

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'VOICE_CALL_UNAVAILABLE' });
			expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
			expect(f.chatVoiceService.issueJoinToken).not.toHaveBeenCalled();
		});

		test('join sends mirror rooms to the host even without a local LiveKit', async () => {
			const f = joinFixture({ ownerHost: 'remote.test', isEnabled: false });

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).resolves.toEqual({ url: 'https://remote.test/livekit', token: 'remote-jwt' });
		});

		test.each([
			['policy disallows calls', { canVoiceCall: false }, 'VOICE_CALL_UNAVAILABLE'],
			['archived room', { isArchived: true }, 'VOICE_CALL_UNAVAILABLE'],
			['not a member', { isMember: false }, 'NO_SUCH_ROOM'],
		] as const)('join keeps the local checks for mirror rooms: %s', async (_label, overrides, code) => {
			const f = joinFixture({ ownerHost: 'remote.test', ...overrides });

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code });
			expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
		});

		test('join requires the right to write in chat for mirror rooms too', async () => {
			const f = joinFixture({ ownerHost: 'remote.test' });
			f.chatService.checkChatAvailability.mockRejectedValue(new Error('ROLE_PERMISSION_DENIED'));

			await expect(f.endpoint.exec({ roomId: 'r1' }, me, null, null)).rejects.toThrow();
			expect(f.chatService.checkChatAvailability).toHaveBeenCalledWith('me', 'write');
			expect(f.remoteVoiceCallService.requestJoin).not.toHaveBeenCalled();
		});
	});
});

function statesFixture(isEnabled = true, remoteEnabled = false) {
	const chatRoomsRepository = { findBy: vi.fn().mockResolvedValue([]) };
	// me は r1 (このサーバーのルーム) と m1 (他のサーバーが持つルーム = ミラー) のメンバー。
	// where にルームの持ち主の条件があれば、それも当てる
	const memberships = [{ roomId: 'r1', userId: 'me', ownerHost: null }, { roomId: 'm1', userId: 'me', ownerHost: 'remote.test' }];
	const chatRoomMembershipsRepository = {
		findBy: vi.fn(async (where: { roomId: FindOperator<string[]>; room?: { owner?: { host?: unknown } } }) => memberships
			.filter(membership => (where.roomId.value as string[]).includes(membership.roomId))
			.filter(membership => {
				const host = where.room?.owner?.host;
				if (host == null) return true;
				if (host instanceof FindOperator && host.type === 'isNull') return membership.ownerHost == null;
				throw new Error('unsupported condition');
			})
			.map(({ roomId, userId }) => ({ roomId, userId }))),
	};
	const chatService = { checkChatAvailability: vi.fn().mockResolvedValue(undefined) };
	const chatVoiceService = { getStates: vi.fn().mockResolvedValue([]) };
	const remoteVoiceCallService = { isEnabled: remoteEnabled };
	const endpoint = new StatesEndpoint(chatRoomsRepository as any, chatRoomMembershipsRepository as any, chatService as any, chatVoiceService as any, liveKit(isEnabled) as any, remoteVoiceCallService as any);
	return { endpoint, chatVoiceService };
}

describe('chat/rooms/voice/states', () => {
	test('states returns nothing when voice calls are disabled', async () => {
		const f = statesFixture(false, false);
		await expect(f.endpoint.exec({ roomIds: ['r1'] }, me, null, null)).resolves.toEqual([]);
		expect(f.chatVoiceService.getStates).not.toHaveBeenCalled();
	});

	test('states works for mirror rooms even without a local LiveKit', async () => {
		const f = statesFixture(false, true);
		await f.endpoint.exec({ roomIds: ['r1', 'm1', 'r2'] }, me, null, null);
		expect(f.chatVoiceService.getStates).toHaveBeenCalledWith(me, ['r1', 'm1']);
	});

	test('states only asks for rooms the user belongs to', async () => {
		const f = statesFixture(true, true);
		await f.endpoint.exec({ roomIds: ['r1', 'm1', 'r2'] }, me, null, null);
		expect(f.chatVoiceService.getStates).toHaveBeenCalledWith(me, ['r1', 'm1']);
	});

	// 他のサーバーの通話に入らないあいだは、ミラーの現況を (寿命が切れる前でも) 見せない
	test('states leaves out mirror rooms while calls on other servers are disabled', async () => {
		const f = statesFixture(true, false);
		await f.endpoint.exec({ roomIds: ['r1', 'm1', 'r2'] }, me, null, null);
		expect(f.chatVoiceService.getStates).toHaveBeenCalledWith(me, ['r1']);
	});
});

function moderationFixture(Endpoint: typeof KickEndpoint | typeof MuteEndpoint, overrides: { ownerId?: string; room?: unknown; user?: unknown; isEnabled?: boolean } = {}) {
	const usersRepository = { findOneBy: vi.fn().mockResolvedValue('user' in overrides ? overrides.user : { id: 'u2', host: null, uri: null }) };
	const chatService = {
		checkChatAvailability: vi.fn().mockResolvedValue(undefined),
		findRoomById: vi.fn().mockResolvedValue('room' in overrides ? overrides.room : { id: 'r1', ownerId: overrides.ownerId ?? 'me' }),
	};
	const liveKitService = liveKit(overrides.isEnabled ?? true);
	const endpoint = Endpoint === MuteEndpoint
		? new MuteEndpoint(usersRepository as any, chatService as any, liveKitService as any, { refresh: vi.fn() } as any)
		: new KickEndpoint(usersRepository as any, chatService as any, liveKitService as any);
	return { endpoint, liveKitService, chatService };
}

describe('chat/rooms/voice/kick and mute', () => {
	test('kick removes the participant identity of the target user', async () => {
		const f = moderationFixture(KickEndpoint);
		await f.endpoint.exec({ roomId: 'r1', userId: 'u2' }, me, null, null);
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('r1', 'https://local.test/users/u2');
	});

	test('kick is only for the room owner', async () => {
		const f = moderationFixture(KickEndpoint, { ownerId: 'someone-else' });
		await expect(f.endpoint.exec({ roomId: 'r1', userId: 'u2' }, me, null, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(f.liveKitService.removeParticipant).not.toHaveBeenCalled();
	});

	test('mute mutes the microphone of the target user', async () => {
		const f = moderationFixture(MuteEndpoint);
		await f.endpoint.exec({ roomId: 'r1', userId: 'u2' }, me, null, null);
		expect(f.liveKitService.muteMicrophone).toHaveBeenCalledWith('r1', 'https://local.test/users/u2');
	});

	test('mute is only for the room owner', async () => {
		const f = moderationFixture(MuteEndpoint, { ownerId: 'someone-else' });
		await expect(f.endpoint.exec({ roomId: 'r1', userId: 'u2' }, me, null, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(f.liveKitService.muteMicrophone).not.toHaveBeenCalled();
	});
});

function chatServiceFixture() {
	const liveKitService = liveKit();
	const room = { id: 'r1', ownerId: 'owner', owner: { id: 'owner', host: null, uri: null } };
	const service = Object.assign(Object.create(ChatService.prototype), {
		liveKitService,
		globalEventService: { publishChatRoomStream: vi.fn() },
		chatRoomMembershipsRepository: {
			findOneByOrFail: vi.fn().mockResolvedValue({ id: 'm1', roomId: 'r1', userId: 'u1' }),
			findBy: vi.fn().mockResolvedValue([]),
			delete: vi.fn().mockResolvedValue({ affected: 1 }),
		},
		chatRoomsRepository: {
			findOne: vi.fn().mockResolvedValue(room),
			delete: vi.fn().mockResolvedValue({ affected: 1 }),
		},
		usersRepository: {
			findOneByOrFail: vi.fn().mockResolvedValue({ id: 'u1', host: null, uri: null }),
			findBy: vi.fn().mockResolvedValue([]),
		},
		redisClient: { pipeline: () => ({ del: vi.fn(), srem: vi.fn(), exec: vi.fn().mockResolvedValue([]) }) },
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
		},
	});
	return { service, liveKitService, room };
}

describe.each([
	['kick', KickEndpoint, 'removeParticipant'],
	['mute', MuteEndpoint, 'muteMicrophone'],
] as const)('chat/rooms/voice/%s error paths', (_name, Endpoint, action) => {
	test.each([
		['NO_SUCH_ROOM', { room: null }],
		['NO_SUCH_USER', { user: null }],
		['VOICE_CALL_UNAVAILABLE', { isEnabled: false }],
	] as const)('answers %s', async (code, overrides) => {
		const f = moderationFixture(Endpoint, overrides);
		await expect(f.endpoint.exec({ roomId: 'r1', userId: 'u2' }, me, null, null)).rejects.toMatchObject({ code });
		expect(f.liveKitService[action]).not.toHaveBeenCalled();
	});

	test('requires the right to write in chat', async () => {
		const f = moderationFixture(Endpoint);
		f.chatService.checkChatAvailability.mockRejectedValue(new Error('ROLE_PERMISSION_DENIED'));
		await expect(f.endpoint.exec({ roomId: 'r1', userId: 'u2' }, me, null, null)).rejects.toThrow();
		expect(f.chatService.checkChatAvailability).toHaveBeenCalledWith('me', 'write');
		expect(f.liveKitService[action]).not.toHaveBeenCalled();
	});
});

test('every voice endpoint error has its own UUID', () => {
	const ids = [joinMeta, kickMeta, muteMeta].flatMap(meta => Object.values(meta.errors).map(error => error.id as string));
	for (const id of ids) {
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	}
	expect(new Set(ids).size).toBe(ids.length);
});

describe('ChatService room control publication', () => {
	test('leave publishes membershipEnded only after membership deletion succeeds', async () => {
		const f = chatServiceFixture();
		const publish = f.service.globalEventService.publishChatRoomStream;
		f.service.chatRoomMembershipsRepository.delete.mockImplementation(async () => {
			expect(publish).not.toHaveBeenCalled();
			return { affected: 1 };
		});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await f.service.leaveRoom('u1', 'r1');
		log.mockRestore();
		expect(publish).toHaveBeenCalledExactlyOnceWith('r1', 'membershipEnded', { userId: 'u1' });
	});

	test('failed membership deletion never publishes a control event', async () => {
		const f = chatServiceFixture();
		f.service.chatRoomMembershipsRepository.delete.mockRejectedValue(new Error('db'));
		await expect(f.service.leaveRoom('u1', 'r1')).rejects.toThrow('db');
		expect(f.service.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
	});

	test('room deletion publishes roomDeleted only after deletion succeeds', async () => {
		const f = chatServiceFixture();
		const publish = f.service.globalEventService.publishChatRoomStream;
		f.service.chatRoomsRepository.delete.mockImplementation(async () => {
			expect(publish).not.toHaveBeenCalled();
			return { affected: 1 };
		});
		await f.service.deleteRoom(f.room);
		expect(publish).toHaveBeenCalledExactlyOnceWith('r1', 'roomDeleted');
	});

	test('failed room deletion never publishes a control event', async () => {
		const f = chatServiceFixture();
		f.service.chatRoomsRepository.delete.mockRejectedValue(new Error('db'));
		await expect(f.service.deleteRoom(f.room)).rejects.toThrow('db');
		expect(f.service.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
	});
});

describe('ChatService voice cleanup', () => {
	test('leaving a room removes the user from its call', async () => {
		const f = chatServiceFixture();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await f.service.leaveRoom('u1', 'r1');
		log.mockRestore();
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('r1', 'https://local.test/users/u1');
	});

	test('deleting a room ends its call', async () => {
		const f = chatServiceFixture();
		await f.service.deleteRoom(f.room);
		expect(f.liveKitService.deleteRoom).toHaveBeenCalledWith('r1');
	});
});

describe('meta features', () => {
	test.each([true, false])('reports voice call availability (%s)', async isEnabled => {
		const service = Object.assign(Object.create(MetaEntityService.prototype), {
			meta: { rootUserId: 'root' },
			systemAccountService: { fetch: async () => ({ username: 'proxy' }) },
			liveKitService: { isEnabled },
		});
		Object.defineProperty(service, 'pack', { value: async () => ({}) });
		const packed = await service.packDetailed({ policies: { ltlAvailable: true, gtlAvailable: true } } as any);
		expect(packed.features.voiceCall).toBe(isEnabled);
	});
});
