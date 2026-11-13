/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { strictEqual } from 'node:assert';
import { describe, test, vi } from 'vitest';
import { createAccount, fetchAdmin, resolveRemoteUser, WAIT_FOR_FEDERATION } from './utils.js';

describe('History import scheduling', () => {
	test('opening the room while the first import is queued does not add another job', async () => {
		const [owner, invitee, admin] = await Promise.all([createAccount('a.test'), createAccount('b.test'), fetchAdmin('b.test')]);
		const room = await owner.client.request('chat/rooms/create', { name: `scheduling ${crypto.randomUUID()}` });
		for (let i = 0; i < 40; i++) await owner.client.request('chat/messages/create-to-room', { toRoomId: room.id, text: `message ${i}` });
		const remote = await resolveRemoteUser('b.test', invitee.id, owner);
		await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: remote.id });
		const mirrorId = await vi.waitFor(async () => {
			const invitation = (await invitee.client.request('chat/rooms/invitations/inbox', {})).find(item => item.room.name === room.name);
			if (invitation == null) throw new Error('invitation not received');
			return invitation.roomId;
		}, WAIT_FOR_FEDERATION);
		await invitee.client.request('chat/rooms/join', { roomId: mirrorId });
		await invitee.client.request('chat/rooms/show', { roomId: mirrorId });
		const jobs = await admin.client.request('admin/queue/jobs', { queue: 'db', state: ['active', 'wait', 'delayed', 'completed', 'failed'], search: mirrorId });
		const imports = jobs.filter(job => job.name === 'chatRoomHistorySync');
		strictEqual(imports.length, 1);

		await vi.waitFor(async () => {
			const shown = await invitee.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(shown.historyImportStatus, 'completed');
		}, { timeout: 30000, interval: 250 });
		const messages = await invitee.client.request('chat/messages/room-timeline', { roomId: mirrorId, limit: 100 });
		strictEqual(messages.length, 40);
	});
});
