/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MiChatMessage } from '@/models/_.js';
import { chatUnreadFixture as fixture } from '../misc/chat-unread-fixture.js';

// 미읽음 ID 창 계약: 최신 1000개를 유지하고, 256개 여유를 넘어설 때 오래된 ID부터 압축한다.
const WINDOW = 1000;
const CAP = WINDOW + 256;

/** 사전순과 시간순이 같은 ID로, 실제 aidx와 같은 조건에서 창·경계 비교를 검증한다. */
function longHistoryFixture() {
	const f = fixture();
	let seq = 0;
	(f.chatService as unknown as { idService: { gen: () => string; parse: () => { date: Date } } }).idService = {
		gen: () => `m${String(++seq).padStart(6, '0')}`,
		parse: () => ({ date: new Date(0) }),
	};
	return f;
}

async function sendMany(f: ReturnType<typeof fixture>, count: number) {
	for (let i = 0; i < count; i++) await f.chatService.createMessageToUser(f.violet, f.reader, { text: `bulk ${i}` });
}

describe('chat unread window', () => {
	afterEach(() => vi.useRealTimers());

	test('a long unread history keeps a bounded window of message IDs', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();

		await sendMany(f, CAP + 150);

		const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
		expect(await f.redis.scard(`${key}:messages`)).toBeLessThanOrEqual(CAP);
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
	});

	test('reading a long unread history processes a bounded batch', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();
		await sendMany(f, CAP + 150);

		const before = f.redis.stats.srem ?? 0;
		await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

		// 창 안의 ID만 messages·pending에서 지운다. 누적량 전체를 훑지 않는다.
		expect((f.redis.stats.srem ?? 0) - before).toBeLessThanOrEqual(2 * CAP);
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
	});

	test('capturing a read boundary copies a bounded batch', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();
		await sendMany(f, CAP + 150);

		const snapshot = await f.chatService.captureUserChatRead(f.reader.id, f.violet.id);

		expect(snapshot).not.toBeNull();
		expect(await f.redis.scard(snapshot!)).toBeLessThanOrEqual(CAP);
	});

	test('the account unread sign asks all conversation heads in one pipeline', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();
		await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'a' });
		await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'b' });
		await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'c' });

		const direct = vi.spyOn(f.redis, 'eval');
		const pipelines = vi.spyOn(f.redis, 'pipeline');
		await f.chatService.hasUnreadMessages(f.reader.id);

		const directHeads = direct.mock.calls.filter(([script]) => String(script).includes('snapshot chat unread head'));
		expect(directHeads).toHaveLength(0);
		expect(pipelines).toHaveBeenCalledTimes(1);
	});

	test('unread older than the window keeps the sign when the whole window is withdrawn', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();
		await sendMany(f, CAP + 150);

		for (const message of [...f.messages].slice(-CAP)) await f.chatService.deleteMessage(message as MiChatMessage);

		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
	});

	test('a partial read of a long history keeps older unread and a later read clears it', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();
		await sendMany(f, CAP + 150);

		await f.chatService.readUserChatMessage(f.reader.id, f.violet.id, { seenIds: [], upTo: f.messages[700].id! });

		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
	});

	test('marking everything read clears a long unread history', async () => {
		vi.useFakeTimers();
		const f = longHistoryFixture();
		await sendMany(f, CAP + 150);

		await f.chatService.readAllChatMessages(f.reader.id);

		const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		expect(await f.redis.scard(`${key}:messages`)).toBe(0);
	});

	test('legacy cleanup rescans marks left by a rollback after it completed', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const orphan = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
		await f.redis.set(orphan, 'old');
		expect(await f.chatService.cleanupLegacyUnreadMarks()).toBe(true);
		expect(await f.redis.get(orphan)).toBeNull();

		// 구버전 롤백 기간에 새 레거시 표식이 생겼다. 재스캔 주기가 지나면 정리되어야 한다.
		const later = `newUserChatMessageExists:${f.reader.id}:${f.amber.id}`;
		await f.redis.set(later, 'old');
		vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

		expect(await f.chatService.cleanupLegacyUnreadMarks()).toBe(true);
		expect(await f.redis.get(later)).toBeNull();
	});

	// 지연 알림의 최종 재확인 직전에 읽음이 끝나는 창은 구조적으로 남아 있다. 배지는 계정 재조회를 따라 바로잡힌다.
	test('a read racing the final recheck can still produce one notice, and the sign follows the account', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

		const evaluate = f.redis.eval;
		let rechecks = 0;
		let raced = false;
		vi.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
			const result = await evaluate(...args);
			if (!raced && String(args[0]).includes('is chat message unread')) {
				rechecks++;
				if (rechecks === 2) {
					raced = true;
					await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
				}
			}
			return result;
		});
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.told()).toContain('newChatMessage');
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
	});

	test('shrinking the latest mark keeps a conservative first boundary', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'one' });
		await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'two' });
		await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'three' });

		await f.chatService.deleteMessage(f.stored('three'));

		const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
		expect(await f.redis.get(key)).toBe(f.stored('two').id);
		expect(await f.redis.get(`${key}:first`)).toBe(f.stored('one').id);
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

		await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'four' });
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
		expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
	});
});
