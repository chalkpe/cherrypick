/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';

const alice = { id: 'alice', host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false };

function remoteUser(id: string, overrides: Record<string, unknown> = {}) {
	return { id, host: `${id}.test`, uri: `https://${id}.test/users/${id}`, inbox: `https://${id}.test/users/${id}/inbox`, sharedInbox: null, isSuspended: false, chatScope: 'everyone', ...overrides };
}

function createService(invitee?: ReturnType<typeof remoteUser>) {
	const deliver = vi.fn();
	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		idService: { gen: () => 'generated', parse: () => ({ date: new Date('2026-11-04T00:00:00Z') }) },
		queueService: { deliver },
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			addContext: (activity: unknown) => activity,
			renderChatMessage: async () => ({ type: 'Note' }),
			renderChatRoom: () => ({ type: 'Group' }),
			renderInvite: () => ({ type: 'Invite' }),
		},
		usersRepository: {
			findOneBy: async () => invitee ?? null,
			findOneByOrFail: async () => alice,
		},
		chatApprovalsRepository: {
			createQueryBuilder: () => ({
				where() { return this; }, orWhere() { return this; }, take() { return this; },
				getMany: async () => [],
			}),
			insertOne: vi.fn(),
		},
		chatMessagesRepository: { insertOne: async (message: unknown) => message },
		chatEntityService: { packMessageLiteFor1on1: async (message: unknown) => message },
		chatRoomsRepository: { findOneBy: async () => ({ id: 'room1', ownerId: alice.id, isArchived: false }) },
		chatRoomMembershipsRepository: { countBy: async () => 1, findOneBy: async () => null },
		chatRoomInvitationsRepository: { findOneBy: async () => null, insertOne: async (invitation: unknown) => invitation },
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		globalEventService: { publishChatUserStream: vi.fn() },
	}) as ChatService;
	return { service, inboxes: () => deliver.mock.calls.map(call => call[2]) };
}

describe('delivering chat activities to an account suspended on this server', () => {
	const active = remoteUser('active');
	const suspended = remoteUser('suspended', { isSuspended: true });
	const deliverTo = (f: ReturnType<typeof createService>, users: unknown[], type: string) =>
		(f.service as never as { deliverToRemoteUsers: (...args: unknown[]) => Promise<void> }).deliverToRemoteUsers(alice, users, { type });

	test.each(['Create', 'Update', 'Announce', 'Like', 'Add'])('holds back %s', async type => {
		const f = createService();

		await deliverTo(f, [suspended, active], type);

		expect(f.inboxes()).toEqual([active.inbox]);
	});

	test.each(['Delete', 'Remove', 'Undo'])('still sends %s, which takes something back', async type => {
		const f = createService();

		await deliverTo(f, [suspended, active], type);

		expect(f.inboxes()).toEqual([suspended.inbox, active.inbox]);
	});

	test('still reaches an active account behind the same shared inbox', async () => {
		const f = createService();
		const sharedInbox = 'https://shared.test/inbox';

		await deliverTo(f, [{ ...suspended, sharedInbox }, { ...active, sharedInbox }], 'Create');

		expect(f.inboxes()).toEqual([sharedInbox]);
	});

	test.each([
		['an active', active, [active.inbox]],
		['a suspended', suspended, []],
	])('sends a direct message to %s account only if it is not suspended', async (_name, recipient, expected) => {
		const f = createService();

		await f.service.createMessageToUser(alice, recipient as never, { text: 'hello' });

		expect(f.inboxes()).toEqual(expected);
	});

	test.each([
		['an active', active, [active.inbox]],
		['a suspended', suspended, []],
	])('sends an invitation to %s account only if it is not suspended', async (_name, invitee, expected) => {
		const f = createService(invitee);

		await f.service.createRoomInvitation(alice.id, 'room1', invitee.id);

		expect(f.inboxes()).toEqual(expected);
	});
});
