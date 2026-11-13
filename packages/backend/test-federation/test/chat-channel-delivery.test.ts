/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { strictEqual } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as Redis from 'ioredis';
import { test, vi } from 'vitest';
import { createAccount, fetchAdmin, resolveRemoteUser, WAIT_FOR_SLOW_FEDERATION } from './utils.js';

test('a channel update reaches a server advertising channel support', async () => {
	const owner = await createAccount('a.test');
	const member = await createAccount('b.test');
	const room = await owner.client.request('chat/rooms/create', { name: crypto.randomUUID() });
	const { url } = await owner.client.request('chat/rooms/invite-link/create', { roomId: room.id });
	await member.client.request('chat/invite-link/join', { url });
	const joined = await vi.waitFor(async () => {
		const status = await member.client.request('chat/invite-link/join-status', { url });
		if (status.status !== 'joined' || status.roomId == null) throw new Error('join pending');
		return status;
	}, WAIT_FOR_SLOW_FEDERATION);
	await owner.client.request('chat/rooms/convert-to-channels', { roomId: room.id });
	const name = crypto.randomUUID();
	await owner.client.request('chat/rooms/channels/create', { roomId: room.id, name });
	await vi.waitFor(async () => {
		const channels = await member.client.request('chat/rooms/channels/list', { roomId: joined.roomId! });
		strictEqual(channels.some(channel => channel.name === name), true);
	}, WAIT_FOR_SLOW_FEDERATION);
	const admin = await fetchAdmin('a.test');
	const jobs = await admin.client.request('admin/queue/jobs', { queue: 'deliver', state: ['completed'], search: owner.id });
	strictEqual(jobs.some(job => {
		const data = job.data as { to?: string; content?: string };
		const activity = JSON.parse(data.content ?? '{}') as { type?: string; object?: { _misskey_chatChannels?: unknown } };
		return data.to?.includes('b.test') === true && activity.type === 'Update' && activity.object?._misskey_chatChannels != null;
	}), true);
}, 180_000);

test.skipIf(process.env.CHERRYPICK_NODEINFO_BLOCK == null)('a temporary NodeInfo outage defers the channel update until capability is known', async () => {
	const owner = await createAccount('a.test');
	const member = await createAccount('b.test');
	const room = await owner.client.request('chat/rooms/create', { name: crypto.randomUUID() });
	const { url } = await owner.client.request('chat/rooms/invite-link/create', { roomId: room.id });
	await member.client.request('chat/invite-link/join', { url });
	const joined = await vi.waitFor(async () => {
		const status = await member.client.request('chat/invite-link/join-status', { url });
		if (status.status !== 'joined' || status.roomId == null) throw new Error('join pending');
		return status;
	}, WAIT_FOR_SLOW_FEDERATION);
	await owner.client.request('chat/rooms/convert-to-channels', { roomId: room.id });
	const config = JSON.parse(await readFile(process.env.CHERRYPICK_TEST_CONFIG_A!, 'utf8')) as { redis: { prefix: string } };
	const redis = new Redis.Redis({ host: '127.0.0.1', port: 6379, db: 15, keyPrefix: `${config.redis.prefix}:` });
	const block = process.env.CHERRYPICK_NODEINFO_BLOCK!;
	const name = crypto.randomUUID();
	try {
		await writeFile(block, 'blocked');
		await redis.del('chat_room_channels_capability:b.test');
		await owner.client.request('chat/rooms/channels/create', { roomId: room.id, name });
		const admin = await fetchAdmin('a.test');
		const jobs = await admin.client.request('admin/queue/jobs', { queue: 'db', state: ['delayed', 'wait', 'active'], search: owner.id });
		strictEqual(jobs.some(job => (job.data as { host?: string }).host === 'b.test'), true);
		const before = await member.client.request('chat/rooms/channels/list', { roomId: joined.roomId! });
		strictEqual(before.some(channel => channel.name === name), false);
		await rm(block);
		await vi.waitFor(async () => {
			const channels = await member.client.request('chat/rooms/channels/list', { roomId: joined.roomId! });
			strictEqual(channels.some(channel => channel.name === name), true);
		}, { timeout: 60_000, interval: 500 });
	} finally {
		await rm(block, { force: true });
		redis.disconnect();
	}
}, 180_000);

test.skipIf(process.env.CHERRYPICK_OLD_SERVER == null)('a server without channel support receives no channel state update', async () => {
	const owner = await createAccount('a.test');
	const member = await createAccount('b.test');
	const remote = await resolveRemoteUser('b.test', member.id, owner);
	const room = await owner.client.request('chat/rooms/create', { name: crypto.randomUUID() });
	await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: remote.id });
	const invitation = await vi.waitFor(async () => {
		const found = (await member.client.request('chat/rooms/invitations/inbox', {})).find(item => item.room.name === room.name);
		if (found == null) throw new Error('invitation pending');
		return found;
	}, WAIT_FOR_SLOW_FEDERATION);
	await member.client.request('chat/rooms/join', { roomId: invitation.room.id });
	await vi.waitFor(async () => {
		const members = await owner.client.request('chat/rooms/members', { roomId: room.id, limit: 100 });
		strictEqual(members.some(item => item.userId === remote.id), true);
	}, WAIT_FOR_SLOW_FEDERATION);
	const discovery = await (await fetch('https://b.test/.well-known/nodeinfo')).json() as { links: { rel: string; href: string }[] };
	const link = discovery.links.find(item => item.rel.endsWith('/2.1')) ?? discovery.links[0];
	const info = await (await fetch(link.href)).json() as { metadata?: { features?: string[] } };
	strictEqual(info.metadata?.features?.includes('chat_room_channels') ?? false, false);
	await owner.client.request('chat/rooms/convert-to-channels', { roomId: room.id });
	await owner.client.request('chat/rooms/channels/create', { roomId: room.id, name: crypto.randomUUID() });
	const config = JSON.parse(await readFile(process.env.CHERRYPICK_TEST_CONFIG_A!, 'utf8')) as { redis: { prefix: string } };
	const redis = new Redis.Redis({ host: '127.0.0.1', port: 6379, db: 15, keyPrefix: `${config.redis.prefix}:` });
	try {
		strictEqual(await redis.get('chat_room_channels_capability:b.test'), 'no');
		const ttl = await redis.ttl('chat_room_channels_capability:b.test');
		strictEqual(ttl > 0 && ttl <= 600, true);
	} finally {
		redis.disconnect();
	}
	const admin = await fetchAdmin('a.test');
	const jobs = await admin.client.request('admin/queue/jobs', { queue: 'deliver', state: ['completed', 'active', 'wait', 'delayed', 'failed'], search: owner.id });
	strictEqual(jobs.some(job => {
		const data = job.data as { to?: string; content?: string };
		const activity = JSON.parse(data.content ?? '{}') as { type?: string; object?: { _misskey_chatChannels?: unknown } };
		return data.to?.includes('b.test') === true && activity.type === 'Update' && activity.object?._misskey_chatChannels != null;
	}), false);
}, 180_000);
