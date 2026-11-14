/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MiChatMessage, MiUser } from '@/models/_.js';
import { chatUnreadFixture as fixture } from '../misc/chat-unread-fixture.js';

// 검토 지적 재현: 같은 뮤트 요청의 중복 구간(Sol2), 구간 목록의 무상한 누적(Sol3/OC5.3), 토글-토글 경합(OC5.2).
// 구간 기록의 상태 전이를 표로 고정한다: 열기·닫기·중복 요청·빈 구간·합치기·하한 아래 제거·상한 초과.
const WINDOW = 1000;
const SLACK = 256;
const CAP = WINDOW + SLACK;
// 구간 목록의 고정 상한. 초과분은 뮤트 중 쪽지를 승격시키지 않는 보수적 덮개 하나로 모은다.
const INTERVAL_CAP = 64;

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

async function sendManyRoom(f: ReturnType<typeof fixture>, count: number, author: MiUser, label = 'bulk') {
	for (let i = 0; i < count; i++) await f.chatService.createMessageToRoom(author, f.room, { text: `${label} ${i}` });
}

const roomKey = (f: ReturnType<typeof fixture>) => `newRoomChatMessageExists:${f.reader.id}:${f.room.id}:excluded`;
const lastId = (f: ReturnType<typeof fixture>) => f.messages[f.messages.length - 1].id!;
const opens = (list: string[]) => list.filter(interval => interval.endsWith('|'));

describe('chat room mute interval recording', () => {
	afterEach(() => vi.useRealTimers());

	describe('state transitions', () => {
		test('opening records one interval, and a repeated mute request records nothing', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 1, f.violet, 'first');

			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${lastId(f)}|`]);

			// 같은 상태 요청(응답 유실 뒤 재전송, 두 탭)은 구간을 추가하지 않는다.
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${lastId(f)}|`]);
		});

		test('closing with no new messages stores no empty interval, and a repeated unmute records nothing', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 1, f.violet, 'first');

			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([]);

			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([]);
		});

		test('mute(true), mute(true), mute(false) leaves no open interval', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 1, f.violet, 'first');

			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);

			expect(opens(await f.redis.lrange(roomKey(f), 0, -1) as string[])).toEqual([]);
		});

		test('a mute period with messages closes into a bounded interval', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 1, f.violet, 'first');
			const start = lastId(f);

			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await sendManyRoom(f, 3, f.amber, 'muted');
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);

			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${start}|${lastId(f)}`]);
		});

		test('back-to-back cycles merge adjacent intervals', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 1, f.violet, 'first');
			const start = lastId(f);

			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await sendManyRoom(f, 1, f.amber, 'muted');
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await sendManyRoom(f, 1, f.amber, 'muted again');
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);

			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${start}|${lastId(f)}`]);
		});

		test('overlapping intervals merge on the next toggle', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 5, f.violet, 'm');
			const ids = f.messages.map(message => message.id!);

			// fixture: 이전 빌드가 남긴 겹치는 구간. 다음 토글이 실제 제품 경로에서 정리한다.
			await f.redis.rpush(roomKey(f), `${ids[0]}|${ids[2]}`, `${ids[1]}|${ids[3]}`);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			// 겹치는 구간은 합쳐지고, 뮤트 직전 쪽지(ids4)는 미읽음이라 새 열린 구간과 별개다.
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${ids[0]}|${ids[3]}`, `${ids[4]}|`]);

			await sendManyRoom(f, 1, f.violet, 'extra');
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${ids[0]}|${ids[3]}`, `${ids[4]}|${lastId(f)}`]);
		});

		test('a leftover open interval from an old toggle race closes on unmute', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 3, f.violet, 'm');
			const ids = f.messages.map(message => message.id!);

			// fixture: 토글 경합이 남긴 잔여 열린 구간(마지막이 아닌 위치).
			await f.redis.rpush(roomKey(f), `${ids[0]}|`, `${ids[1]}|${ids[2]}`);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);

			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${ids[0]}|${ids[2]}`]);
		});
	});

	describe('pruning below the read boundary', () => {
		test('closed intervals at or below the boundary are dropped, and open starts clamp to it', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendManyRoom(f, 10, f.violet, 'early');
			const early = f.messages.map(message => message.id!);

			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await sendManyRoom(f, 2, f.amber, 'muted');
			const mutedEnd = lastId(f);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${early[9]}|${mutedEnd}`]);

			// 압축이 생긴 뒤 부분 읽음: 읽음 경계가 구간 끝까지 올라간다. 표식은 유지된다.
			await sendManyRoom(f, CAP + 150, f.violet);
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id, { seenIds: [], upTo: mutedEnd });
			expect(await f.redis.get(`newRoomChatMessageExists:${f.reader.id}:${f.room.id}:readbound`)).toBe(mutedEnd);

			await sendManyRoom(f, 1, f.violet, 'latest');
			const latest = lastId(f);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${latest}|`]);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([]);

			// fixture: 읽음 경계 아래에서 시작된 열린 구간. 시작을 하한으로 올린다.
			await f.redis.rpush(roomKey(f), `${early[0]}|`);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${mutedEnd}|`]);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual([`${mutedEnd}|${latest}`]);
		});
	});

	describe('the fixed cap', () => {
		test('many toggles keep the list within the cap', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();

			// 뮤트 중 쪽지와 해제 뒤 쪽지가 교대로 쌓이면 서로 떨어지는 구간이 매 사이클 생긴다.
			await sendManyRoom(f, 1, f.violet, 'gap 0');
			for (let i = 1; i <= INTERVAL_CAP + 6; i++) {
				await f.chatService.muteRoom(f.reader.id, f.room.id, true);
				await sendManyRoom(f, 1, f.amber, `muted ${i}`);
				await f.chatService.muteRoom(f.reader.id, f.room.id, false);
				await sendManyRoom(f, 1, f.violet, `gap ${i}`);
			}

			const list = await f.redis.lrange(roomKey(f), 0, -1) as string[];
			expect(list.length).toBeLessThanOrEqual(INTERVAL_CAP);
			expect(opens(list)).toEqual([]);
			// 해제 뒤 받은 쪽지는 창에서 개별 판정되므로 미읽음을 유지한다.
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		});

		test('an over-cap list collapses to one conservative covering interval', async () => {
			const f = longHistoryFixture();

			// fixture: 상한을 크게 넘는 떨어지는 구간 목록.
			const seeded: string[] = [];
			for (let i = 0; i < 300; i++) {
				seeded.push(`s${String(2 * i + 1).padStart(4, '0')}|s${String(2 * i + 2).padStart(4, '0')}`);
			}
			await f.redis.rpush(roomKey(f), ...seeded);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);

			// 뮤트 중 쪽지를 미읽음으로 올리지 않는 보수적 덮개: 최소 시작부터 최대 끝까지.
			expect(await f.redis.lrange(roomKey(f), 0, -1)).toEqual(['s0001|s0600']);
		});

		test('the fallback SQL stays within the interval budget', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendManyRoom(f, CAP + 150, f.violet);

			// fixture: 압축 구간 안에 떨어지는 구간 200개. 토글 뒤 상한 안으로 정리되어야 한다.
			const seeded: string[] = [];
			for (let i = 0; i < 200; i++) {
				seeded.push(`m${String(2 * i + 2).padStart(6, '0')}|m${String(2 * i + 3).padStart(6, '0')}`);
			}
			await f.redis.rpush(roomKey(f), ...seeded);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect((await f.redis.lrange(roomKey(f), 0, -1) as string[]).length).toBeLessThanOrEqual(INTERVAL_CAP);

			// 창 전부가 정지로 가려지면 압축 폴백이 구간 제외 조건을 붙여 조회한다.
			const repository = (f.chatService as unknown as { chatMessagesRepository: { findOne: (arg: { where: Record<string, unknown> }) => Promise<unknown> } }).chatMessagesRepository;
			const original = repository.findOne;
			const conditions: Record<string, unknown>[] = [];
			repository.findOne = async arg => {
				conditions.push(arg.where);
				return original(arg);
			};
			f.violet.isSuspended = true;
			await f.chatService.handleUserSuspended(f.violet);

			const fallbacks = conditions.filter(where => where.toRoomId != null && typeof where.id === 'object');
			expect(fallbacks.length).toBeGreaterThan(0);
			for (const where of fallbacks) {
				const sql = JSON.stringify(where.id);
				const bounds = (sql.match(/"moreThan"/g) ?? []).length + (sql.match(/"lessThanOrEqual"/g) ?? []).length;
				// 범위 경계 2개 + 구간마다 경계 2개. 상한을 넘는 매개변수가 붙으면 안 된다.
				expect(bounds).toBeLessThanOrEqual(2 * INTERVAL_CAP + 2);
			}
		});

		test('the unread Lua scans no more elements than the cap', async () => {
			vi.useFakeTimers();
			const f = longHistoryFixture();
			await sendManyRoom(f, CAP + 150, f.violet);

			// fixture: 압축 구간 안에 떨어지는 구간 200개.
			const seeded: string[] = [];
			for (let i = 0; i < 200; i++) {
				seeded.push(`m${String(2 * i + 2).padStart(6, '0')}|m${String(2 * i + 3).padStart(6, '0')}`);
			}
			await f.redis.rpush(roomKey(f), ...seeded);
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);

			// 지연 알림이 압축된 ID마다 실제 Lua 계약으로 미읽음을 확인한다. 순회 원소 수는 목록 길이와 같다.
			await vi.advanceTimersByTimeAsync(3000);
			expect(f.redis.stats.excludedScannedMax ?? 0).toBeLessThanOrEqual(INTERVAL_CAP);
			expect(f.redis.stats.excludedScanned ?? 0).toBeGreaterThan(0);
		});
	});

	describe('the toggle race', () => {
		test('a toggle between the read and write of a close cannot orphan an open interval', async () => {
			const f = longHistoryFixture();
			await sendManyRoom(f, 1, f.violet, 'first');
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);

			// 해제 작업의 목록 읽기와 쓰기 사이에 다른 토글이 끼도록 스케줄을 고정한다.
			// 수정 전에는 lset 직전에서, 수정 후에는 원자적 기록 Lua 직전에서 멈춘다.
			let release!: () => void;
			let hit!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			const gateHit = new Promise<void>(resolve => { hit = resolve; });
			let armed = true;
			const redis = f.redis as unknown as { lset: (...args: unknown[]) => Promise<unknown>; eval: (script: string, numberOfKeys: number, ...values: string[]) => Promise<unknown> };
			const originalLset = redis.lset;
			const originalEval = redis.eval;
			redis.lset = async (...args: unknown[]) => {
				if (armed) { armed = false; hit(); await gate; }
				return originalLset(...args);
			};
			redis.eval = async (script: string, numberOfKeys: number, ...values: string[]) => {
				if (armed && script.startsWith('-- record room mute interval') && values[numberOfKeys] === '0') { armed = false; hit(); await gate; }
				return originalEval(script, numberOfKeys, ...values);
			};

			const unmute = f.chatService.muteRoom(f.reader.id, f.room.id, false);
			await gateHit;
			await f.chatService.muteRoom(f.reader.id, f.room.id, true);
			release();
			await unmute;

			// 열린 구간은 최대 하나, 항상 마지막이어야 한다.
			const list = await f.redis.lrange(roomKey(f), 0, -1) as string[];
			const openCount = opens(list).length;
			expect(openCount === 0 || (openCount === 1 && list[list.length - 1].endsWith('|'))).toBe(true);

			// 뒤이은 해제는 어떤 열린 구간도 남기지 않는다.
			await f.chatService.muteRoom(f.reader.id, f.room.id, false);
			expect(opens(await f.redis.lrange(roomKey(f), 0, -1) as string[])).toEqual([]);
		});
	});
});