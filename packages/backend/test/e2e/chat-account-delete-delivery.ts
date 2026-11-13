/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as Bull from 'bullmq';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { INestApplicationContext } from '@nestjs/common';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { loadConfig } from '@/config.js';
import { MiChatRoom, MiUser } from '@/models/_.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import type { DbUserDeleteJobData, DeliverJobData } from '@/queue/types.js';
import { api, initTestDb, signup, startJobQueue } from '../utils.js';

const config = loadConfig();
let db: DataSource;
let dbQueue: Bull.Queue<DbUserDeleteJobData>;
let deliverQueue: Bull.Queue<DeliverJobData>;

beforeAll(async () => {
	db = await initTestDb(true);
	dbQueue = new Bull.Queue(QUEUE.DB, baseQueueOptions(config, QUEUE.DB));
	deliverQueue = new Bull.Queue(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
	await signup({ username: 'root' });
});

afterAll(async () => {
	await dbQueue.close();
	await deliverQueue.close();
	await db.destroy();
});

test('deleting a local account queues its room deletion for remote members', async () => {
	const owner = await signup();
	const member = await signup();
	expect((await api('i/update', { chatScope: 'everyone' }, member)).status).toBe(200);
	const room = (await api('chat/rooms/create', { name: 'Owner leaving' }, owner)).body;
	expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status).toBe(200);
	expect((await api('chat/rooms/join', { roomId: room.id }, member)).status).toBe(204);
	const inbox = `https://remote.test/users/${member.id}/inbox`;
	await db.getRepository(MiUser).update(member.id, { host: 'remote.test', uri: `https://remote.test/users/${member.id}`, inbox, sharedInbox: null });
	await dbQueue.pause();
	await deliverQueue.pause();
	try {
		expect((await api('i/delete-account', { password: 'test' }, owner)).status).toBe(204);
		await vi.waitFor(async () => {
			const jobs = await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']);
			expect(jobs.some(job => job.data.user.id === owner.id && job.data.to === inbox && JSON.parse(job.data.content).type === 'Delete')).toBe(true);
			expect(await db.getRepository(MiChatRoom).existsBy({ id: room.id })).toBe(false);
		}, { timeout: 10_000 });
	} finally {
		await dbQueue.resume();
		await deliverQueue.resume();
	}
}, 30_000);


test('a remote owner deletion removes its room and records its deletion', async () => {
	await dbQueue.pause();
	const app: INestApplicationContext = await startJobQueue();
	const owner = await signup();
	const member = await signup();
	expect((await api('i/update', { chatScope: 'everyone' }, member)).status).toBe(200);
	const room = (await api('chat/rooms/create', { name: 'Remote owner leaving' }, owner)).body;
	expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status).toBe(200);
	expect((await api('chat/rooms/join', { roomId: room.id }, member)).status).toBe(204);
	const uri = `https://remote.test/chat/rooms/${room.id}`;
	await db.getRepository(MiChatRoom).update(room.id, { uri });
	await db.getRepository(MiUser).update(owner.id, { host: 'remote.test', uri: `https://remote.test/users/${owner.id}`, inbox: 'https://remote.test/inbox', isDeleted: true });
	try {
		app.get(GlobalEventService).publishInternalEvent('remoteUserUpdated', { id: owner.id });
		await vi.waitFor(async () => {
			expect(await db.getRepository(MiChatRoom).existsBy({ id: room.id })).toBe(false);
			expect(await app.get(ChatRosterService).isRoomGone(uri)).toBe(true);
		}, { timeout: 10_000 });
	} finally {
		await app.close();
		await dbQueue.resume();
	}
}, 30_000);
