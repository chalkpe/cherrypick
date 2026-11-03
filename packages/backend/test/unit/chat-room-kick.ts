/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import KickEndpoint from '@/server/api/endpoints/chat/rooms/kick.js';

const owner = { id: 'owner', host: null, uri: null };
const member = { id: 'member', host: 'remote.test', uri: 'https://remote.test/users/member', inbox: 'https://remote.test/inbox' };
const other = { id: 'other', host: 'other.test', uri: 'https://other.test/users/other', inbox: 'https://other.test/inbox' };
const room = { id: 'room', ownerId: owner.id, isArchived: false };

function fixture() {
	const members = new Set([member.id, other.id]);
	const users = [owner, member, other];
	const pipeline = { del: vi.fn(), srem: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
	const queueService = { deliver: vi.fn() };
	const liveKitService = { identityOf: (user: typeof member) => user.uri, removeParticipant: vi.fn().mockResolvedValue(undefined) };
	const globalEventService = { publishChatRoomStream: vi.fn() };
	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		idService: { gen: () => 'remove1' },
		chatRoomMembershipsRepository: {
			findBy: async () => [...members].map(userId => ({ roomId: room.id, userId })),
			delete: async ({ userId }: { userId: string }) => ({ affected: Number(members.delete(userId)) }),
		},
		usersRepository: { findBy: async ({ id }: { id: { value: string[] } }) => users.filter(user => id.value.includes(user.id)) },
		userEntityService: {
			isRemoteUser: (user: typeof owner | typeof member) => user.host != null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
			renderRemove: (actor: typeof owner, target: string, object: string) => ({ type: 'Remove', actor: `https://local.test/users/${actor.id}`, target, object }),
			addContext: (activity: object) => ({ '@context': 'https://www.w3.org/ns/activitystreams', ...activity }),
		},
		redisClient: { pipeline: () => pipeline },
		queueService, liveKitService, globalEventService,
	});
	return { service, members, pipeline, queueService, liveKitService, globalEventService };
}

describe('room owner kicks a member', () => {
	test('removes membership and unread state, ends the call, and sends owner Remove to the target and remaining peers', async () => {
		const f = fixture();
		await expect(f.service.kickRoomMember(owner, room, member.id)).resolves.toBe(true);
		expect([...f.members]).toEqual([other.id]);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith(room.id, 'membershipEnded', { userId: member.id });
		expect(f.pipeline.srem).toHaveBeenCalledWith(`newChatMessagesExists:${member.id}`, `room:${room.id}`);
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith(room.id, member.uri);
		for (const inbox of [member.inbox, other.inbox]) {
			expect(f.queueService.deliver).toHaveBeenCalledWith(owner, expect.objectContaining({
				type: 'Remove', actor: 'https://local.test/users/owner', object: member.uri,
				target: 'https://local.test/chat/rooms/room', id: 'https://local.test/activities/remove1',
			}), inbox, false);
		}
		expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
	});

	test.each([
		['non-owner', member, room, other.id],
		['remote owner', member, { ...room, ownerId: member.id }, other.id],
		['owner itself', owner, room, owner.id],
		['non-member', owner, room, 'outsider'],
	])('refuses %s without side effects', async (_label, actor, targetRoom, userId) => {
		const f = fixture();
		await expect(f.service.kickRoomMember(actor, targetRoom, userId)).resolves.toBe(false);
		expect([...f.members]).toEqual([member.id, other.id]);
		expect(f.queueService.deliver).not.toHaveBeenCalled();
		expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
	});

	test('allows moderation of archived rooms and survives a voice provider failure', async () => {
		const f = fixture();
		f.liveKitService.removeParticipant.mockRejectedValue(new Error('voice unavailable'));
		await expect(f.service.kickRoomMember(owner, { ...room, isArchived: true }, member.id)).resolves.toBe(true);
		expect(f.members.has(member.id)).toBe(false);
		expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
	});

	test('a repeated kick does not send a second Remove', async () => {
		const f = fixture();
		await f.service.kickRoomMember(owner, room, member.id);
		f.queueService.deliver.mockClear();
		await expect(f.service.kickRoomMember(owner, room, member.id)).resolves.toBe(false);
		expect(f.queueService.deliver).not.toHaveBeenCalled();
	});
});

describe('chat/rooms/kick endpoint', () => {
	function endpoint() {
		const f = fixture();
		const instance = new KickEndpoint({
			checkChatAvailability: vi.fn().mockResolvedValue(undefined),
			findMyRoomById: async (ownerId: string, roomId: string) => ownerId === room.ownerId && roomId === room.id ? room : null,
			kickRoomMember: (...args: unknown[]) => f.service.kickRoomMember(...args),
		} as unknown as ChatService);
		return { ...f, instance };
	}

	test('the owner can remove the requested member through the API', async () => {
		const f = endpoint();
		await f.instance.exec({ roomId: room.id, userId: member.id }, owner as any, null, null);
		expect(f.members.has(member.id)).toBe(false);
	});

	test('a non-owner cannot remove someone else through the API', async () => {
		const f = endpoint();
		await expect(f.instance.exec({ roomId: room.id, userId: other.id }, member as any, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
		expect(f.members.has(other.id)).toBe(true);
	});

	test.each([owner.id, 'absent'])('the API refuses removing %s', async userId => {
		const f = endpoint();
		await expect(f.instance.exec({ roomId: room.id, userId }, owner as any, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_MEMBER' });
		expect(f.queueService.deliver).not.toHaveBeenCalled();
	});
});
