/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { deepStrictEqual, rejects } from 'node:assert';
import { describe, test, vi } from 'vitest';
import { createAccount, resolveRemoteUser, WAIT_FOR_FEDERATION } from './utils.js';

describe('Chat invitations after a block', () => {
	test('the owner blocking a local invitee prevents acceptance', async () => {
		const owner = await createAccount('a.test');
		const invitee = await createAccount('a.test');
		const room = await owner.client.request('chat/rooms/create', { name: `local-block-${crypto.randomUUID()}` });
		await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: invitee.id });
		await owner.client.request('blocking/create', { userId: invitee.id });

		await rejects(invitee.client.request('chat/rooms/join', { roomId: room.id }));
		deepStrictEqual(await owner.client.request('chat/rooms/members', { roomId: room.id, limit: 100 }), []);
	});

	test('the owner blocking a remote invitee prevents acceptance', async () => {
		const owner = await createAccount('a.test');
		const invitee = await createAccount('b.test');
		const remote = await resolveRemoteUser('b.test', invitee.id, owner);
		const room = await owner.client.request('chat/rooms/create', { name: `remote-block-${crypto.randomUUID()}` });
		await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: remote.id });
		const mirrorId = await vi.waitFor(async () => {
			const invitation = (await invitee.client.request('chat/rooms/invitations/inbox', {})).find(item => item.room.name === room.name);
			if (invitation == null) throw new Error('invitation not received');
			return invitation.roomId;
		}, WAIT_FOR_FEDERATION);
		await owner.client.request('blocking/create', { userId: remote.id });

		await invitee.client.request('chat/rooms/join', { roomId: mirrorId });
		await vi.waitFor(async () => {
			deepStrictEqual(await owner.client.request('chat/rooms/invitations/outbox', { roomId: room.id }), []);
		}, WAIT_FOR_FEDERATION);
		deepStrictEqual(await owner.client.request('chat/rooms/members', { roomId: room.id, limit: 100 }), []);
		await vi.waitFor(async () => {
			await rejects(invitee.client.request('chat/rooms/members', { roomId: mirrorId, limit: 100 }));
		}, { timeout: 30000, interval: 250 });
	});
});
