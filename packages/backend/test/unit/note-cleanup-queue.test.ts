/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
vi.mock('../../src/models/_.js', () => Object.fromEntries(['MiNote', 'MiUser', 'MiClip', 'MiClipNote', 'MiChannel', 'MiPoll', 'MiDriveFile', 'MiNoteFavorite', 'MiNoteReaction', 'MiUserNotePining'].map(name => [name, { name }])));
vi.mock('../../src/models/NoteCleanupRule.js', () => ({ MiNoteCleanupRule: { name: 'Rule' }, MiNoteCleanupState: { name: 'State' } }));
vi.mock('../../src/logger.js', () => ({ default: class { error() {} warn() {} } }));
vi.mock('../../src/core/QueueService.js', () => ({ QueueService: class {} }));
vi.mock('../../src/core/NoteDeleteService.js', () => ({ NoteDeleteService: class {} }));
vi.mock('../../src/core/NotificationService.js', () => ({ NotificationService: class {} }));
vi.mock('../../src/core/IdService.js', () => ({ IdService: class {} }));
import { ReactionsBufferingService } from '../../src/core/ReactionsBufferingService.js';
import { NOTE_CLEANUP_LIMITS, NoteCleanupService } from '../../src/core/NoteCleanupService.js';
import { runCleanupBatch } from '../../src/core/NoteCleanupRunner.js';
import { AutoDeleteNotesProcessorService } from '../../src/queue/processors/AutoDeleteNotesProcessorService.js';
import UpdateAutoDeleteSettings from '../../src/server/api/endpoints/i/update-auto-delete-settings.js';

// 예약 창(5분) 경계에서 시험이 흔들리지 않도록 시각을 창 중간으로 고정한다.
const NOW = Date.UTC(2026, 10, 13, 0, 1, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const EPOCH = new Date(0);
const deleteRule = (userId: string, id: string, seconds = 60, automatic = true) => ({ id, userId, name: id, action: 'delete', enabled: true, automatic, automaticConfirmed: automatic, condition: { type: 'age', operator: 'gte', seconds }, lastError: null, legacy: null });
// 모든 노트를 보호하는 남기기 규칙
const keepAll = (userId: string, id: string) => ({ id, userId, name: id, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, condition: { type: 'age', operator: 'gte', seconds: 0 }, lastError: null, legacy: null });
const noteId = (userId: string, i: number) => `${userId}-${String(i).padStart(5, '0')}`;
const note = (userId: string, i: number) => ({ id: noteId(userId, i), userId, text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });

// 이 Redis는 예약 스크립트의 계약(KEYS별 한도, 부족한 키 번호를 음수로 반환, 허용량 전액 증가)을 JS로 흉내 낸 모형이다.
// 실제 Lua 실행·원자성·만료·클러스터 슬롯은 검증하지 않는다.
function fakeRedis() {
	const store = new Map<string, number>();
	const get = (key: string) => store.get(key) ?? 0;
	return {
		store,
		eval: async (_script: string, numKeys: number, ...args: (string | number)[]) => {
			const keys = args.slice(0, numKeys).map(String);
			const [want, , ...limits] = args.slice(numKeys).map(Number);
			let grant = want;
			for (const [i, key] of keys.entries()) {
				const left = limits[i] - get(key);
				if (left <= 0) return -(i + 1);
				grant = Math.min(grant, left);
			}
			for (const key of keys) store.set(key, get(key) + grant);
			return grant;
		},
	};
}

// 여러 계정을 담는 가짜 DB. 노트 조회는 userId·커서·개수 제한을 따른다. 트랜잭션·격리·실제 SQL은 재현하지 않는다.
function fixture() {
	const rows: Record<string, any[]> = { Rule: [], State: [], MiUser: [], MiNote: [] };
	const busy = new Set<string>();
	const scanned = new Map<string, number>();
	const failingNotes = new Set<string>();
	// retryableDeletes: 재시도 가능한 연결 오류로 삭제를 실패시킨다.
	const retryableDeletes = new Set<string>();
	const faults = { pageRules: false, noteLookup: false, lastRun: false, contexts: false };
	let afterRead: (() => void) | undefined;
	const deleteAttempts = new Map<string, number>();
	const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => typeof v === 'object' && v !== null ? true : row[k] === v);
	const repository = (entity: { name: string }) => {
		const data = rows[entity.name] ??= [];
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
					if (entity.name === 'State') {
						const order = (a: any, b: any) => a.lastRunAt.getTime() - b.lastRunAt.getTime() || a.userId.localeCompare(b.userId);
						// manualUsers: 수동 대기 마커가 있는 계정을 lastRunAt, userId 순으로
						if (sql.includes('manualRequest')) return data.filter(s => s.manualRequest != null).sort(order).slice(0, limit);
						// automaticUsers: 활성 자동 지우기 규칙이 있는 계정을 lastRunAt, userId 순으로
						return data.filter(s => rows.Rule.some(r => r.userId === s.userId && r.enabled && r.automatic && r.action === 'delete'))
							.sort(order).slice(0, limit);
					}
					if (entity.name !== 'MiNote' || !params.userId) return [];
					if (faults.noteLookup) throw new Error('note lookup failed');
					const result = data.filter(n => n.userId === params.userId && (!params.afterId || n.id > params.afterId) && (!params.ids || params.ids.includes(n.id))).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
					scanned.set(params.userId, (scanned.get(params.userId) ?? 0) + result.length);
					afterRead?.();
					return result;
				},
			};
			return self;
		};
		return {
			find: async ({ where }: any) => {
				if (entity.name === 'Rule' && faults.pageRules) throw new Error('page rules failed');
				return data.filter(row => matches(row, where));
			},
			findBy: async (where: any) => data.filter(row => matches(row, where)),
			existsBy: async (where: any) => data.some(row => matches(row, where)),
			findOneBy: async (where: any) => data.find(row => matches(row, where)) ?? null,
			findOneByOrFail: async (where: any) => { const row = data.find(row => matches(row, where)); if (!row) throw new Error(`${entity.name} not found`); return row; },
			countBy: async (where: any) => data.filter(row => matches(row, where)).length,
			save: async (input: any) => { const i = data.findIndex(row => row.id === input.id); if (i >= 0) data[i] = input; else data.push(input); return input; },
			update: async (id: string, input: any) => {
				if (entity.name === 'State' && input.lastRunAt && faults.lastRun) throw new Error('lastRun write failed');
				for (const row of data) if (row.id === id || row.userId === id) Object.assign(row, input);
			},
			delete: async (where: any) => { for (let i = data.length - 1; i >= 0; i--) if (matches(data[i], where)) data.splice(i, 1); },
			createQueryBuilder: builder,
		};
	};
	const manager = { getRepository: repository };
	const db = {
		getRepository: repository,
		transaction: async (work: (manager: unknown) => Promise<unknown>) => work(manager),
		createQueryRunner: () => ({ connect: async () => {}, query: async (_sql: string, [key]: string[]) => [{ locked: !busy.has(key) }], release: async () => {} }),
	};
	const jobs = new Map<string, unknown>();
	const added: string[] = [];
	const addedJobs: { name: string; data: Record<string, unknown>; options: Record<string, unknown> }[] = [];
	const redis = fakeRedis();
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	const merge = buffering.mergeReactions.bind(buffering);
	buffering.mergeReactions = (...args) => {
		if (faults.contexts) throw new Error('context failed');
		return merge(...args);
	};
	const noteDelete = {
		delete: async (_user: unknown, target: { id: string }) => {
			deleteAttempts.set(target.id, (deleteAttempts.get(target.id) ?? 0) + 1);
			if (retryableDeletes.has(target.id)) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
			if (failingNotes.has(target.id)) throw new Error('delete side effect failed');
			rows.MiNote.splice(rows.MiNote.findIndex(n => n.id === target.id), 1);
		},
	};
	const systemQueue = {
		toKey: (s: string) => `test:system:${s}`,
		getJob: async (id: string) => jobs.get(id),
		add: async (name: string, data: Record<string, unknown>, options: { jobId: string; delay?: number }) => {
			added.push(options.jobId); addedJobs.push({ name, data, options });
			// 실제 BullMQ처럼 고정 jobId 재등록은 같은 작업을 덮어쓴다(no-op).
			const stored: any = { id: options.jobId, name, data, getState: async () => 'waiting', remove: async () => { jobs.delete(options.jobId); } };
			jobs.set(options.jobId, stored);
		},
	};
	const waiting = { deliver: [] as { timestamp: number }[], inbox: [] as { timestamp: number }[] };
	const queueService = {
		systemQueue,
		deliverQueue: { getWaiting: async () => waiting.deliver.slice(0, 1) },
		inboxQueue: { getWaiting: async () => waiting.inbox.slice(0, 1) },
	};
	const notifications: Record<string, unknown>[] = [];
	const service = new NoteCleanupService(db as any, { gen: () => String(Math.random()), parse: () => ({ date: new Date(0) }) } as any, queueService as any, noteDelete as any, { createNotification: (userId: string, type: string, data: Record<string, unknown>) => { notifications.push({ ...data, type, userId, createdAt: new Date().toISOString() }); } } as any, redis as any, { enableReactionsBuffering: false } as any, buffering, {} as any, {} as any);
	const processor = new AutoDeleteNotesProcessorService(service, queueService as any);
	const addUser = (userId: string, lastRunAt = EPOCH) => {
		rows.MiUser.push({ id: userId, host: null, autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });
		rows.State.push({ userId, migrated: false, cursor: null, lastRunAt, manualRequest: null });
	};
	const addNotes = (userId: string, count: number) => { for (let i = 0; i < count; i++) rows.MiNote.push(note(userId, i)); };
	const notesOf = (userId: string) => rows.MiNote.filter(n => n.userId === userId);
	const state = (userId: string) => rows.State.find(s => s.userId === userId);
	const job = (data: Record<string, unknown>, id?: string) => ({ id, data: { ...data } });
	return { faults, onRead: (callback: () => void) => { afterRead = callback; }, rows, busy, scanned, failingNotes, retryableDeletes, deleteAttempts, redis, jobs, added, addedJobs, waiting, service, processor, addUser, addNotes, notesOf, state, job };
}

// 작업 한 번 실행: 완료면 'done', 마커를 남긴 대기면 'delayed'
async function run(processor: AutoDeleteNotesProcessorService, job: { data: Record<string, unknown> }) {
	const result = await processor.process(job as any) as { delayed?: boolean };
	return result.delayed ? 'delayed' : 'done';
}

// === 수동 요청과 연합 적체 ===

test('연합 큐가 밀리면 수동 정리 요청은 마커와 커서를 그대로 둔 채 기다리고 작업은 늘지 않으며 해소 후 그 커서부터 잇는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 4);
	await f.service.request('alice', ['d1']);
	// 이전 회차가 진행한 커서
	f.state('alice').manualRequest.cursor = noteId('alice', 1);
	f.waiting.deliver.push({ timestamp: NOW - 60_000 });
	const manual = f.job({ userId: 'alice', manual: true });
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.notesOf('alice')).toHaveLength(4);
	expect(f.scanned.get('alice')).toBeUndefined();
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: noteId('alice', 1) });
	expect(f.added).toHaveLength(1);
	// 자동 회차도 적체 중에는 건너뛰며 마커·커서·순번을 바꾸지 않는다.
	f.rows.Rule.push(deleteRule('alice', 'auto'));
	f.state('alice').cursor = noteId('alice', 0);
	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ skipped: true });
	expect(f.state('alice')).toMatchObject({ cursor: noteId('alice', 0), lastRunAt: EPOCH });
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: noteId('alice', 1) });
	f.waiting.deliver.length = 0;
	f.rows.Rule.pop();
	expect(await run(f.processor, manual)).toBe('done');
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 0), noteId('alice', 1)]);
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('계정별 검사·삭제 한도는 수동 요청에도 적용되고 다른 계정의 몫을 남긴다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.addUser('bob');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false), deleteRule('bob', 'b1', 60, false));
	f.addNotes('alice', 300);
	f.addNotes('bob', 10);
	await f.service.request('alice', ['d1']);
	const manual = f.job({ userId: 'alice', manual: true });
	expect(await run(f.processor, manual)).toBe('delayed');
	const aliceDeleted = 300 - f.notesOf('alice').length;
	expect(aliceDeleted).toBeGreaterThan(0);
	expect(aliceDeleted).toBeLessThanOrEqual(60);
	expect(f.state('alice').manualRequest).not.toBeNull();
	expect(f.added).toHaveLength(1);
	// 같은 창에서 다른 계정은 자기 몫으로 삭제할 수 있다.
	await f.service.request('bob', ['b1']);
	expect(await run(f.processor, f.job({ userId: 'bob', manual: true }))).toBe('done');
	expect(f.notesOf('bob')).toHaveLength(0);
	// 다음 창에서 이어 처리하면 한도가 다시 적용된다.
	vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs);
	expect(await run(f.processor, manual)).toBe('delayed');
	const total = 300 - f.notesOf('alice').length;
	expect(total).toBeGreaterThan(aliceDeleted);
	expect(total).toBeLessThanOrEqual(120);
	expect(f.added).toHaveLength(2);
});

test('보호만 하는 노트를 오래 검사하는 계정도 계정별 검사 한도에서 멈추고 마커 커서를 남겨 다음 창에 잇는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false), keepAll('alice', 'k1'));
	f.addNotes('alice', 3000);
	await f.service.request('alice', ['d1']);
	const manual = f.job({ userId: 'alice', manual: true });
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.scanned.get('alice')).toBe(NOTE_CLEANUP_LIMITS.userScan);
	expect(f.state('alice').manualRequest.cursor).toEqual(expect.any(String));
	expect(f.notesOf('alice')).toHaveLength(3000);
	expect(f.added).toHaveLength(1);
	// 다음 창에서 같은 마커로 이어 검사하고 다시 한도에서 멈춘다.
	vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs);
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.scanned.get('alice')).toBe(NOTE_CLEANUP_LIMITS.userScan * 2);
	expect(f.added).toHaveLength(1);
});

test('보존만 하는 계정은 삭제 예산을 쓰지 않아 같은 창의 뒤 계정 삭제를 막지 않는다', async () => {
	const f = fixture();
	for (let i = 0; i < 59; i++) {
		const userId = `k${String(i).padStart(2, '0')}`;
		f.addUser(userId, new Date(i + 1));
		f.rows.Rule.push(deleteRule(userId, `${userId}-d`), keepAll(userId, `${userId}-k`));
		f.addNotes(userId, 5);
	}
	f.addUser('zed', new Date(1000));
	f.rows.Rule.push(deleteRule('zed', 'zed-d'));
	f.addNotes('zed', 20);
	await f.processor.process({ data: {} } as any);
	await f.processor.process({ data: {} } as any);
	expect(f.notesOf('zed')).toHaveLength(10);
	expect(f.rows.MiNote).toHaveLength(59 * 5 + 10);
});

test('잠금 충돌·자료 실패 계정이 있어도 같은 회차의 뒤 계정을 처리하고 실패 계정은 순번을 뒤로 보낸다', async () => {
	const f = fixture();
	f.addUser('busy', new Date(1));
	f.addUser('broken', new Date(2));
	f.addUser('ok', new Date(3));
	for (const userId of ['busy', 'broken', 'ok']) {
		f.rows.Rule.push(deleteRule(userId, `${userId}-d`));
		f.addNotes(userId, 3);
	}
	f.busy.add('note-cleanup-busy');
	// 계정 자료 조회 실패를 흉내 낸다.
	f.rows.MiUser.splice(f.rows.MiUser.findIndex(u => u.id === 'broken'), 1);
	await expect(f.processor.process({ data: {} } as any)).resolves.toMatchObject({ skipped: false });
	expect(f.notesOf('ok')).toHaveLength(0);
	expect(f.notesOf('busy')).toHaveLength(3);
	expect(f.notesOf('broken')).toHaveLength(3);
	for (const userId of ['busy', 'broken']) expect(f.state(userId).lastRunAt.getTime()).toBe(NOW);
	// 수동 요청의 잠금 충돌은 실패가 아니라 마커를 보존한 채 다음 회차로 넘기는 대기다.
	f.state('busy').manualRequest = { ruleIds: ['busy-d'], cursor: null };
	expect(await run(f.processor, f.job({ userId: 'busy', manual: true }))).toBe('delayed');
	expect(f.state('busy').manualRequest).toEqual({ ruleIds: ['busy-d'], cursor: null });
	expect(f.added).toHaveLength(0);
});

test('한 노트의 지속 삭제 실패는 성공으로 세지 않고 뒤 노트를 계속 지우며 다음 순회에서 다시 검사한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.addUser('bob', new Date(1));
	f.rows.Rule.push(deleteRule('alice', 'a-d'), deleteRule('bob', 'b-d'));
	f.addNotes('alice', 4);
	f.addNotes('bob', 2);
	f.failingNotes.add(noteId('alice', 1));
	const first = await f.processor.process({ data: {} } as any) as { deletedCount: number };
	expect(first.deletedCount).toBe(3 + 2);
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 1)]);
	expect(f.notesOf('bob')).toHaveLength(0);
	expect(f.state('alice').cursor).toBeNull();
	const second = await f.service.processUser('alice');
	expect(second).toMatchObject({ deleted: 0, failed: 1 });
	expect(f.deleteAttempts.get(noteId('alice', 1))).toBe(2);
	f.failingNotes.clear();
	expect(await f.service.processUser('alice')).toMatchObject({ deleted: 1, failed: 0 });
});

test('수동 요청에서 실패한 노트는 뒤 노트의 삭제를 막지 않고 실패 수를 따로 세며 완료 뒤 마커를 지운다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 12);
	f.failingNotes.add(noteId('alice', 0));
	await f.service.request('alice', ['d1']);
	const result = await f.processor.process(f.job({ userId: 'alice', manual: true }) as any) as { deleted: number; failed: number };
	expect(result).toMatchObject({ deleted: 11, failed: 1 });
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 0)]);
	expect(f.deleteAttempts.get(noteId('alice', 0))).toBe(1);
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('설정 수정은 대기 중인 정리 요청을 취소·교체하거나 새로 등록하지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 1);
	await f.service.request('alice', ['d1']);
	const snapshot = new Map(f.jobs);
	const marker = structuredClone(f.state('alice').manualRequest);
	await f.service.save('alice', { name: '수정', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 3600 } }, 'd1');
	await f.service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	expect(f.jobs).toEqual(snapshot);
	expect(f.state('alice').manualRequest).toEqual(marker);
	expect(f.added).toHaveLength(1);
});

// === 묶음 처리와 회차 상한 ===

test('삭제 실패 처리기를 주면 실패를 성공으로 세지 않고 예산을 쓴 시도로 보며 다음 노트로 진행한다', async () => {
	const failures: string[] = [];
	const result = await runCleanupBatch([{ id: '1', decision: 'delete' }, { id: '2', decision: 'delete' }, { id: '3', decision: 'delete' }], 2, async id => { if (id === '1') throw new Error('broken'); }, id => { failures.push(id); });
	expect(failures).toEqual(['1']);
	expect(result).toEqual({ cursor: '2', deleted: 1, examined: 2 });
});

test('삭제 예산이 없어도 지울 노트 앞의 보존 노트까지는 커서를 전진한다', async () => {
	const result = await runCleanupBatch([{ id: '1', decision: 'keep' }, { id: '2', decision: 'keep' }, { id: '3', decision: 'delete' }], 0, async () => { throw new Error('must not delete'); });
	expect(result).toEqual({ cursor: '2', deleted: 0, examined: 2 });
});

test('자동 회차는 시간 상한을 넘기면 남은 계정을 건드리지 않고 다음 회차로 넘긴다', async () => {
	const f = fixture();
	for (const [i, userId] of ['first', 'second', 'third'].entries()) {
		f.addUser(userId, new Date(i + 1));
		f.rows.Rule.push(deleteRule(userId, `${userId}-d`));
		f.addNotes(userId, 2);
	}
	// 첫 계정의 삭제가 회차 시간 상한만큼 걸린 것으로 흉내 낸다.
	const original = f.service.processUser.bind(f.service);
	f.service.processUser = async (...args: Parameters<typeof original>) => {
		const result = await original(...args);
		vi.setSystemTime(Date.now() + NOTE_CLEANUP_LIMITS.roundMs);
		return result;
	};
	expect(await f.processor.process({ data: {} } as any)).toEqual({ deletedCount: 2, skipped: false });
	expect(f.notesOf('first')).toHaveLength(0);
	expect(f.scanned.get('second') ?? 0).toBe(0);
	expect(f.scanned.get('third') ?? 0).toBe(0);
	expect(f.state('second').lastRunAt).toEqual(new Date(2));
	// 다음 회차에서는 밀린 계정이 앞자리를 받는다.
	vi.setSystemTime(NOW);
	await f.processor.process({ data: {} } as any);
	expect(f.notesOf('second')).toHaveLength(0);
});

test('전역 삭제 예산이 다 찬 회차는 뒤 계정의 검사 예산을 쓰지 않고 멈추며 그 계정들의 순번을 보존한다', async () => {
	const f = fixture();
	for (const [i, userId] of ['first', 'second'].entries()) {
		f.addUser(userId, new Date(i + 1));
		f.rows.Rule.push(deleteRule(userId, `${userId}-d`));
		f.addNotes(userId, 2);
	}
	const window = Math.floor(NOW / NOTE_CLEANUP_LIMITS.windowMs);
	f.redis.store.set(`test:system:note-cleanup-budget:{${window}}:delete:global`, NOTE_CLEANUP_LIMITS.globalDelete);
	expect(await f.processor.process({ data: {} } as any)).toEqual({ deletedCount: 0, skipped: false });
	expect(f.rows.MiNote).toHaveLength(4);
	expect(f.scanned.get('second') ?? 0).toBe(0);
	expect(f.state('second').lastRunAt).toEqual(new Date(2));
});

test('수동 요청은 한 작업에서 회차 시간 상한까지만 이어 처리하고 커서를 마커에 남겨 다음 회차가 잇는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 30);
	const original = f.service.continueManual.bind(f.service);
	f.service.continueManual = async (...args: Parameters<typeof original>) => {
		const result = await original(...args);
		vi.setSystemTime(Date.now() + NOTE_CLEANUP_LIMITS.roundMs / 2);
		return result;
	};
	await f.service.request('alice', ['d1']);
	const manual = f.job({ userId: 'alice', manual: true });
	expect(await run(f.processor, manual)).toBe('delayed');
	// 두 페이지(삭제 시도 5개씩)를 처리한 뒤 시간 상한에 걸린다. 자식 작업 없이 마커에 커서를 남긴다.
	expect(f.notesOf('alice')).toHaveLength(20);
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: noteId('alice', 9) });
	expect(f.added).toHaveLength(1);
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.notesOf('alice')).toHaveLength(10);
	expect(f.state('alice').manualRequest.cursor).toBe(noteId('alice', 19));
	expect(f.added).toHaveLength(1);
});

test('구 API는 정리 잠금 충돌을 500 대신 기존 API 오류 형식의 CLEANUP_BUSY로 알리고 아무것도 바꾸지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.busy.add('note-cleanup-alice');
	const before = structuredClone(f.rows);
	const endpoint = new UpdateAutoDeleteSettings(f.service);
	await expect(endpoint.exec({ autoDeleteNotesAfterDays: 30 }, { id: 'alice' } as any, null, null)).rejects.toMatchObject({ code: 'CLEANUP_BUSY', id: 'ef801a30-12f2-4f79-a60d-2a94c8c42302', kind: 'server', httpStatusCode: 503 });
	expect(f.rows).toEqual(before);
});

test('이전 자동 회차가 아직 잠금을 쥐고 있으면 새 회차는 실패하지 않고 건너뛰며 계정 상태를 바꾸지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'a-d'));
	f.addNotes('alice', 2);
	f.busy.add('note-cleanup-scheduler');
	await expect(f.processor.process({ data: {} } as any)).resolves.toEqual({ deletedCount: 0, skipped: true });
	expect(f.notesOf('alice')).toHaveLength(2);
	expect(f.state('alice')).toMatchObject({ cursor: null, lastRunAt: EPOCH });
});

// === 예약 예산 전액 소비 ===

// 서비스는 실제로 실행하고 DB·Redis 경계의 실패만 주입한다. 이 모형은 실제 SQL·Lua 실행 근거가 아니다.
const scanKey = (scope: string, time = NOW) => `test:system:note-cleanup-budget:{${Math.floor(time / NOTE_CLEANUP_LIMITS.windowMs)}}:scan:${scope}`;
const scanUsed = (f: ReturnType<typeof fixture>, scope: string, time = NOW) => f.redis.store.get(scanKey(scope, time)) ?? 0;
const deleteKey = (scope: string, time = NOW) => `test:system:note-cleanup-budget:{${Math.floor(time / NOTE_CLEANUP_LIMITS.windowMs)}}:delete:${scope}`;
const deleteUsed = (f: ReturnType<typeof fixture>, scope: string, time = NOW) => f.redis.store.get(deleteKey(scope, time)) ?? 0;

function scanFixture(count = 3) {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'delete'), keepAll('alice', 'keep'));
	f.addNotes('alice', count);
	return f;
}

// 다른 계정·요청이 이미 쓴 양을 채워 두어 한도 근처에서 일부만 예약되게 한다.
const nearLimits = [
	['global', 'user:alice', NOTE_CLEANUP_LIMITS.globalScan - 10, 10],
	['user:alice', 'global', NOTE_CLEANUP_LIMITS.userScan - 50, 50],
] as const;

test.each([
	['pageRules', 'page rules failed'],
	['lastRun', 'lastRun write failed'],
] as const)('검사 전 %s 실패도 예약한 검사 예산 전부를 소비한다', async (fault, message) => {
	const f = scanFixture();
	f.faults[fault] = true;

	await expect(f.service.processUser('alice')).rejects.toThrow(message);

	expect(f.scanned.get('alice')).toBeUndefined();
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(f.notesOf('alice')).toHaveLength(3);
});

test('노트를 불러온 뒤 자료 판정이 실패해도 예약한 검사 예산 전부를 소비한다', async () => {
	const f = scanFixture();
	f.faults.contexts = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('context failed');

	expect(f.scanned.get('alice')).toBe(3);
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(f.notesOf('alice')).toHaveLength(3);
});

test('대상 조회가 실패해도 예약한 검사 예산 전부를 소비한다', async () => {
	const f = scanFixture();
	f.faults.noteLookup = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('note lookup failed');

	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
});

test.each([0, 3, NOTE_CLEANUP_LIMITS.pageSize])('정상 %i건 페이지도 예약한 검사 예산 전부를 소비한다', async count => {
	const f = scanFixture(count);

	await f.service.processUser('alice');

	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
});

test('처리 중 창이 바뀌어도 예약은 원래 창에 기록된다', async () => {
	const f = scanFixture();
	f.faults.contexts = true;
	f.onRead(() => { vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs); });

	await expect(f.service.processUser('alice')).rejects.toThrow('context failed');

	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(f.redis.store.has(scanKey('global', NOW + NOTE_CLEANUP_LIMITS.windowMs))).toBe(false);
});

test('검사 전 실패가 반복되면 계정 한도에서 멈추고 뒤 계정은 진행한다', async () => {
	const f = scanFixture();
	f.addUser('bob');
	f.rows.Rule.push(deleteRule('bob', 'bob-delete'));
	f.addNotes('bob', 1);
	f.faults.pageRules = true;

	for (let i = 0; i < NOTE_CLEANUP_LIMITS.userScan / NOTE_CLEANUP_LIMITS.pageSize; i++) {
		await expect(f.service.processUser('alice')).rejects.toThrow('page rules failed');
	}
	f.faults.pageRules = false;
	const alice = await f.service.processUser('alice');
	const bob = await f.service.processUser('bob');

	expect(alice.throttled).toBe('account');
	expect(bob.deleted).toBe(1);
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.userScan + NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.userScan);
});

test('불명확한 조회 실패가 반복되면 계정 한도에서 멈추고 뒤 계정은 진행한다', async () => {
	const f = scanFixture();
	f.addUser('bob');
	f.rows.Rule.push(deleteRule('bob', 'bob-delete'));
	f.addNotes('bob', 1);
	f.faults.noteLookup = true;

	for (let i = 0; i < NOTE_CLEANUP_LIMITS.userScan / NOTE_CLEANUP_LIMITS.pageSize; i++) {
		await expect(f.service.processUser('alice')).rejects.toThrow('note lookup failed');
	}
	f.faults.noteLookup = false;
	const alice = await f.service.processUser('alice');
	const bob = await f.service.processUser('bob');

	expect(alice.throttled).toBe('account');
	expect(bob.deleted).toBe(1);
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.userScan + NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.userScan);
});

test.each(nearLimits)('%s 한도 근처에서 일부만 예약하면 실패해도 받은 양 전부를 소비한다', async (limited, other, used, grant) => {
	for (const fault of ['pageRules', 'contexts'] as const) {
		const f = scanFixture();
		f.redis.store.set(scanKey(limited), used);
		f.faults[fault] = true;

		await expect(f.service.processUser('alice')).rejects.toThrow(fault === 'pageRules' ? 'page rules failed' : 'context failed');

		expect(scanUsed(f, limited)).toBe(used + grant);
		expect(scanUsed(f, other)).toBe(grant);
	}
});

test('수동 요청의 재시도 가능한 삭제 실패도 예약한 삭제 예산 전부를 소비한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 3);
	f.retryableDeletes.add(noteId('alice', 1));

	await expect(f.service.processUser('alice', ['d1'])).rejects.toThrow('Connection terminated unexpectedly');

	// 노트 0 삭제 성공 + 노트 1 삭제 시도 실패뿐이어도 예약 3개 전부를 소비한다.
	expect(deleteUsed(f, 'global')).toBe(3);
	expect(deleteUsed(f, 'user:alice')).toBe(3);
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 1), noteId('alice', 2)]);
});

// === 수동 요청 마커와 깨우기 작업 ===

test('수동 요청의 비재시도 오류는 마커를 지우고 종료 실패로 처리해 무한 재시도를 막는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 1);
	await f.service.request('alice', ['d1']);
	// 큐 등록 뒤 계정이 물리 삭제된 상태
	f.rows.MiUser.splice(0);

	await expect(f.processor.process(f.job({ userId: 'alice', manual: true }) as any)).rejects.toBeInstanceOf(UnrecoverableError);

	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('종료 실패로 마커가 지워지면 같은 사용자가 새 요청을 접수할 수 있다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	const first = await f.service.request('alice', ['d1']);
	f.rows.MiUser.splice(0);
	await expect(f.processor.process(f.job({ userId: 'alice', manual: true }) as any)).rejects.toBeInstanceOf(UnrecoverableError);
	f.rows.MiUser.push({ id: 'alice', host: null, autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });

	const second = await f.service.request('alice', ['d1']);

	expect(second.queued).toBe(true);
	expect(second.jobId).toBe(first.jobId);
});

test('깨우기 작업은 유한 재시도와 보존 기한을 두고 완료 뒤 자동 제거되며 대기는 작업을 쌓지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 2);
	await f.service.request('alice', ['d1']);
	const options = f.addedJobs[0].options as any;
	expect(options.removeOnComplete).toBe(true);
	expect(options.attempts).toBeLessThan(1000);
	expect(options.removeOnFail).toMatchObject({ age: expect.any(Number) });
	f.waiting.deliver.push({ timestamp: NOW - 60_000 });

	expect(await run(f.processor, f.job({ userId: 'alice', manual: true }))).toBe('delayed');

	expect(f.addedJobs).toHaveLength(1);
});

test('최종 완료는 마커를 지우고 별도 정리 작업을 등록하지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 1);
	await f.service.request('alice', ['d1']);

	expect(await run(f.processor, f.job({ userId: 'alice', manual: true }))).toBe('done');

	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.notesOf('alice')).toHaveLength(0);
	expect(f.added).toHaveLength(1);
});

// 매 페이지 뒤 회차 시간 상한의 절반만큼 시각을 당겨, 작업 하나가 두 페이지 처리 후 대기하도록 한다.
function hopFixture() {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 30);
	const original = f.service.continueManual.bind(f.service);
	f.service.continueManual = async (...args: Parameters<typeof original>) => {
		const result = await original(...args);
		vi.setSystemTime(Date.now() + NOTE_CLEANUP_LIMITS.roundMs / 2);
		return result;
	};
	return f;
}

test('여러 홉으로 이어지는 수동 요청은 마커 하나로 유지되고 대기 동안 작업이 늘지 않으며 중복 접수를 막는다', async () => {
	const f = hopFixture();
	const first = await f.service.request('alice', ['d1']);
	expect(first.jobId).toBe('note-cleanup-alice');
	const manual = f.job({ userId: 'alice', manual: true });
	// 홉 1: 두 페이지 처리 뒤 시간 상한으로 대기. 자식 작업은 없다.
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: noteId('alice', 9) });
	expect(f.added).toHaveLength(1);
	// 진행 중 재요청은 규칙 조합이 달라도 접수하지 않는다.
	f.rows.Rule.push(deleteRule('alice', 'd2', 120, false));
	expect((await f.service.request('alice', ['d2'])).queued).toBe(false);
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: noteId('alice', 9) });
	expect(f.added).toHaveLength(1);
	// 홉 2, 홉 3: 같은 마커로 이어 처리하고 완료하면 마커를 지운다.
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.state('alice').manualRequest.cursor).toBe(noteId('alice', 19));
	expect(await run(f.processor, manual)).toBe('done');
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.notesOf('alice')).toHaveLength(0);
	expect(f.added).toHaveLength(1);
	// 완료 뒤 새 요청은 같은 고정 작업 ID로 다시 접수한다.
	expect((await f.service.request('alice', ['d1'])).queued).toBe(true);
	expect(f.added).toHaveLength(2);
});

test('깨우기 작업이 중단·유실돼도 마커가 요청을 보존하고 회차가 이어 처리한다', async () => {
	const f = hopFixture();
	await f.service.request('alice', ['d1']);
	const manual = f.job({ userId: 'alice', manual: true });
	expect(await run(f.processor, manual)).toBe('delayed');
	const cursor = f.state('alice').manualRequest.cursor;
	// 같은 작업이 스톨 등으로 재실행돼도 마커 커서부터 잇고 작업은 늘지 않는다.
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.state('alice').manualRequest.cursor).not.toBe(cursor);
	expect(f.added).toHaveLength(1);
	// 깨우기 작업이 유실된 상태에서는 자동 회차가 마커를 찾아 이어 처리한다.
	f.jobs.clear();
	vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs * 2);
	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ deletedCount: 10, skipped: false });
	expect(f.notesOf('alice')).toHaveLength(0);
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('수동 요청 접수는 대기 마커를 남기고 사용자별 고정 깨우기 작업을 등록한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 2);

	const result = await f.service.request('alice', ['d1']);

	expect(result).toEqual({ queued: true, jobId: 'note-cleanup-alice' });
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: null });
	expect(f.addedJobs).toHaveLength(1);
	expect(f.addedJobs[0].data).toEqual({ userId: 'alice', manual: true });
	expect(f.addedJobs[0].options).toMatchObject({ jobId: 'note-cleanup-alice', removeOnComplete: true, attempts: 10, backoff: { type: 'fixed', delay: 5000 }, removeOnFail: { age: 7 * 86400 } });
});

test('깨우기 작업은 접수 직후 시작해 완료까지 처리하고 마커를 지운다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 3);
	await f.service.request('alice', ['d1']);

	expect(await run(f.processor, f.job({ userId: 'alice', manual: true }))).toBe('done');

	expect(f.notesOf('alice')).toHaveLength(0);
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('대기 중인 수동 요청이 있으면 다른 규칙 조합의 재요청도 접수하지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false), deleteRule('alice', 'd2', 120, false));
	f.addNotes('alice', 2);
	const first = await f.service.request('alice', ['d1']);

	const second = await f.service.request('alice', ['d2']);

	expect(second).toEqual({ queued: false, jobId: first.jobId });
	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: null });
	expect(f.added).toHaveLength(1);
});

test('일시 DB 장애는 마커를 보존하고 복구 뒤 회차가 같은 커서부터 이어 처리한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 12);
	await f.service.request('alice', ['d1']);
	f.state('alice').manualRequest.cursor = noteId('alice', 4);
	f.retryableDeletes.add(noteId('alice', 5));

	expect(await run(f.processor, f.job({ userId: 'alice', manual: true }))).toBe('delayed');

	expect(f.state('alice').manualRequest).toEqual({ ruleIds: ['d1'], cursor: noteId('alice', 4) });
	expect(f.added).toHaveLength(1);
	f.retryableDeletes.clear();
	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ deletedCount: 7, skipped: false });
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 0), noteId('alice', 1), noteId('alice', 2), noteId('alice', 3), noteId('alice', 4)]);
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('회차는 수동 대기 계정을 먼저 처리하고 남은 계정 몫만 자동 검사에 쓴다', async () => {
	const f = fixture();
	for (let i = 0; i < NOTE_CLEANUP_LIMITS.roundUsers; i++) {
		const userId = `m${String(i).padStart(2, '0')}`;
		f.addUser(userId, new Date(i + 1));
		f.rows.Rule.push(deleteRule(userId, `${userId}-d`, 60, false));
		f.addNotes(userId, 1);
		f.state(userId).manualRequest = { ruleIds: [`${userId}-d`], cursor: null };
	}
	f.addUser('auto', new Date(1000));
	f.rows.Rule.push(deleteRule('auto', 'auto-d'));
	f.addNotes('auto', 1);

	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ deletedCount: NOTE_CLEANUP_LIMITS.roundUsers, skipped: false });

	expect(f.notesOf('auto')).toHaveLength(1);
	expect(f.state('auto').lastRunAt).toEqual(new Date(1000));
	for (let i = 0; i < NOTE_CLEANUP_LIMITS.roundUsers; i++) expect(f.state(`m${String(i).padStart(2, '0')}`).manualRequest).toBeNull();
	// 다음 회차는 자동 계정을 처리한다.
	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ deletedCount: 1 });
	expect(f.notesOf('auto')).toHaveLength(0);
});

test('예산 대기 중인 수동 요청은 다음 창 회차가 마커로 이어 처리한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 70);
	await f.service.request('alice', ['d1']);
	const manual = f.job({ userId: 'alice', manual: true });
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(70 - f.notesOf('alice').length).toBe(60);
	expect(f.state('alice').manualRequest).not.toBeNull();

	// 다음 창 회차가 남은 노트를 이어 지운다.
	vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs);
	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ deletedCount: 10, skipped: false });

	expect(f.notesOf('alice')).toHaveLength(0);
	expect(f.state('alice').manualRequest).toBeNull();
	expect(f.added).toHaveLength(1);
});

test('마커가 없는 깨우기 작업은 아무것도 하지 않고 완료한다', async () => {
	const f = fixture();
	f.addUser('alice');

	expect(await run(f.processor, f.job({ userId: 'alice', manual: true }))).toBe('done');

	expect(f.added).toHaveLength(0);
	expect(f.scanned.get('alice')).toBeUndefined();
});

test('회차 중 수동 계정의 종료 실패는 같은 회차의 다른 계정을 멈추지 않는다', async () => {
	const f = fixture();
	f.addUser('gone', new Date(1));
	f.addUser('ok', new Date(2));
	f.rows.Rule.push(deleteRule('gone', 'gone-d', 60, false), deleteRule('ok', 'ok-d', 60, false));
	f.addNotes('gone', 1);
	f.addNotes('ok', 1);
	f.state('gone').manualRequest = { ruleIds: ['gone-d'], cursor: null };
	f.state('ok').manualRequest = { ruleIds: ['ok-d'], cursor: null };
	f.rows.MiUser.splice(f.rows.MiUser.findIndex(u => u.id === 'gone'), 1);

	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ deletedCount: 1, skipped: false });

	expect(f.state('gone').manualRequest).toBeNull();
	expect(f.state('ok').manualRequest).toBeNull();
	expect(f.notesOf('ok')).toHaveLength(0);
	expect(f.added).toHaveLength(0);
});
