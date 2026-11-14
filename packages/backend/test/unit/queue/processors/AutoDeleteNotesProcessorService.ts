/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Test } from '@nestjs/testing';
import { FindOperator } from 'typeorm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MiNote, MiNoteFavorite, MiUser } from '@/models/_.js';
import { MiNoteCleanupRule, MiNoteCleanupState } from '@/models/NoteCleanupRule.js';
import { QueueService } from '@/core/QueueService.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';
import { NoteCleanupService } from '@/core/NoteCleanupService.js';
import { initialCleanupRules } from '@/core/NoteCleanupRunner.js';
import { AutoDeleteNotesProcessorService } from '@/queue/processors/AutoDeleteNotesProcessorService.js';

// 처리기와 정리 서비스가 남기는 오류 기록을 검사한다.
const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/logger.js', () => ({ default: class { error(...args: unknown[]) { logged.push(args); } warn() {} info() {} succ() {} } }));

// 이 처리기는 이제 계정별 정리 규칙을 판정하는 NoteCleanupService에 위임한다.
// 기존 시험이 확인하던 자동 삭제 의미(정상 삭제 경로·소유자 기준 즐겨찾기 보호·실패 격리·사라진 후보·비활성 설정)를
// 마이그레이션이 만든 호환 규칙(initialCleanupRules(true, ...))으로 같은 실제 진입점 processor.process()에서 검증한다.
// 계정당 1000개 일괄 삭제·processedUsers 응답은 예산이 있는 페이지 처리로 바뀌었고, 그 상한은 note-cleanup-queue.test.ts가 다룬다.
// 가짜 DB·Redis·큐는 실제 SQL·Lua·BullMQ 동작을 재현하지 않는다.

const NOW = Date.UTC(2026, 0, 31);
const DAY = 86400_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	logged.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// typeorm 조회 연산자 중 이 경로가 쓰는 In·IsNull만 해석하고, 나머지 조건은 값 비교로 본다.
function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, value]) => {
		if (value instanceof FindOperator) {
			if (value.type === 'in') return (value.value as unknown[]).includes(row[key]);
			if (value.type === 'isNull') return row[key] == null;
			throw new Error(`unsupported operator ${value.type}`);
		}
		return row[key] === value;
	});
}

async function fixture() {
	const rows = new Map<string, Record<string, any>[]>();
	const table = (entity: { name: string }) => {
		let data = rows.get(entity.name);
		if (!data) rows.set(entity.name, data = []);
		return data;
	};
	const createdAt = new Map<string, number>();
	const favoriteLookups: Record<string, unknown>[] = [];
	const noteRepositoryDeletes: unknown[] = [];
	// 페이지 조회 직후 다른 경로에서 지워진 노트를 흉내 낸다.
	const vanishAfterScan = new Set<string>();
	const failingNotes = new Set<string>();

	const repository = (entity: { name: string }) => {
		const data = table(entity);
		const builder = () => {
			const params: Record<string, any> = {};
			let limit = Infinity;
			let sql = '';
			const self: any = {
				where: (s: string, p?: object) => { sql = s; Object.assign(params, p); return self; },
				andWhere: (s: string, p?: object) => { sql += ` ${s}`; Object.assign(params, p); return self; },
				innerJoin: () => self, select: () => self, orderBy: () => self, addOrderBy: () => self,
				take: (n: number) => { limit = n; return self; },
				getRawMany: async () => [],
				getMany: async () => {
					if (entity === MiNoteCleanupState) {
						const order = (a: any, b: any) => a.lastRunAt.getTime() - b.lastRunAt.getTime() || a.userId.localeCompare(b.userId);
						// manualUsers: 수동 대기 마커가 있는 계정을 lastRunAt, userId 순으로
						if (sql.includes('manualRequest')) return data.filter(s => s.manualRequest != null).sort(order).slice(0, limit);
						// automaticUsers: 활성 자동 지우기 규칙이 있는 계정을 lastRunAt, userId 순으로
						return data.filter(s => table(MiNoteCleanupRule).some(r => r.userId === s.userId && r.enabled && r.automatic && r.action === 'delete'))
							.sort(order).slice(0, limit);
					}
					if (entity !== MiNote) return [];
					const result = data.filter(n => n.userId === params.userId && (!params.afterId || n.id > params.afterId))
						.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(n => ({ ...n }));
					for (const id of vanishAfterScan) {
						const i = data.findIndex(n => n.id === id);
						if (i >= 0) data.splice(i, 1);
					}
					return result;
				},
			};
			return self;
		};
		return {
			find: async ({ where }: any) => data.filter(row => matches(row, where)).sort((a, b) => String(a.id).localeCompare(String(b.id))),
			findBy: async (where: any) => {
				if (entity === MiNoteFavorite) favoriteLookups.push(where);
				return data.filter(row => matches(row, where));
			},
			existsBy: async (where: any) => data.some(row => matches(row, where)),
			findOneBy: async (where: any) => data.find(row => matches(row, where)) ?? null,
			findOneByOrFail: async (where: any) => {
				const row = data.find(row => matches(row, where));
				if (!row) throw new Error(`${entity.name} not found`);
				return row;
			},
			countBy: async (where: any) => data.filter(row => matches(row, where)).length,
			update: async (id: string, input: any) => { for (const row of data) if (row.id === id || row.userId === id) Object.assign(row, input); },
			delete: async (where: any) => {
				if (entity === MiNote) noteRepositoryDeletes.push(where);
				for (let i = data.length - 1; i >= 0; i--) if (matches(data[i], where)) data.splice(i, 1);
			},
			createQueryBuilder: builder,
		};
	};
	const db = {
		getRepository: repository,
		transaction: async (work: (manager: unknown) => Promise<unknown>) => work({ getRepository: repository }),
		createQueryRunner: () => ({ connect: async () => {}, query: async () => [{ locked: true }], release: async () => {} }),
	};

	// 예약 스크립트의 계약(키별 한도, 부족한 키 번호를 음수로 반환, 허용량 전액 증가)만 흉내 낸 모형이다.
	const budget = new Map<string, number>();
	const redis = {
		eval: async (_script: string, numKeys: number, ...args: (string | number)[]) => {
			const keys = args.slice(0, numKeys).map(String);
			const argv = args.slice(numKeys).map(Number);
			const get = (key: string) => budget.get(key) ?? 0;
			const [want, , ...limits] = argv;
			let grant = want;
			for (const [i, key] of keys.entries()) {
				const left = limits[i] - get(key);
				if (left <= 0) return -(i + 1);
				grant = Math.min(grant, left);
			}
			for (const key of keys) budget.set(key, get(key) + grant);
			return grant;
		},
	};

	const deleteNote = vi.fn(async (_user: unknown, target: { id: string }) => {
		if (failingNotes.has(target.id)) throw new Error('Deletion failed');
		const notes = table(MiNote);
		notes.splice(notes.findIndex(n => n.id === target.id), 1);
	});
	const queueService = {
		systemQueue: { toKey: (key: string) => `test:system:${key}` },
		deliverQueue: { getWaiting: async () => [] },
		inboxQueue: { getWaiting: async () => [] },
	};
	let sequence = 0;
	const idService = { gen: () => `rule-${String(sequence++).padStart(4, '0')}`, parse: (id: string) => ({ date: new Date(createdAt.get(id) ?? 0) }) };
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	const notifications: Record<string, unknown>[] = [];
	const service = new NoteCleanupService(db as any, idService as any, queueService as any, { delete: deleteNote } as any, { createNotification: (userId: string, type: string, data: Record<string, unknown>) => { notifications.push({ ...data, type, userId, createdAt: new Date().toISOString() }); } } as any, redis as any, { enableReactionsBuffering: false } as any, buffering, {} as any, {} as any);

	// 처리기의 생성자 의존성을 Nest가 실제로 해석할 수 있는지도 함께 확인한다.
	const app = await Test.createTestingModule({
		providers: [
			AutoDeleteNotesProcessorService,
			{ provide: NoteCleanupService, useValue: service },
			{ provide: QueueService, useValue: queueService },
		],
	}).compile();

	// 마이그레이션은 로컬 계정마다 상태를 만들고, 양수 기간만 자동 지우기 규칙으로, 즐겨찾기 보호는 설정값 그대로 옮긴다.
	const user = (id: string, days: number | null = 30, keepFavorites = true) => {
		const row = { id, host: null, autoDeleteNotesAfterDays: days, autoDeleteKeepFavorites: keepFavorites };
		table(MiUser).push(row);
		table(MiNoteCleanupState).push({ userId: id, migrated: true, cursor: null, lastRunAt: new Date(0), manualRequest: null });
		for (const input of initialCleanupRules(true, days, keepFavorites)) {
			table(MiNoteCleanupRule).push({ ...input, id: idService.gen(), userId: id, lastError: null, protectionNotified: false, automaticConfirmed: input.automatic });
		}
		return row;
	};
	const note = (id: string, userId: string, ageDays = 40) => {
		createdAt.set(id, NOW - ageDays * DAY);
		const row = { id, userId, text: 'Old note', cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] };
		table(MiNote).push(row);
		return row;
	};
	const favorite = (noteId: string, userId: string) => { table(MiNoteFavorite).push({ id: `fav-${noteId}-${userId}`, noteId, userId }); };
	const remaining = () => table(MiNote).map(n => n.id).sort();
	const state = (userId: string) => table(MiNoteCleanupState).find(s => s.userId === userId)!;
	return {
		app,
		processor: app.get(AutoDeleteNotesProcessorService),
		user, note, favorite, remaining, state,
		deleteNote, favoriteLookups, noteRepositoryDeletes, vanishAfterScan, failingNotes,
	};
}

// 자동 회차는 작업 데이터 없이 실행된다.
const automaticRound = { data: {} } as never;

describe('AutoDeleteNotesProcessorService', () => {
	test('deletes expired notes through the normal note deletion service with federation enabled', async () => {
		const f = await fixture();
		try {
			const alice = f.user('alice');
			const oldNote = f.note('old-note', 'alice', 40);
			f.note('recent-note', 'alice', 10);
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 1, skipped: false });
			// 노트 행을 직접 지우지 않고 통계·검색·연합 삭제를 수행하는 정상 삭제 서비스를 연합 전송 켬(false)으로 부른다.
			expect(f.deleteNote).toHaveBeenCalledExactlyOnceWith(alice, expect.objectContaining({ id: oldNote.id }), false);
			expect(f.noteRepositoryDeletes).toEqual([]);
			// 이관된 기간 규칙(30일 초과)은 기간이 지나지 않은 노트를 남긴다.
			expect(f.remaining()).toEqual(['recent-note']);
		} finally {
			await f.app.close();
		}
	});

	test('scopes favorite protection to the note owner instead of any favoriter', async () => {
		const f = await fixture();
		try {
			f.user('alice', 30, true);
			f.user('bob', 30, true);
			f.note('alice-note', 'alice');
			f.note('bob-note', 'bob');
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 2, skipped: false });
			// 즐겨찾기 조회는 각 페이지의 노트 소유자로만 한정된다.
			expect(f.favoriteLookups.map(where => where.userId)).toEqual(['alice', 'bob']);
		} finally {
			await f.app.close();
		}
	});

	test('does not let another user\'s favorite exempt the owner\'s note from deletion', async () => {
		const f = await fixture();
		try {
			f.user('alice', 30, true);
			f.note('favorited-by-mallory', 'alice');
			f.favorite('favorited-by-mallory', 'mallory');
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 1, skipped: false });
			expect(f.remaining()).toEqual([]);
		} finally {
			await f.app.close();
		}
	});

	test('keeps notes favorited by the owner even when other users also favorited them', async () => {
		const f = await fixture();
		try {
			f.user('alice', 30, true);
			for (const id of ['by-owner', 'by-owner-and-mallory', 'by-mallory', 'plain']) f.note(id, 'alice');
			f.favorite('by-owner', 'alice');
			f.favorite('by-owner-and-mallory', 'mallory');
			f.favorite('by-owner-and-mallory', 'alice');
			f.favorite('by-mallory', 'mallory');
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 2, skipped: false });
			expect(f.remaining()).toEqual(['by-owner', 'by-owner-and-mallory']);
		} finally {
			await f.app.close();
		}
	});

	test('ignores every favorite when favorite protection is disabled', async () => {
		const f = await fixture();
		try {
			f.user('alice', 30, false);
			for (const id of ['by-owner', 'by-mallory', 'plain']) f.note(id, 'alice');
			f.favorite('by-owner', 'alice');
			f.favorite('by-mallory', 'mallory');
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 3, skipped: false });
			expect(f.remaining()).toEqual([]);
		} finally {
			await f.app.close();
		}
	});

	test('continues after one deletion fails and counts only successful deletions across users', async () => {
		const f = await fixture();
		try {
			const alice = f.user('alice');
			const bob = f.user('bob', 7, false);
			f.note('failed', 'alice');
			const succeeding = f.note('succeeding', 'alice');
			const otherUser = f.note('other-user', 'bob');
			f.failingNotes.add('failed');
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 2, skipped: false });
			expect(f.deleteNote).toHaveBeenCalledTimes(3);
			expect(f.deleteNote).toHaveBeenNthCalledWith(2, alice, expect.objectContaining({ id: succeeding.id }), false);
			expect(f.deleteNote).toHaveBeenNthCalledWith(3, bob, expect.objectContaining({ id: otherUser.id }), false);
			expect(f.remaining()).toEqual(['failed']);
			expect(logged).toContainEqual(['Cleanup note deletion failed', expect.objectContaining({ userId: 'alice', noteId: 'failed' })]);
		} finally {
			await f.app.close();
		}
	});

	test('does not replay deletion effects for a candidate that has already disappeared', async () => {
		const f = await fixture();
		try {
			const alice = f.user('alice');
			f.note('gone', 'alice');
			const remaining = f.note('remaining', 'alice');
			f.vanishAfterScan.add('gone');
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 1, skipped: false });
			expect(f.deleteNote).toHaveBeenCalledExactlyOnceWith(alice, expect.objectContaining({ id: remaining.id }), false);
		} finally {
			await f.app.close();
		}
	});

	test('skips disabled or invalid settings and handles an empty eligible batch', async () => {
		const f = await fixture();
		try {
			for (const [id, days] of [['disabled', null], ['zero', 0], ['negative', -1], ['empty', 30]] as const) f.user(id, days);
			f.note('recent', 'empty', 1);
			expect(await f.processor.process(automaticRound)).toEqual({ deletedCount: 0, skipped: false });
			expect(f.deleteNote).not.toHaveBeenCalled();
			// 기간이 없거나 0 이하인 계정은 자동 지우기 규칙이 없어 검사 순번에도 들지 않는다.
			for (const id of ['disabled', 'zero', 'negative']) expect(f.state(id).lastRunAt).toEqual(new Date(0));
			expect(f.state('empty').lastRunAt).toEqual(new Date(NOW));
			expect(f.remaining()).toEqual(['recent']);
		} finally {
			await f.app.close();
		}
	});
});
