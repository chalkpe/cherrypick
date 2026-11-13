/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MiChatMessage, MiUser } from '@/models/_.js';
import { chatUnreadFixture as fixture } from '../misc/chat-unread-fixture.js';

// 검토 지적 재현: 압축 영역 손실(Sol1), 뮤트 중 쪽지 승격(Sol2), 레거시 무한 누적(Sol3), 시계 역행 과대 표시(OC5.2).
const WINDOW = 1000;
const SLACK = 256;
const CAP = WINDOW + SLACK;

/** 사전순과 시간순이 같은 ID로, 실제 aidx와 같은 조건에서 창·경계 비교를 검증한다. */
function longHistoryFixture() {
	const f = fixture();
	let seq = 0;
	(f.chatService as unknown as { idService: { gen: () => string; parse: () => { date: Date } } }).idService = {
		gen: () => `m${String(++seq).padStart(6, '0')}`,
		parse: () => ({ date: new Date(0) }),
	};
	// 쪽지마다 허가 행이 같은 ID 생성기를 쓰면 번호가 밀린다. 이미 허가된 것으로 둔다.
	(f.chatService as unknown as { chatApprovalsRepository: unknown }).chatApprovalsRepository = {
		createQueryBuilder: () => ({ where() { return this; }, orWhere() { return this; }, take() { return this; }, getMany: async () => [{ userId: f.violet.id }] }),
		insertOne: async () => undefined,
	};
	return f;
}

async function sendMany(f: ReturnType<typeof fixture>, count: number) {
	for (let i = 0; i < count; i++) await f.chatService.createMessageToUser(f.violet, f.reader, { text: `bulk ${i}` });
}

async function sendManyRoom(f: ReturnType<typeof fixture>, count: number, author: MiUser, label = 'bulk') {
	for (let i = 0; i < count; i++) await f.chatService.createMessageToRoom(author, f.room, { text: `${label} ${i}` });
}

const byId = (f: ReturnType<typeof fixture>, id: string) => f.messages.find(message => message.id === id) as MiChatMessage;

describe('chat unread compression review fixes', () => {
	afterEach(() => vi.useRealTimers());

	describe('Sol1: the compressed range is a candidate even when the window answers', () => {
		test('withdrawing the first ID and then the whole window keeps the compressed unread', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendMany(f, CAP + 150);
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			const window = await f.redis.smembers(`${key}:messages`) as string[];
			const first = f.messages[0].id!;
			expect(await f.redis.get(`${key}:trimmed`)).toBe('m000258');

			await f.chatService.deleteMessage(byId(f, first));
			for (const id of window.filter(id => id !== first)) await f.chatService.deleteMessage(byId(f, id));

			// 압축 구간(m000002..m000258)은 읽거나 철회하지 않았다.
			expect(f.messages.filter(message => message.deletedAt == null && message.id! > first && message.id! <= 'm000258')).toHaveLength(257);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.readAllChatMessages(f.reader.id);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('withdrawing the window down to the first ID does not shrink the compressed range', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendMany(f, CAP + 150);
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			const window = await f.redis.smembers(`${key}:messages`) as string[];
			const first = f.messages[0].id!;
			const trimmed = await f.redis.get(`${key}:trimmed`);

			for (const id of window.filter(id => id !== first)) await f.chatService.deleteMessage(byId(f, id));

			// 창에 첫 ID만 남았어도 압축 영역의 미읽음은 그대로다. 경계를 첫 ID로 줄이면 안 된다.
			expect(await f.redis.get(`${key}:trimmed`)).toBe(trimmed);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.deleteMessage(byId(f, first));
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.readAllChatMessages(f.reader.id);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});

	describe('Sol2: the compressed range does not promote messages received while the room was muted', () => {
		/** 뮤트 구간이 나중에 압축될 영역 안에 끼도록, 뮤트 앞뒤로 충분한 이력을 만든다. */
		async function mutedIntervalFixture() {
			const f = longHistoryFixture();
			await sendManyRoom(f, 10, f.violet, 'before');
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await sendManyRoom(f, 5, f.amber, 'muted');
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			await sendManyRoom(f, CAP + 150, f.violet);
			return f;
		}

		test('suspending the visible author after compression leaves no unread from the muted interval', async () => {
			vi.useFakeTimers();
			const f = await mutedIntervalFixture();
			const key = `newRoomChatMessageExists:${f.reader.id}:${f.room.id}`;

			// 뮤트 토글은 쪽지 전용 제외 구간을 남긴다. 뮤트 중 쪽지는 m000011..m000015.
			expect(await f.redis.lrange(`${key}:excluded`, 0, -1)).toEqual(['m000010|m000015']);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			f.violet.isSuspended = true;
			await f.chatService.handleUserSuspended(f.violet);

			// 뮤트 중 제외한 쪽지가 미읽음으로 승격하면 안 된다.
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('withdrawing the whole window after a muted interval keeps no promoted unread', async () => {
			vi.useFakeTimers();
			const f = await mutedIntervalFixture();
			const key = `newRoomChatMessageExists:${f.reader.id}:${f.room.id}`;

			f.violet.isSuspended = true;
			await f.chatService.handleUserSuspended(f.violet);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);

			const window = await f.redis.smembers(`${key}:messages`) as string[];
			for (const id of window) await f.chatService.deleteMessage(byId(f, id));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});

	describe('Sol3: an active legacy mark keeps a bounded window after the upgrade', () => {
		test('bulk receive on a legacy mark caps storage, capture and read processing', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendMany(f, 2);
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			await f.redis.del(`${key}:first`);

			await sendMany(f, CAP + 150);

			expect(await f.redis.scard(`${key}:messages`)).toBeLessThanOrEqual(CAP);
			// 레거시의 알 수 없는 읽음 경계는 만들지 않는다. 넘친 ID는 압축 경계로 모은다.
			expect(await f.redis.get(`${key}:first`)).toBeNull();
			expect(await f.redis.get(`${key}:trimmed`)).not.toBeNull();
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			const snapshot = await f.chatService.captureUserChatRead(f.reader.id, f.violet.id);
			expect(snapshot).not.toBeNull();
			expect(await f.redis.scard(snapshot!)).toBeLessThanOrEqual(CAP);

			const before = f.redis.stats.srem ?? 0;
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
			expect((f.redis.stats.srem ?? 0) - before).toBeLessThanOrEqual(2 * CAP);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a legacy mark with overflow keeps its unknown boundary until a read covers it', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendMany(f, 2);
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			await f.redis.del(`${key}:first`);
			await sendMany(f, CAP + 150);

			// 압축 경계 아래는 아직 읽음 경계를 모른다. 경계 없는 읽음이 레거시를 신형으로 바꾸면 안 된다.
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id, { seenIds: [], upTo: null });
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			// 압축 경계를 덮는 읽음은 그 아래를 모두 읽은 것으로 한다.
			const trimmed = await f.redis.get(`${key}:trimmed`);
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id, { seenIds: [], upTo: (trimmed as string | null) ?? f.messages[257].id! });
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});

	describe('OC5.2: a clock-skewed arrival does not widen the compressed range over read messages', () => {
		async function deepReadWithSkew(f: ReturnType<typeof longHistoryFixture>) {
			const key = `newRoomChatMessageExists:${f.reader.id}:${f.room.id}`;
			await sendManyRoom(f, 150, f.amber, 'amber');
			await sendManyRoom(f, CAP + 150 - 150, f.violet);
			// 깊은 페이지 읽음: 읽음 경계가 압축 구간 안으로 올라간다. 창 ID는 전부 경계보다 최신.
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id, { seenIds: [], upTo: 'm000200' });
			expect(await f.redis.get(`${key}:first`)).toBe('m000200');
			// 발신 시계 역행: 읽음 경계보다 오래된 ID의 새 쪽지. 기존 ID와 겹치지 않는 접두사를 쓴다.
			const service = f.chatService as unknown as { idService: { gen: () => string } };
			vi.spyOn(service.idService, 'gen').mockReturnValueOnce('k000100');
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'skewed' });
			return key;
		}

		test('read messages below the read boundary are not promoted when the genuine unread is gone', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			const key = await deepReadWithSkew(f);

			// MARK는 읽음 경계 아래로 first를 내리지 않는다.
			expect(await f.redis.get(`${key}:first`)).toBe('m000200');

			// 역행 쪽지를 철회하고, 진짜 미읽음(창과 압축 구간)은 전부 정지로 가린다.
			await f.chatService.deleteMessage(f.stored('skewed'));
			f.violet.isSuspended = true;
			await f.chatService.handleUserSuspended(f.violet);

			// 남은 것은 (k000100, m000200]의 이미 읽은 쪽지뿐이다. 배지가 켜지면 안 된다.
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a skewed arrival stays individually unread through later compression', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			const key = await deepReadWithSkew(f);

			await sendManyRoom(f, CAP + 150, f.violet, 'later');

			// 역행 쪽지는 압축으로 잃지 않는다. 창에 개별 ID로 남는다.
			expect(await f.redis.sismember(`${key}:messages`, 'k000100')).toBe(1);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.readAllChatMessages(f.reader.id);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('too many arrivals below the read boundary fall back to the conservative legacy state', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			const key = await deepReadWithSkew(f);

			const service = f.chatService as unknown as { idService: { gen: () => string } };
			let seq = 0;
			vi.spyOn(service.idService, 'gen').mockImplementation(() => `l${String(++seq).padStart(6, '0')}`);
			await sendManyRoom(f, CAP + SLACK + 100, f.amber, 'late');

			// 보관량은 유계이고, 알 수 없는 경계는 레거시 상태로 보수적으로 남긴다.
			expect(await f.redis.scard(`${key}:messages`)).toBeLessThanOrEqual(CAP + SLACK);
			expect(await f.redis.get(`${key}:first`)).toBeNull();
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.readAllChatMessages(f.reader.id);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});
});
