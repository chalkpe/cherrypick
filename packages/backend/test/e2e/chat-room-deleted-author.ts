/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MiChatMessage } from '@/models/_.js';
import { api, initTestDb, signup, startJobQueue } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

describe('작성자가 사라진 그룹 글의 미읽음', () => {
	let owner: Awaited<ReturnType<typeof signup>>;
	let member: Awaited<ReturnType<typeof signup>>;
	let leaver: Awaited<ReturnType<typeof signup>>;
	let db: Awaited<ReturnType<typeof initTestDb>>;
	let queue: Awaited<ReturnType<typeof startJobQueue>>;

	beforeAll(async () => {
		// 시험 모드의 새 Nest DB 연결은 스키마를 다시 만든다. 계정과 방을 만든 뒤에 시작하지 않는다.
		queue = await startJobQueue();
		owner = await signup({ username: 'goneowner' });
		member = await signup({ username: 'gonemember' });
		leaver = await signup({ username: 'goneleaver' });
		db = await initTestDb(true);
	}, 120_000);

	afterAll(async () => {
		try {
			await waitForChatNotificationTurn();
		} finally {
			await queue?.close();
			if (db?.isInitialized) await db.destroy();
		}
	}, 30_000);

	test('작성자가 탈퇴해 계정이 사라져도 남은 글의 미읽음은 유지된다', async () => {
		const created = await api('chat/rooms/create', { name: '탈퇴 시험' }, owner);
		expect(created.status).toBe(200);
		const roomId = created.body.id;
		expect((await api('chat/rooms/invitations/create', { roomId, userId: member.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, member)).status).toBe(204);
		expect((await api('chat/rooms/invitations/create', { roomId, userId: leaver.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, leaver)).status).toBe(204);
		const sent = await api('chat/messages/create-to-room', { toRoomId: roomId, text: '떠날 사람의 글' }, leaver);
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);

		const unread = async () => {
			const result = await api('chat/rooms/unread', { roomId }, owner);
			expect(result.status, JSON.stringify(result.body)).toBe(200);
			return result.body;
		};
		expect((await unread()).hasUnread).toBe(true);

		expect((await api('i/delete-account', { password: 'test' }, leaver)).status).toBe(204);
		// 계정 삭제 작업이 글의 작성자 FK를 비울 때까지 기다린다
		await expect.poll(async () => (await db.getRepository(MiChatMessage).findOneBy({ id: sent.body.id }))?.fromUserId, { timeout: 60_000 }).toBeNull();

		expect((await unread()).hasUnread).toBe(true);
	}, 120_000);
});
