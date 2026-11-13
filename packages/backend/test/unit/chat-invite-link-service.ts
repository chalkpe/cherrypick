/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import {
	ChatInviteInvalidUrlError,
	ChatInviteJoinRefusedError,
	ChatInviteLinkService,
	ChatInviteRemoteUnavailableError,
} from '@/core/ChatInviteLinkService.js';
import { ChatRoomArchivedError } from '@/core/ChatService.js';
import { ChatRoomIconEntityService } from '@/core/entities/ChatRoomIconEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { renderChatJoinReject } from '@/core/chat-invite-link.js';
import { StatusError } from '@/misc/status-error.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';

const code = 'Ab3dEf6hIj9lMn0p';
const otherCode = 'Zz9yXx8wVv7uTt6s';
const inviteUrl = `https://a.example/chat/invite/${code}`;
const otherInviteUrl = `https://a.example/chat/invite/${otherCode}`;
const roomUri = 'https://a.example/chat/rooms/room1';
const user = { id: 'u1', host: null } as MiLocalUser;
const userUri = 'https://b.example/users/u1';
const groupServer = { id: 'actorA', host: 'a.example', uri: 'https://a.example/users/instance', inbox: 'https://a.example/users/instance/inbox' } as MiRemoteUser;

type Stored = { value: string; ttl: number | null };

/** EX·KEEPTTL·XX·GETDEL만 흉내 내는 Redis. 만료는 expire()로 직접 일으킨다 */
function memoryRedis() {
	const store = new Map<string, Stored>();
	const client = {
		store,
		async get(key: string) {
			return store.get(key)?.value ?? null;
		},
		async set(key: string, value: string, ...args: (string | number)[]) {
			if (args[0] === 'PX' && args[2] === 'NX') {
				if (store.has(key)) return null;
				store.set(key, { value, ttl: Number(args[1]) / 1000 });
				return 'OK';
			}
			if (args[0] === 'EX') {
				store.set(key, { value, ttl: Number(args[1]) });
				return 'OK';
			}
			if (args[0] === 'KEEPTTL') {
				const current = store.get(key);
				if (args[1] === 'XX' && current == null) return null;
				store.set(key, { value, ttl: current?.ttl ?? null });
				return 'OK';
			}
			store.set(key, { value, ttl: null });
			return 'OK';
		},
		async getdel(key: string) {
			const value = store.get(key)?.value ?? null;
			store.delete(key);
			return value;
		},
		async del(key: string) {
			return store.delete(key) ? 1 : 0;
		},
		multi() {
			const ops: [string, string, ...(string | number)[]][] = [];
			const chain = {
				set: (...args: [string, string, ...(string | number)[]]) => {
					ops.push(args);
					return chain;
				},
				exec: async () => {
					for (const [key, value, ...rest] of ops) await client.set(key, value, ...rest);
					return [];
				},
			};
			return chain;
		},
		expireAll() {
			store.clear();
		},
	};
	return client;
}

function previewDoc(overrides: Record<string, unknown> = {}) {
	return {
		id: inviteUrl,
		type: 'Invite',
		object: { id: roomUri, type: 'Group', name: '모임', summary: '', _misskey_chatArchived: false, _misskey_chatRoomMembersCount: 3 },
		endpoints: { sharedInbox: 'https://a.example/inbox' },
		...overrides,
	};
}

// 멤버십 행마다 새 ID를 준다. 같은 사람이 나갔다가 다시 들어오면 다른 멤버십이다
class MembershipRows extends Set<string> {
	private seq = 0;
	readonly ids = new Map<string, string>();

	override add(userId: string) {
		if (!this.has(userId)) this.ids?.set(userId, `membership${++this.seq}`);
		return super.add(userId);
	}

	override delete(userId: string) {
		this.ids.delete(userId);
		return super.delete(userId);
	}
}

function createFixture(options: { baseUrl?: string; mirror?: boolean } = {}) {
	const baseUrl = options.baseUrl ?? 'https://b.example';
	const redis = memoryRedis();
	const deliver = vi.fn();
	const publishMainStream = vi.fn();
	const membership = new MembershipRows();
	const joinToRoom = vi.fn(async (userId: string) => {
		membership.add(userId);
	});
	const isRoomMember = vi.fn(async (_room: unknown, userId: string) => membership.has(userId));
	const signedGetJson = vi.fn(async (_actor: unknown, url: string): Promise<unknown> => previewDoc({ id: url }));
	const isRefusedRemoteHost = vi.fn(async () => false);
	const mirror = { id: 'mirror1', uri: roomUri, ownerId: 'ownerA' };
	const config = { url: baseUrl, host: new URL(baseUrl).host, mediaProxy: `${baseUrl}/proxy` };
	const avatar = Object.assign(Object.create(AvatarDecorationService.prototype), { config }) as AvatarDecorationService;
	const icons = Object.assign(Object.create(ChatRoomIconEntityService.prototype), {
		config, userEntityService: Object.assign(Object.create(UserEntityService.prototype), { config }), avatarDecorationService: avatar,
	}) as ChatRoomIconEntityService;
	let seq = 0;

	const service = Object.assign(Object.create(ChatInviteLinkService.prototype), {
		config,
		redisClient: redis,
		chatRoomsRepository: {
			findOneBy: vi.fn(async (where: { uri?: string; id?: string }) => (options.mirror !== false && (where.uri === roomUri || where.id === mirror.id)) ? mirror : null),
		},
		chatRoomInviteLinksRepository: { findOneBy: vi.fn(async () => null) },
		chatRoomInvitationsRepository: { existsBy: vi.fn(async () => false) },
		chatRoomMembershipsRepository: { findOneBy: vi.fn(async (where: { userId: string }) => membership.ids.has(where.userId) ? { id: membership.ids.get(where.userId) } : null) },
		idService: { gen: () => `id${++seq}`, parse: () => ({ date: new Date('2026-11-13T00:00:00.000Z') }) },
		userEntityService: { genLocalUserUri: (id: string) => `${baseUrl}/users/${id}`, isLocalUser: (u: { host: string | null }) => u.host == null },
		chatRoomIconEntityService: icons,
		avatarDecorationService: avatar,
		apRendererService: { addContext: <T extends object>(x: T) => ({ '@context': 'context', ...x }) },
		apRequestService: { signedGetJson },
		queueService: { deliver },
		systemAccountService: { fetch: async () => ({ id: 'instance', host: null }) },
		hostPolicyService: { isRefusedRemoteHost },
		globalEventService: { publishMainStream },
		chatService: { joinToRoom, isRoomMember },
		logger: { info: vi.fn(), warn: vi.fn() },
	}) as ChatInviteLinkService;

	const sentJoins = () => deliver.mock.calls.filter(([, activity]) => (activity as { type: string }).type === 'Join').map(([, activity]) => activity as { id: string; actor: string; object: string });
	const reject = (join: { id: string; actor: string; object: string }, reason: 'revoked' | 'archived' | 'banned' | 'blocked' | 'full', signer = groupServer.uri) => ({
		...renderChatJoinReject({ actor: signer, join, reason, published: new Date().toISOString() }),
		id: 'https://a.example/activities/reject',
	});

	return { service, redis, deliver, publishMainStream, membership, joinToRoom, isRoomMember, signedGetJson, isRefusedRemoteHost, mirror, sentJoins, reject };
}

describe('사본 서버의 참여 요청', () => {
	test('원격 카드는 공개 정보만 내보내고 그룹 URI·받은편지함·보관 상태를 응답에 섞지 않는다', async () => {
		const { service } = createFixture();

		const summary = await service.summarize(inviteUrl);

		expect(summary).not.toBeNull();
		expect(Object.keys(summary!.chatInvite).sort()).toEqual(['code', 'description', 'host', 'iconBlurhash', 'iconDecorations', 'iconUrl', 'isLocal', 'membersCount', 'name', 'url']);
	});

	test('의사를 기록한 뒤 새로 받은 미리보기의 받은편지함으로 서명된 Join을 보낸다', async () => {
		const { service, deliver, signedGetJson, sentJoins } = createFixture();

		const result = await service.join(user, inviteUrl);

		expect(result).toEqual({ status: 'pending', roomId: null });
		expect(signedGetJson).toHaveBeenCalledWith({ id: 'instance', host: null }, inviteUrl, 10_000, { redirect: 'manual', size: 64 * 1024 });
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver.mock.calls[0][0]).toBe(user);
		expect(deliver.mock.calls[0][2]).toBe('https://a.example/inbox');
		expect(sentJoins()[0]).toMatchObject({ type: 'Join', actor: userUri, object: inviteUrl });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'pending', roomId: null, reason: null });
	});

	test('대기 중에 다시 눌러도 새 Join을 보내지 않는다', async () => {
		const { service, signedGetJson, sentJoins } = createFixture();

		await service.join(user, inviteUrl);
		const again = await service.join(user, inviteUrl);

		expect(again).toEqual({ status: 'pending', roomId: null });
		expect(signedGetJson).toHaveBeenCalledTimes(1);
		expect(sentJoins()).toHaveLength(1);
	});

	test('같은 계정의 동시 참여 요청도 하나의 Join과 대기 기록을 공유한다', async () => {
		const { service, sentJoins } = createFixture();

		const results = await Promise.all([service.join(user, inviteUrl), service.join(user, inviteUrl)]);

		expect(results).toEqual([{ status: 'pending', roomId: null }, { status: 'pending', roomId: null }]);
		expect(sentJoins()).toHaveLength(1);
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'pending', roomId: null, reason: null });
	});

	test('발급 서버가 없는 링크라고 답하면 폐기 사유로 거절하고 Join을 보내지 않는다', async () => {
		const { service, signedGetJson, deliver } = createFixture();
		signedGetJson.mockRejectedValueOnce(new StatusError('404 Not Found', 404, 'Not Found'));

		await expect(service.join(user, inviteUrl)).rejects.toMatchObject({ constructor: ChatInviteJoinRefusedError, reason: 'revoked' });
		expect(deliver).not.toHaveBeenCalled();
	});

	test.each([
		['다른 호스트의 받은편지함', previewDoc({ endpoints: { sharedInbox: 'https://evil.example/inbox' } })],
		['다른 호스트의 그룹', previewDoc({ object: { id: 'https://evil.example/chat/rooms/room1', type: 'Group', name: '모임', _misskey_chatRoomMembersCount: 1 } })],
		['미지원 서버의 HTML', '<html></html>'],
	])('%s를 적은 미리보기면 일반 링크로 다루고 Join을 보내지 않는다', async (_, doc) => {
		const { service, signedGetJson, deliver } = createFixture();
		signedGetJson.mockResolvedValueOnce(doc);

		await expect(service.join(user, inviteUrl)).rejects.toBeInstanceOf(ChatInviteRemoteUnavailableError);
		expect(deliver).not.toHaveBeenCalled();
	});

	test('연합을 거부한 서버에는 미리보기 조회도 하지 않는다', async () => {
		const { service, signedGetJson, isRefusedRemoteHost } = createFixture();
		isRefusedRemoteHost.mockResolvedValueOnce(true);

		await expect(service.join(user, inviteUrl)).rejects.toBeInstanceOf(ChatInviteRemoteUnavailableError);
		expect(signedGetJson).not.toHaveBeenCalled();
	});

	test('이미 사본의 멤버면 Join 없이 그 그룹을 연다', async () => {
		const { service, membership, deliver } = createFixture();
		membership.add(user.id);

		expect(await service.join(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1' });
		expect(deliver).not.toHaveBeenCalled();
	});

	test('이미 멤버라고 답한 참여 요청은 이어지는 상태 조회에도 같은 멤버십을 알린다', async () => {
		const { service, membership } = createFixture();
		membership.add(user.id);

		expect(await service.join(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1' });

		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1', reason: null });
	});

	test.each([
		['http 주소', `http://a.example/chat/invite/${code}`],
		['쿼리가 붙은 주소', `${inviteUrl}?x=1`],
		['다른 경로', 'https://a.example/notes/abc'],
	])('%s는 초대 주소가 아니다', async (_, url) => {
		const { service } = createFixture();

		await expect(service.join(user, url)).rejects.toBeInstanceOf(ChatInviteInvalidUrlError);
	});
});

describe('사본 서버가 받은 거절', () => {
	test('보낸 Join에 대한 발급 서버의 거절이면 사유를 남기고 알린다', async () => {
		const { service, sentJoins, reject, publishMainStream, joinToRoom } = createFixture();
		await service.join(user, inviteUrl);

		const result = await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'banned'));

		expect(result).toBe('ok: Join refused (banned)');
		expect(publishMainStream).toHaveBeenCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'refused', roomId: null, reason: 'banned' });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'refused', roomId: null, reason: 'banned' });
		expect(joinToRoom).not.toHaveBeenCalled();
	});

	test('만료 뒤 다시 보낸 Join이 있으면 예전 Join에 대한 늦은 거절은 무시한다', async () => {
		const { service, redis, sentJoins, reject, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		const oldJoin = sentJoins()[0];
		redis.expireAll();
		await service.join(user, inviteUrl);

		const result = await service.receiveJoinReject(groupServer, reject(oldJoin, 'full'));

		expect(result).toMatch(/^skip:/);
		expect(publishMainStream).not.toHaveBeenCalled();
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'pending', roomId: null, reason: null });
	});

	test('같은 그룹에 다른 코드로 다시 요청했으면 예전 코드의 거절과 상태를 쓰지 않는다', async () => {
		const { service, sentJoins, reject, signedGetJson } = createFixture();
		await service.join(user, inviteUrl);
		const oldJoin = sentJoins()[0];
		await service.receiveJoinReject(groupServer, reject(oldJoin, 'revoked'));
		signedGetJson.mockResolvedValueOnce(previewDoc({ id: otherInviteUrl }));
		await service.join(user, otherInviteUrl);

		const late = await service.receiveJoinReject(groupServer, reject(oldJoin, 'revoked'));

		expect(late).toMatch(/^skip:/);
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'none', roomId: null, reason: null });
		expect(await service.joinStatus(user, otherInviteUrl)).toEqual({ status: 'pending', roomId: null, reason: null });
	});

	test('발급 서버가 아닌 곳이 서명한 거절은 받지 않는다', async () => {
		const { service, sentJoins, reject, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		const forger = { ...groupServer, host: 'evil.example', uri: 'https://evil.example/users/x' } as MiRemoteUser;

		const result = await service.receiveJoinReject(forger, reject(sentJoins()[0], 'banned', forger.uri));

		expect(result).toMatch(/^skip:/);
		expect(publishMainStream).not.toHaveBeenCalled();
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'pending', roomId: null, reason: null });
	});

	test('자동 수락 뒤의 거절은 상태만 바꾸고 멤버십은 그룹 서버의 Remove에 맡긴다', async () => {
		const { service, sentJoins, reject, membership, mirror, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		await service.acceptAwaitedInvite(user, mirror as never, roomUri);

		await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'full'));

		expect(membership.has(user.id)).toBe(true);
		expect(publishMainStream).toHaveBeenLastCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'refused', roomId: null, reason: 'full' });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'refused', roomId: null, reason: 'full' });
	});

	test('그 사이 다른 경로로 멤버가 됐으면 거절이 와도 그 멤버십을 참여로 알린다', async () => {
		const { service, sentJoins, reject, membership, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		membership.add(user.id);

		await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'full'));

		expect(membership.has(user.id)).toBe(true);
		expect(publishMainStream).toHaveBeenLastCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'joined', roomId: 'mirror1', reason: null });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1', reason: null });
	});

	test('자동 수락 기록 뒤 개별 초대로 재가입한 현재 멤버는 예전 Join 거절에 가려지지 않는다', async () => {
		const { service, sentJoins, reject, membership, mirror, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		const oldJoin = sentJoins()[0];
		await service.acceptAwaitedInvite(user, mirror as never, roomUri);
		membership.delete(user.id);
		membership.add(user.id);

		await service.receiveJoinReject(groupServer, reject(oldJoin, 'full'));

		expect(membership.has(user.id)).toBe(true);
		expect(publishMainStream).toHaveBeenLastCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'joined', roomId: mirror.id, reason: null });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: mirror.id, reason: null });
	});

	test('자동 수락에 실패한 뒤 다른 경로로 가입한 멤버도 예전 Join 거절에 가려지지 않는다', async () => {
		const { service, sentJoins, reject, membership, mirror, joinToRoom, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		joinToRoom.mockRejectedValueOnce(new ChatRoomArchivedError('room is archived'));
		await service.acceptAwaitedInvite(user, mirror as never, roomUri);
		membership.add(user.id);

		await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'archived'));

		expect(publishMainStream).toHaveBeenLastCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'joined', roomId: mirror.id, reason: null });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: mirror.id, reason: null });
	});

	test('대기 중 다른 경로로 이미 멤버가 되었다면 다시 참여해도 대기로 돌아가지 않는다', async () => {
		const { service, membership, sentJoins } = createFixture();
		await service.join(user, inviteUrl);
		membership.add(user.id);

		expect(await service.join(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1' });
		expect(sentJoins()).toHaveLength(1);
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1', reason: null });
	});

	test('대기 중 개별 초대를 자동 수락한 멤버는 다시 참여해도 대기로 돌아가지 않는다', async () => {
		const { service, mirror, sentJoins } = createFixture();
		await service.join(user, inviteUrl);
		// 대기 중 받은 개별 초대는 멤버십만 만들지 않고 기존 참여 의사도 함께 갱신한다.
		expect(await service.acceptAwaitedInvite(user, mirror as never, roomUri)).toBe('joined');

		expect(await service.join(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1' });
		expect(sentJoins()).toHaveLength(1);
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1', reason: null });
	});

	test('같은 거절이 두 번 와도 한 번만 처리한다', async () => {
		const { service, sentJoins, reject, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);

		await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'full'));
		const again = await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'full'));

		expect(again).toMatch(/^skip:/);
		expect(publishMainStream).toHaveBeenCalledTimes(1);
	});
});

describe('사본 서버가 받은 초대', () => {
	test('참여를 요청하지 않은 그룹의 초대는 자동으로 수락하지 않는다', async () => {
		const { service, mirror, joinToRoom } = createFixture();

		expect(await service.acceptAwaitedInvite(user, mirror as never, roomUri)).toBe('none');
		expect(await service.isAwaitingInvite(user.id, roomUri)).toBe(false);
		expect(joinToRoom).not.toHaveBeenCalled();
	});

	test('요청한 그룹의 초대는 기존 수락 경로로 수락하고 알린다', async () => {
		const { service, mirror, joinToRoom, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);

		expect(await service.isAwaitingInvite(user.id, roomUri)).toBe(true);
		expect(await service.acceptAwaitedInvite(user, mirror as never, roomUri)).toBe('joined');
		expect(joinToRoom).toHaveBeenCalledWith(user.id, 'mirror1');
		expect(publishMainStream).toHaveBeenCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'joined', roomId: 'mirror1', reason: null });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'joined', roomId: 'mirror1', reason: null });
	});

	test('거절된 뒤에 온 초대는 보통의 초대로 남긴다', async () => {
		const { service, mirror, joinToRoom, sentJoins, reject } = createFixture();
		await service.join(user, inviteUrl);
		await service.receiveJoinReject(groupServer, reject(sentJoins()[0], 'full'));

		expect(await service.isAwaitingInvite(user.id, roomUri)).toBe(false);
		expect(await service.acceptAwaitedInvite(user, mirror as never, roomUri)).toBe('none');
		expect(joinToRoom).not.toHaveBeenCalled();
	});

	test('유효 시간이 지난 뒤 온 초대는 자동으로 수락하지 않는다', async () => {
		const { service, redis, mirror, joinToRoom } = createFixture();
		await service.join(user, inviteUrl);
		redis.expireAll();

		expect(await service.acceptAwaitedInvite(user, mirror as never, roomUri)).toBe('none');
		expect(joinToRoom).not.toHaveBeenCalled();
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'none', roomId: null, reason: null });
	});

	test('자동 수락이 실패하면 보통의 초대로 남았다고 알린다', async () => {
		const { service, mirror, joinToRoom, publishMainStream } = createFixture();
		await service.join(user, inviteUrl);
		joinToRoom.mockRejectedValueOnce(new ChatRoomArchivedError('room is archived'));

		expect(await service.acceptAwaitedInvite(user, mirror as never, roomUri)).toBe('invited');
		expect(publishMainStream).toHaveBeenCalledWith(user.id, 'chatInviteJoinResult', { url: inviteUrl, status: 'invited', roomId: 'mirror1', reason: null });
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'invited', roomId: 'mirror1', reason: null });
	});

	test('예상하지 못한 오류는 inbox가 다시 시도하도록 그대로 던진다', async () => {
		const { service, mirror, joinToRoom } = createFixture();
		await service.join(user, inviteUrl);
		joinToRoom.mockRejectedValueOnce(new Error('database is down'));

		await expect(service.acceptAwaitedInvite(user, mirror as never, roomUri)).rejects.toThrow('database is down');
		expect(await service.joinStatus(user, inviteUrl)).toEqual({ status: 'pending', roomId: null, reason: null });
	});
});

describe('그룹 서버가 받은 Join', () => {
	const joiner = { id: 'r1', host: 'b.example', uri: userUri, inbox: 'https://b.example/users/u1/inbox' } as MiRemoteUser;
	const join = { id: 'https://b.example/activities/join1', type: 'Join', actor: userUri, object: inviteUrl };

	test.each([
		['다른 서버의 Join id', { ...join, id: 'https://evil.example/activities/join1' }],
		['다른 actor', { ...join, actor: 'https://b.example/users/u2' }],
		['다른 서버의 초대 주소', { ...join, object: `https://c.example/chat/invite/${code}` }],
		['초대 주소가 아님', { ...join, object: 'https://a.example/chat/rooms/room1' }],
	])('%s이면 아무것도 보내지 않는다', async (_, activity) => {
		const { service, deliver } = createFixture({ baseUrl: 'https://a.example' });

		expect(await service.receiveJoin(joiner, activity)).toMatch(/^skip:/);
		expect(deliver).not.toHaveBeenCalled();
	});

	test('없는 코드면 대표 계정이 서명한 폐기 사유의 거절을 보낸다', async () => {
		const { service, deliver } = createFixture({ baseUrl: 'https://a.example' });

		expect(await service.receiveJoin(joiner, join)).toBe('ok: Join refused (revoked)');
		expect(deliver).toHaveBeenCalledTimes(1);
		const [signer, activity, inbox] = deliver.mock.calls[0];
		expect(signer).toEqual({ id: 'instance', host: null });
		expect(inbox).toBe(joiner.inbox);
		expect(activity).toMatchObject({
			type: 'Reject',
			actor: 'https://a.example/users/instance',
			object: { type: 'Join', id: join.id, actor: userUri, object: inviteUrl },
			_misskey_chatJoinRefusal: 'revoked',
		});
	});

	test('Join에 답한 초대의 Accept를 받아들이지 못하면 그 Join에 사유를 알린다', async () => {
		const { service, redis, deliver } = createFixture({ baseUrl: 'https://a.example' });
		await redis.set('chatInviteJoinInvitation:room1:r1', JSON.stringify({ joinId: join.id, url: inviteUrl, actor: userUri }), 'EX', 1800);

		await service.refuseAcceptedJoin({ id: 'room1' } as never, joiner, 'full');
		await service.refuseAcceptedJoin({ id: 'room1' } as never, joiner, 'full');

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver.mock.calls[0][1]).toMatchObject({ type: 'Reject', object: { id: join.id }, _misskey_chatJoinRefusal: 'full' });
	});

	test('개별 초대의 Accept 실패에는 Join 거절을 보내지 않는다', async () => {
		const { service, deliver } = createFixture({ baseUrl: 'https://a.example' });

		await service.refuseAcceptedJoin({ id: 'room1' } as never, joiner, 'full');

		expect(deliver).not.toHaveBeenCalled();
	});
});

describe('같은 서버 그룹의 참여', () => {
	const owner = { id: 'owner1', host: null };
	const joiner = { id: 'u2', host: null } as MiLocalUser;
	const room = { id: 'room1', ownerId: owner.id, isArchived: false, name: '모임', description: null };
	const link = { id: 'link1', roomId: room.id, code };
	const localUrl = `https://a.example/chat/invite/${code}`;

	type Options = { archived?: boolean; members?: number; member?: boolean; blockedByOwner?: boolean; banned?: boolean; revokedUnderLock?: boolean; invitation?: boolean };

	function localFixture(options: Options = {}) {
		const base = createFixture({ baseUrl: 'https://a.example' });
		const inserted: { entity: string; row: Record<string, unknown> }[] = [];
		const deleted: { entity: string; where: Record<string, unknown> }[] = [];
		const order: string[] = [];
		const recordAccepted = vi.fn(async (_roomId: string, _userId: string, _at: Date, manager: unknown) => {
			order.push(manager === tx ? 'recordAccepted in transaction' : 'recordAccepted outside');
		});
		const tx = {
			findOne: vi.fn(async (_entity: unknown, query: { lock?: unknown }) => {
				order.push(query.lock != null ? 'lock room' : 'read room');
				return { ...room, isArchived: options.archived === true };
			}),
			existsBy: vi.fn(async (entity: { name: string }, where: Record<string, unknown>) => {
				if (entity.name === 'MiChatRoomInviteLink') return options.revokedUnderLock !== true && where.code === code;
				if (entity.name === 'MiBlocking') return options.blockedByOwner === true && where.blockerId === owner.id && where.blockeeId === joiner.id;
				return options.member === true && where.userId === joiner.id;
			}),
			countBy: vi.fn(async () => options.members ?? 1),
			insert: vi.fn(async (entity: { name: string }, row: Record<string, unknown>) => {
				order.push(`insert ${entity.name}`);
				inserted.push({ entity: entity.name, row });
			}),
			delete: vi.fn(async (entity: { name: string }, where: Record<string, unknown>) => {
				deleted.push({ entity: entity.name, where });
				return { affected: options.invitation === true ? 1 : 0 };
			}),
		};
		// 금지는 그룹을 잠근 같은 트랜잭션에서 물어야 내보내기와 참여의 순서가 하나로 정해진다
		const isBanned = vi.fn(async (_roomId: string, userId: string, manager?: unknown) => options.banned === true && userId === joiner.id && manager === tx);
		const announceNewRoomMember = vi.fn(async () => {});
		const notifyRoomListChanged = vi.fn();
		const publishChatRoomStream = vi.fn();
		Object.assign(base.service, {
			db: { transaction: async <T>(callback: (manager: typeof tx) => Promise<T>) => await callback(tx) },
			chatRoomInviteLinksRepository: { findOneBy: vi.fn(async (where: { code: string }) => where.code === code ? link : null) },
			chatRoomsRepository: { findOneBy: vi.fn(async () => room) },
			usersRepository: { findOneBy: vi.fn(async () => owner) },
			chatRoomMembershipsRepository: { countBy: vi.fn(async () => (options.members ?? 1) - 1) },
			chatRoomBanService: { isBanned },
			chatRosterService: { recordAccepted },
			chatService: { ...(base.service as unknown as { chatService: object }).chatService, announceNewRoomMember, notifyRoomListChanged, isRoomMember: async () => false },
			globalEventService: { publishChatRoomStream, publishMainStream: vi.fn() },
		});
		return { ...base, inserted, deleted, order, recordAccepted, tx, isBanned, announceNewRoomMember, notifyRoomListChanged, publishChatRoomStream };
	}

	test('잠금 아래에서 링크를 다시 확인한 뒤 멤버십을 만들고 같은 트랜잭션에서 명단 기록을 남긴다', async () => {
		const f = localFixture({ invitation: true });

		expect(await f.service.join(joiner, localUrl)).toEqual({ status: 'joined', roomId: room.id });
		expect(f.order).toEqual(['lock room', 'insert MiChatRoomMembership', 'recordAccepted in transaction']);
		expect(f.inserted[0].row).toMatchObject({ roomId: room.id, userId: joiner.id });
		expect(f.deleted).toContainEqual({ entity: 'MiChatRoomInvitation', where: { roomId: room.id, userId: joiner.id } });
		expect(f.publishChatRoomStream).toHaveBeenCalledWith(room.id, 'membershipStarted', { userId: joiner.id });
		expect(f.notifyRoomListChanged).toHaveBeenCalledWith([joiner.id, owner.id]);
		expect(f.announceNewRoomMember).toHaveBeenCalledTimes(1);
		expect(f.deliver).not.toHaveBeenCalled();
	});

	test('공개 미리보기는 기존 그룹 아이콘의 도트 이미지와 장식 계약을 사용한다', async () => {
		const f = localFixture();

		const preview = await f.service.previewForViewer(code, null);

		expect(preview).toMatchObject({ name: '모임', description: '', membersCount: 1, joinedRoomId: null, iconBlurhash: null, iconDecorations: [] });
		expect(preview?.iconUrl).toMatch(/^https:\/\/a\.example\/identicon\//);
		expect(preview).not.toHaveProperty('owner');
		expect(preview).not.toHaveProperty('ownerId');
	});

	test.each([
		['잠금을 기다리는 사이 폐기된 링크', { revokedUnderLock: true }, 'revoked'],
		['보관된 그룹', { archived: true }, 'archived'],
		['그룹장이 차단한 계정', { blockedByOwner: true }, 'blocked'],
		['그룹장이 내보낸 계정', { banned: true }, 'banned'],
		['내보낸 계정을 그룹장이 차단까지 했어도 내보낸 사유가 먼저', { banned: true, blockedByOwner: true }, 'banned'],
		['정원이 찬 그룹', { members: 50 }, 'full'],
		['정원과 차단이 겹치면 차단', { members: 50, blockedByOwner: true }, 'blocked'],
	] as [string, Options, string][])('%s이면 멤버십을 만들지 않고 사유를 알린다', async (_, options, reason) => {
		const f = localFixture(options);

		await expect(f.service.join(joiner, localUrl)).rejects.toMatchObject({ constructor: ChatInviteJoinRefusedError, reason });
		expect(f.inserted).toEqual([]);
		expect(f.recordAccepted).not.toHaveBeenCalled();
		expect(f.announceNewRoomMember).not.toHaveBeenCalled();
	});

	test('차단은 그룹장이 참여하려는 계정을 차단했는지만 본다', async () => {
		const f = localFixture();

		await f.service.join(joiner, localUrl);

		expect(f.tx.existsBy).toHaveBeenCalledWith(expect.objectContaining({ name: 'MiBlocking' }), { blockerId: owner.id, blockeeId: joiner.id });
	});

	test('이미 멤버면 기존 멤버십을 그대로 두고 그 그룹을 연다', async () => {
		const f = localFixture({ member: true, archived: true, members: 50, banned: true });

		expect(await f.service.join(joiner, localUrl)).toEqual({ status: 'joined', roomId: room.id });
		expect(f.inserted).toEqual([]);
		expect(f.deleted).toEqual([]);
		expect(f.publishChatRoomStream).not.toHaveBeenCalled();
	});

	test('없는 코드면 그룹을 찾지 않고 폐기 사유로 거절한다', async () => {
		const f = localFixture();

		await expect(f.service.join(joiner, `https://a.example/chat/invite/${otherCode}`)).rejects.toMatchObject({ reason: 'revoked' });
		expect(f.order).toEqual([]);
	});
});
