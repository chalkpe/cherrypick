/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { strictEqual } from 'node:assert';
import { test, vi } from 'vitest';
import { createAccount, resolveRemoteUser, WAIT_FOR_SLOW_FEDERATION } from './utils.js';

test('a removed remote member cannot rejoin by invite link', async () => {
	const owner = await createAccount('a.test');
	const member = await createAccount('b.test');
	const room = await owner.client.request('chat/rooms/create', { name: crypto.randomUUID() });
	const { url } = await owner.client.request('chat/rooms/invite-link/create', { roomId: room.id });
	await member.client.request('chat/invite-link/join', { url });
	await vi.waitFor(async () => strictEqual((await member.client.request('chat/invite-link/join-status', { url })).status, 'joined'), WAIT_FOR_SLOW_FEDERATION);
	const remote = await resolveRemoteUser('b.test', member.id, owner);
	await owner.client.request('chat/rooms/kick', { roomId: room.id, userId: remote.id });
	await vi.waitFor(async () => {
		const status = await member.client.request('chat/invite-link/join-status', { url });
		strictEqual(status.status === 'joined', false);
	}, WAIT_FOR_SLOW_FEDERATION);
	await member.client.request('chat/invite-link/join', { url });
	await vi.waitFor(async () => {
		const status = await member.client.request('chat/invite-link/join-status', { url });
		strictEqual(status.status, 'refused');
		strictEqual(status.reason, 'banned');
	}, WAIT_FOR_SLOW_FEDERATION);
}, 180_000);
