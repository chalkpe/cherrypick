/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';

const owner = { id: 'owner', host: null, uri: null, inbox: null, isSuspended: false };
const remoteOwner = { id: 'remote-owner', host: 'other.test', uri: 'https://other.test/users/remote-owner', inbox: 'https://other.test/inbox', isSuspended: false };
const suspended = { id: 'suspended', host: 'remote.test', uri: 'https://remote.test/users/suspended', inbox: 'https://remote.test/users/suspended/inbox', isSuspended: true };
const localRoom = { id: 'local-room', ownerId: owner.id, owner, name: 'room', isArchived: false, uri: null };
const mirrorRoom = { id: 'mirror-room', ownerId: remoteOwner.id, owner: remoteOwner, name: 'mirror', isArchived: false, uri: 'https://other.test/chat/rooms/mirror-room' };

function createService(invitations: { id: string; roomId: string; userId: string }[], options: { memberships?: { roomId: string; userId: string }[]; user?: object } = {}) {
	const rooms = [localRoom, mirrorRoom];
	const users = new Map<string, object>([owner, remoteOwner, options.user ?? suspended].map(user => [(user as { id: string }).id, user]));
	const deliver = vi.fn();
	const deleteInvitation = vi.fn(async () => ({ affected: 1 }));
	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		idService: { gen: () => 'generated' },
		queueService: { deliver },
		chatMessagesRepository: { createQueryBuilder: () => ({ select() { return this; }, where() { return this; }, andWhere() { return this; }, getRawMany: async () => [] }) },
		chatRoomMembershipsRepository: { findBy: vi.fn(async () => options.memberships ?? []) },
		chatRoomInvitationsRepository: {
			findBy: vi.fn(async () => invitations),
			findOneBy: vi.fn(async ({ id }: { id: string }) => invitations.find(invitation => invitation.id === id) ?? null),
			delete: deleteInvitation,
		},
		chatRoomsRepository: {
			find: vi.fn(async () => rooms),
			findOneBy: vi.fn(async ({ id }: { id: string }) => rooms.find(room => room.id === id) ?? null),
		},
		usersRepository: { findOneByOrFail: vi.fn(async ({ id }: { id: string }) => users.get(id)) },
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
		},
		apRendererService: {
			addContext: (activity: unknown) => activity,
			renderChatRoom: () => ({ type: 'Group' }),
			renderInvite: (object: unknown, target: unknown) => ({ type: 'Invite', object, target }),
			renderUndo: (object: unknown) => ({ type: 'Undo', object }),
		},
		globalEventService: { publishMainStream: vi.fn() },
		redisClient: { pipeline: () => ({ del() { return this; }, srem() { return this; }, exec: async () => [] }) },
	}) as ChatService;
	return { service, deliver, deleteInvitation };
}

describe('suspending a remote account with invitations waiting', () => {
	test('withdraws an invitation to a room owned here and tells the account', async () => {
		const f = createService([{ id: 'invitation', roomId: localRoom.id, userId: suspended.id }]);

		await f.service.handleUserSuspended(suspended as never);

		expect(f.deleteInvitation).toHaveBeenCalledWith({ id: 'invitation' });
		expect(f.deliver).toHaveBeenCalledOnce();
		const [actor, activity, inbox] = f.deliver.mock.calls[0];
		expect(actor).toBe(owner);
		expect(inbox).toBe(suspended.inbox);
		expect(activity).toMatchObject({
			type: 'Undo',
			object: { type: 'Invite', id: 'https://local.test/invitations/invitation', target: suspended.uri },
		});
	});

	test('withdraws them all', async () => {
		const f = createService([
			{ id: 'first', roomId: localRoom.id, userId: suspended.id },
			{ id: 'second', roomId: localRoom.id, userId: suspended.id },
		]);

		await f.service.handleUserSuspended(suspended as never);

		expect(f.deleteInvitation.mock.calls.map(call => (call as unknown[])[0])).toEqual([{ id: 'first' }, { id: 'second' }]);
	});

	test('leaves an invitation to a room of another server to its owner', async () => {
		const f = createService([{ id: 'invitation', roomId: mirrorRoom.id, userId: suspended.id }]);

		await f.service.handleUserSuspended(suspended as never);

		expect(f.deleteInvitation).not.toHaveBeenCalled();
		expect(f.deliver).not.toHaveBeenCalled();
	});

	test('handles memberships and invitations of the same account', async () => {
		const f = createService([{ id: 'invitation', roomId: localRoom.id, userId: suspended.id }], { memberships: [{ roomId: localRoom.id, userId: suspended.id }] });
		const evict = vi.spyOn(f.service, 'evictRoomMember').mockResolvedValue(true);

		await f.service.handleUserSuspended(suspended as never);

		expect(evict).toHaveBeenCalledWith(owner, localRoom, suspended.id);
		expect(f.deleteInvitation).toHaveBeenCalledWith({ id: 'invitation' });
	});

	test('a failure with one invitation does not keep the others', async () => {
		const f = createService([
			{ id: 'first', roomId: localRoom.id, userId: suspended.id },
			{ id: 'second', roomId: localRoom.id, userId: suspended.id },
		]);
		f.deleteInvitation.mockRejectedValueOnce(new Error('database'));

		await f.service.handleUserSuspended(suspended as never);

		expect(f.deleteInvitation).toHaveBeenCalledTimes(2);
		expect(f.deliver).toHaveBeenCalledOnce();
	});

	test('keeps the invitations of a suspended account of this server', async () => {
		const local = { ...suspended, host: null, uri: null, inbox: null };
		const f = createService([{ id: 'invitation', roomId: localRoom.id, userId: local.id }], { user: local });

		await f.service.handleUserSuspended(local as never);

		expect(f.deleteInvitation).not.toHaveBeenCalled();
	});
});
