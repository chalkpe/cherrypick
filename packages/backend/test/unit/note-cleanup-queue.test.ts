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
vi.mock('../../src/core/CacheService.js', () => ({ CacheService: class {} }));
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

// 이 Redis는 예약 스크립트의 계약(KEYS별 한도, 부족한 키 번호를 음수로 반환, 반납)을 JS로 흉내 낸 모형이다.
// 실제 Lua 실행·원자성·만료·클러스터 슬롯은 검증하지 않는다. numKeys=1은 수정 전 전역 300/5 예약 스크립트의 모형이다.
function fakeRedis() {
	const store = new Map<string, number>();
	const get = (key: string) => store.get(key) ?? 0;
	return {
		store,
		eval: async (_script: string, numKeys: number, ...args: (string | number)[]) => {
			const keys = args.slice(0, numKeys).map(String);
			const argv = args.slice(numKeys).map(Number);
			if (numKeys === 1 && argv.length === 0) {
				if (get(keys[0]) + 5 > 300) return 0;
				store.set(keys[0], get(keys[0]) + 5);
				return 5;
			}
			if (argv.length === 1) {
				for (const key of keys) store.set(key, Math.max(0, get(key) - Math.min(argv[0], get(key))));
				return argv[0];
			}
			const [want, , ...limits] = argv;
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
	const faults = { pageRules: false, noteLookup: false, lastRun: false, contexts: false, release: false };
	let afterRead: (() => void) | undefined;
	const deleteAttempts = new Map<string, number>();
	const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => typeof v === 'object' && v !== null ? true : row[k] === v);
	const repository = (entity: { name: string }) => {
		const data = rows[entity.name] ??= [];
		const builder = () => {
			const params: Record<string, any> = {};
			let limit = Infinity;
			const self: any = {
				where: (_sql: string, p?: object) => { Object.assign(params, p); return self; },
				andWhere: (_sql: string, p?: object) => { Object.assign(params, p); return self; },
				innerJoin: () => self, select: () => self, orderBy: () => self, addOrderBy: () => self,
				take: (n: number) => { limit = n; return self; },
				getRawMany: async () => [],
				getMany: async () => {
					if (entity.name === 'State') {
						// automaticUsers: 활성 자동 지우기 규칙이 있는 계정을 lastRunAt, userId 순으로
						return data.filter(s => rows.Rule.some(r => r.userId === s.userId && r.enabled && r.automatic && r.action === 'delete'))
							.sort((a, b) => a.lastRunAt.getTime() - b.lastRunAt.getTime() || a.userId.localeCompare(b.userId)).slice(0, limit);
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
	const evaluate = redis.eval;
	redis.eval = async (script, count, ...args) => {
		if (faults.release && args.length === count + 1) throw new Error('release failed');
		return evaluate(script, count, ...args);
	};
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
	let continuation: { data: Record<string, unknown>; delay: number } | undefined;
	const systemQueue = {
		toKey: (s: string) => `test:system:${s}`,
		getJob: async (id: string) => jobs.get(id),
		add: async (name: string, data: Record<string, unknown>, options: { jobId: string; delay?: number }) => { added.push(options.jobId); addedJobs.push({ name, data, options }); jobs.set(options.jobId, { name, data, getState: async () => 'waiting', remove: async () => { jobs.delete(options.jobId); } }); if (options.delay !== undefined && data.sweep === undefined) continuation = { data, delay: options.delay }; },
	};
	const waiting = { deliver: [] as { timestamp: number }[], inbox: [] as { timestamp: number }[] };
	const queueService = {
		systemQueue,
		deliverQueue: { getWaiting: async () => waiting.deliver.slice(0, 1) },
		inboxQueue: { getWaiting: async () => waiting.inbox.slice(0, 1) },
	};
	// 통지 저장 모형: createNotification이 스트림에 항목을 쌓고 저장 확인 조회가 이를 읽는다.
	const notifications: Record<string, unknown>[] = [];
	const notificationRedis = { xrevrange: async () => notifications.map((payload, i) => [`${i + 1}-0`, ['data', JSON.stringify(payload)]]).reverse() };
	const cache = { userProfileCache: { fetch: async () => ({}) } };
	const service = new NoteCleanupService(db as any, { gen: () => String(Math.random()), parse: () => ({ date: new Date(0) }) } as any, queueService as any, noteDelete as any, { createNotification: (userId: string, type: string, data: Record<string, unknown>) => { notifications.push({ ...data, type, userId, createdAt: new Date().toISOString() }); } } as any, redis as any, { enableReactionsBuffering: false } as any, buffering, notificationRedis as any, cache as any);
	const processor = new AutoDeleteNotesProcessorService(service, queueService as any);
	const addUser = (userId: string, lastRunAt = EPOCH) => {
		rows.MiUser.push({ id: userId, host: null, autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });
		rows.State.push({ userId, migrated: false, cursor: null, lastRunAt, previewAt: null, previewToken: null });
	};
	const addNotes = (userId: string, count: number) => { for (let i = 0; i < count; i++) rows.MiNote.push(note(userId, i)); };
	const notesOf = (userId: string) => rows.MiNote.filter(n => n.userId === userId);
	const state = (userId: string) => rows.State.find(s => s.userId === userId);
	// 이어 받기 작업을 같은 시험 핸들로 넘겨 반복 회차를 관찰한다.
	const job = (data: Record<string, unknown>) => {
		const delays: number[] = [];
		const self = { data: { ...data }, delays, updateData: async (next: Record<string, unknown>) => { self.data = next; }, take: () => continuation };
		return self;
	};
	return { faults, onRead: (callback: () => void) => { afterRead = callback; }, rows, busy, scanned, failingNotes, retryableDeletes, deleteAttempts, redis, jobs, added, addedJobs, waiting, service, processor, addUser, addNotes, notesOf, state, job };
}

// 작업 한 번 실행: 완료면 'done', 이어 받기를 접수하면 'delayed'
async function run(processor: AutoDeleteNotesProcessorService, job: { data: Record<string, unknown>; delays: number[]; take: () => { data: Record<string, unknown>; delay: number } | undefined }) {
	const result = await processor.process(job as any) as { delayed?: boolean };
	if (!result.delayed) return 'done';
	const next = job.take()!;
	job.data = next.data;
	job.delays.push(Date.now() + next.delay);
	return 'delayed';
}

test('연합 큐가 밀리면 수동 정리 요청도 지우지 않고 요청과 커서를 그대로 둔 채 지연하며 해소 후 그 커서부터 잇는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 4);
	f.waiting.deliver.push({ timestamp: NOW - 60_000 });
	const data = { userId: 'alice', ruleIds: ['d1'], afterId: noteId('alice', 1), requestId: 'request' };
	const manual = f.job(data);
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(f.notesOf('alice')).toHaveLength(4);
	expect(f.scanned.get('alice') ?? 0).toBe(0);
	expect(manual.data).toMatchObject(data);
	expect(manual.delays[0]).toBeGreaterThan(NOW);
	// 자동 회차도 지연 중에는 커서와 순번을 바꾸지 않는다.
	f.rows.Rule.push(deleteRule('alice', 'auto'));
	f.state('alice').cursor = noteId('alice', 0);
	expect(await f.processor.process({ data: {} } as any)).toMatchObject({ skipped: true });
	expect(f.state('alice')).toMatchObject({ cursor: noteId('alice', 0), lastRunAt: EPOCH });
	f.waiting.deliver.length = 0;
	f.rows.Rule.pop();
	expect(await run(f.processor, manual)).toBe('done');
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 0), noteId('alice', 1)]);
});

test('계정별 검사·삭제 한도는 규칙 조합을 나눈 여러 요청에도 공유되고 다른 계정의 몫을 남긴다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.addUser('bob');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false), deleteRule('alice', 'd2', 120, false), deleteRule('bob', 'b1', 60, false));
	f.addNotes('alice', 300);
	f.addNotes('bob', 10);
	const requests = [['d1'], ['d2'], ['d1', 'd2']].map(ruleIds => f.job({ userId: 'alice', ruleIds, requestId: ruleIds.join() }));
	const pending = new Set(requests);
	for (let i = 0; i < 200 && pending.size; i++) {
		for (const request of [...pending]) {
			const before = request.delays.length;
			const outcome = await run(f.processor, request);
			// 다음 5분 창 이후로 미룬 요청은 이 창에서 다시 돌리지 않는다.
			if (outcome === 'done' || (request.delays.length > before && request.delays.at(-1)! >= NOW - (NOW % 300_000) + 300_000)) pending.delete(request);
		}
	}
	const aliceDeleted = 300 - f.notesOf('alice').length;
	expect(aliceDeleted).toBeGreaterThan(0);
	expect(aliceDeleted).toBeLessThanOrEqual(60);
	expect(pending.size).toBe(0);
	expect(await run(f.processor, f.job({ userId: 'bob', ruleIds: ['b1'], requestId: 'bob' }))).toBe('done');
	expect(f.notesOf('bob')).toHaveLength(0);
});

test('보호만 하는 노트를 오래 검사하는 계정도 계정별 검사 한도에서 멈추고 다음 창으로 미룬다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false), keepAll('alice', 'k1'));
	f.addNotes('alice', 2000);
	const request = f.job({ userId: 'alice', ruleIds: ['d1'], requestId: 'scan' });
	let outcome = 'delayed';
	for (let i = 0; i < 100 && outcome === 'delayed' && !(request.delays.at(-1)! >= NOW - (NOW % 300_000) + 300_000); i++) outcome = await run(f.processor, request);
	expect(outcome).toBe('delayed');
	expect(f.scanned.get('alice')).toBeLessThanOrEqual(1200);
	expect(request.delays.at(-1)).toBeGreaterThanOrEqual(NOW - (NOW % 300_000) + 300_000);
	expect(typeof request.data.afterId).toBe('string');
	expect(f.notesOf('alice')).toHaveLength(2000);
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
	// 수동 요청의 잠금 충돌은 실패가 아니라 요청을 보존한 재시도다.
	const manual = f.job({ userId: 'busy', ruleIds: ['busy-d'], requestId: 'retry' });
	expect(await run(f.processor, manual)).toBe('delayed');
	expect(manual.data).toMatchObject({ userId: 'busy', ruleIds: ['busy-d'], requestId: 'retry' });
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

test('수동 요청에서 실패한 노트는 뒤 노트의 삭제를 막지 않고 실패 수를 따로 센다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 12);
	f.failingNotes.add(noteId('alice', 0));
	const request = f.job({ userId: 'alice', ruleIds: ['d1'], requestId: 'fail' });
	let outcome = 'delayed';
	for (let i = 0; i < 20 && outcome === 'delayed'; i++) outcome = await run(f.processor, request);
	expect(outcome).toBe('done');
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 0)]);
	expect(f.deleteAttempts.get(noteId('alice', 0))).toBe(1);
});

test('설정 수정은 대기 중인 정리 요청을 취소·교체하거나 새로 등록하지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 1);
	await f.service.request('alice', ['d1']);
	const snapshot = new Map(f.jobs);
	await f.service.save('alice', { name: '수정', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 3600 } }, 'd1');
	await f.service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	expect(f.jobs).toEqual(snapshot);
	expect(f.added).toHaveLength(1);
});

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

test('수동 요청은 한 작업에서 회차 시간 상한까지만 이어 처리하고 진행한 커서를 남겨 곧 다시 잇는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 30);
	const original = f.service.processUser.bind(f.service);
	f.service.processUser = async (...args: Parameters<typeof original>) => {
		const result = await original(...args);
		vi.setSystemTime(Date.now() + NOTE_CLEANUP_LIMITS.roundMs / 2);
		return result;
	};
	const request = f.job({ userId: 'alice', ruleIds: ['d1'], requestId: 'long' });
	const started = Date.now();
	expect(await run(f.processor, request)).toBe('delayed');
	// 두 페이지(삭제 시도 5개씩)를 처리한 뒤 시간 상한에 걸린다. 예산 소진이 아니므로 다음 창까지 기다리지 않는다.
	expect(f.notesOf('alice')).toHaveLength(20);
	expect(request.data).toMatchObject({ userId: 'alice', ruleIds: ['d1'], afterId: noteId('alice', 9), requestId: 'long' });
	expect(request.delays[0] - (started + NOTE_CLEANUP_LIMITS.roundMs)).toBeLessThan(NOTE_CLEANUP_LIMITS.windowMs / 2);
	expect(await run(f.processor, request)).toBe('delayed');
	expect(f.notesOf('alice')).toHaveLength(10);
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

// 이전 페이지의 실패 노트 2건이 자료 오류 범위로 남아 있어, 본 페이지 전에 그 범위(2건)를 먼저 다시 읽는 계정
function recoveryFixture() {
	const f = fixture();
	f.addUser('alice');
	const failure = { ruleId: 'keep', code: 'TEMPORARY_FAILURE', path: 'condition', message: 'TEMPORARY_FAILURE', userActionable: false, recovery: { source: 'data', noteIds: [noteId('alice', 1), noteId('alice', 2)] } };
	f.rows.Rule.push(deleteRule('alice', 'delete'), { ...keepAll('alice', 'keep'), lastError: failure });
	f.addNotes('alice', 3);
	return f;
}

// 다른 계정·요청이 이미 쓴 양을 채워 두어 한도 근처에서 일부만 예약되게 한다.
const nearLimits = [
	['global', 'user:alice', NOTE_CLEANUP_LIMITS.globalScan - 10],
	['user:alice', 'global', NOTE_CLEANUP_LIMITS.userScan - 50],
] as const;

test.each([
	['pageRules', 'page rules failed'],
	['lastRun', 'lastRun write failed'],
] as const)('검사 전 %s 실패는 예약량 전부를 반환한다', async (fault, message) => {
	const f = scanFixture();
	f.faults[fault] = true;

	await expect(f.service.processUser('alice')).rejects.toThrow(message);

	expect(f.scanned.get('alice')).toBeUndefined();
	expect(scanUsed(f, 'global')).toBe(0);
	expect(scanUsed(f, 'user:alice')).toBe(0);
	expect(f.notesOf('alice')).toHaveLength(3);
});

test('노트를 불러온 뒤 자료 판정이 실패해도 읽은 수만큼 검사량을 보존한다', async () => {
	const f = scanFixture();
	f.faults.contexts = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('context failed');

	expect(f.scanned.get('alice')).toBe(3);
	expect(scanUsed(f, 'global')).toBe(3);
	expect(scanUsed(f, 'user:alice')).toBe(3);
	expect(f.notesOf('alice')).toHaveLength(3);
});

test('대상 조회가 실패해 소비를 확정하지 못하면 예약 상한을 보존한다', async () => {
	const f = scanFixture();
	f.faults.noteLookup = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('note lookup failed');

	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
});

test.each([0, 3, NOTE_CLEANUP_LIMITS.pageSize])('정상 %i건 페이지는 실제 노트 수만 소비한다', async count => {
	const f = scanFixture(count);

	await f.service.processUser('alice');

	expect(scanUsed(f, 'global')).toBe(count);
	expect(scanUsed(f, 'user:alice')).toBe(count);
});

test('실패 중 창이 바뀌어도 미사용량은 원래 창에만 반환한다', async () => {
	const f = scanFixture();
	f.faults.contexts = true;
	f.onRead(() => { vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs); });

	await expect(f.service.processUser('alice')).rejects.toThrow('context failed');

	expect(scanUsed(f, 'global')).toBe(3);
	expect(f.redis.store.has(scanKey('global', NOW + NOTE_CLEANUP_LIMITS.windowMs))).toBe(false);
});

test.each([false, true])('반환 Redis 실패는 원래 처리 결과를 바꾸지 않는다: 오류 %s', async fail => {
	const f = scanFixture();
	f.faults.release = true;
	f.faults.contexts = fail;

	if (fail) await expect(f.service.processUser('alice')).rejects.toThrow('context failed');
	else expect((await f.service.processUser('alice')).deleted).toBe(0);

	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
});

test('반복된 검사 전 실패는 같은 계정과 뒤 계정의 검사 자격을 소진하지 않는다', async () => {
	const f = scanFixture();
	f.addUser('bob');
	f.rows.Rule.push(deleteRule('bob', 'bob-delete'));
	f.addNotes('bob', 1);
	f.faults.pageRules = true;
	const attempts = NOTE_CLEANUP_LIMITS.userScan / NOTE_CLEANUP_LIMITS.pageSize + 1;

	for (let i = 0; i < attempts; i++) await expect(f.service.processUser('alice')).rejects.toThrow('page rules failed');
	f.faults.pageRules = false;
	await f.service.processUser('alice');
	const bob = await f.service.processUser('bob');

	expect(bob.deleted).toBe(1);
	expect(scanUsed(f, 'global')).toBe(4);
	expect(scanUsed(f, 'user:alice')).toBe(3);
	expect(scanUsed(f, 'user:bob')).toBe(1);
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
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.userScan + 1);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.userScan);
});

test.each(nearLimits)('%s 한도 근처에서 일부만 예약하면 검사 전 실패는 받은 양만 반환한다', async (limited, other, used) => {
	const f = scanFixture();
	f.redis.store.set(scanKey(limited), used);
	f.faults.pageRules = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('page rules failed');

	expect(scanUsed(f, limited)).toBe(used);
	expect(scanUsed(f, other)).toBe(0);
});

test.each(nearLimits)('%s 한도 근처에서 일부만 예약하면 읽은 뒤 실패는 읽은 수만 남긴다', async (limited, other, used) => {
	const f = scanFixture();
	f.redis.store.set(scanKey(limited), used);
	f.faults.contexts = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('context failed');

	expect(scanUsed(f, limited)).toBe(used + 3);
	expect(scanUsed(f, other)).toBe(3);
});

test('선행 오류 회복 조회로 읽은 노트도 같은 예약의 검사량으로 센다', async () => {
	const f = recoveryFixture();

	await f.service.processUser('alice');

	// 회복 범위 2건과 본 페이지 3건
	expect(f.scanned.get('alice')).toBe(5);
	expect(scanUsed(f, 'global')).toBe(5);
	expect(scanUsed(f, 'user:alice')).toBe(5);
	expect(f.rows.Rule.find(r => r.id === 'keep').lastError).toBeNull();
});

test('선행 오류 회복 조회 뒤 판정이 실패하면 회복 조회로 읽은 수만 남긴다', async () => {
	const f = recoveryFixture();
	f.faults.contexts = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('context failed');

	expect(f.scanned.get('alice')).toBe(2);
	expect(scanUsed(f, 'global')).toBe(2);
	expect(scanUsed(f, 'user:alice')).toBe(2);
});

test('선행 오류 회복 조회가 실패하면 소비를 확정하지 못해 예약 상한을 보존한다', async () => {
	const f = recoveryFixture();
	f.faults.noteLookup = true;

	await expect(f.service.processUser('alice')).rejects.toThrow('note lookup failed');

	expect(f.scanned.get('alice')).toBeUndefined();
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
});

test('회복 조회를 마친 뒤 본 페이지 조회가 실패해도 예약 상한을 보존한다', async () => {
	const f = recoveryFixture();
	f.onRead(() => { f.faults.noteLookup = true; });

	await expect(f.service.processUser('alice')).rejects.toThrow('note lookup failed');

	expect(f.scanned.get('alice')).toBe(2);
	expect(scanUsed(f, 'global')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.pageSize);
});

// === 최종 검토 지적 재현 (review-fix) ===

test('Sol3: 회복 조회는 예약된 검사 예산 안에서만 읽고 본 페이지 한도에서 회복 사용량을 뺀다', async () => {
	const f = recoveryFixture();
	// 계정 검사 예산을 1개만 남게 채워 둔다. 회복 범위 2건 중 1건만 확인할 수 있다.
	f.redis.store.set(scanKey('user:alice'), NOTE_CLEANUP_LIMITS.userScan - 1);

	await f.service.processUser('alice');

	// 회복 1건만 읽고 본 페이지는 읽지 않는다. 예약 1개를 초과하지 않는다.
	expect(f.scanned.get('alice')).toBe(1);
	expect(scanUsed(f, 'global')).toBe(1);
	expect(scanUsed(f, 'user:alice')).toBe(NOTE_CLEANUP_LIMITS.userScan);
	// 일부만 확인했으므로 오류를 해제하지 않고 미확인 범위를 보존한다.
	const keep = f.rows.Rule.find(r => r.id === 'keep');
	expect(keep.lastError).not.toBeNull();
	expect(keep.lastError.recovery.noteIds).toEqual([noteId('alice', 2)]);
	expect(f.notesOf('alice')).toHaveLength(3);
});

test('Sol3: 예산이 모자라 일부만 확인한 회복 범위는 다음 회차에 이어서 확인하고 해제한다', async () => {
	const f = recoveryFixture();
	f.redis.store.set(scanKey('user:alice'), NOTE_CLEANUP_LIMITS.userScan - 1);
	await f.service.processUser('alice');
	expect(f.rows.Rule.find(r => r.id === 'keep').lastError).not.toBeNull();

	// 다음 창에서 남은 미확인 범위 1건을 확인하면 해제한다.
	vi.setSystemTime(NOW + NOTE_CLEANUP_LIMITS.windowMs);
	await f.service.processUser('alice');
	expect(f.rows.Rule.find(r => r.id === 'keep').lastError).toBeNull();
});

test('Sol3: 여러 규칙의 같은 회복 범위는 한 번만 읽어 예산을 중복 쓰지 않는다', async () => {
	const f = fixture();
	f.addUser('alice');
	const failure = (ruleId: string) => ({ ruleId, code: 'TEMPORARY_FAILURE', path: 'condition', message: 'TEMPORARY_FAILURE', userActionable: false, recovery: { source: 'data', noteIds: [noteId('alice', 1), noteId('alice', 2)] } });
	f.rows.Rule.push(deleteRule('alice', 'delete'), { ...keepAll('alice', 'keep1'), lastError: failure('keep1') }, { ...keepAll('alice', 'keep2'), lastError: failure('keep2') });
	f.addNotes('alice', 3);

	await f.service.processUser('alice');

	// 같은 범위 2건을 두 규칙이 공유하므로 회복 2건 + 본 페이지 3건 = 5건만 읽는다.
	expect(f.scanned.get('alice')).toBe(5);
	expect(scanUsed(f, 'global')).toBe(5);
	expect(f.rows.Rule.filter(r => r.action === 'keep').every(r => r.lastError === null)).toBe(true);
});

test('OC4: 수동 요청의 재시도 가능한 삭제 실패도 시도한 만큼만 삭제 예산을 쓰고 나머지는 반납한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 3);
	f.retryableDeletes.add(noteId('alice', 1));

	await expect(f.service.processUser('alice', ['d1'])).rejects.toThrow('Connection terminated unexpectedly');

	// 노트 0 삭제 성공 + 노트 1 삭제 시도 실패 = 2개만 쓰고 예약 3개 중 1개는 반납한다.
	expect(deleteUsed(f, 'global')).toBe(2);
	expect(deleteUsed(f, 'user:alice')).toBe(2);
	expect(f.notesOf('alice').map(n => n.id)).toEqual([noteId('alice', 1), noteId('alice', 2)]);
});

test('OC1: 수동 요청의 비재시도 오류는 종료 실패로 처리해 무한 재시도를 막는다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 1);
	// 큐 등록 뒤 계정이 물리 삭제된 상태
	f.rows.MiUser.splice(0);
	const manual = f.job({ userId: 'alice', ruleIds: ['d1'], requestId: 'gone' });

	await expect(f.processor.process(manual as any)).rejects.toBeInstanceOf(UnrecoverableError);
});

test('OC1: 실패한 요청 작업은 새 요청으로 교체할 수 있다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	const first = await f.service.request('alice', ['d1']);
	const root = f.jobs.get(first.jobId) as any;
	root.getState = async () => 'failed';

	const second = await f.service.request('alice', ['d1']);

	expect(second.queued).toBe(true);
	expect(second.jobId).toBe(first.jobId);
});

test('Sol6: 요청 작업은 유한 재시도와 보존 기한을 두고 이어 받기 자식은 완료 뒤 자동 제거한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 2);
	await f.service.request('alice', ['d1']);
	const rootOptions = f.addedJobs[0].options as any;
	expect(rootOptions.removeOnComplete).toBe(false);
	expect(rootOptions.attempts).toBeLessThan(1000);
	expect(rootOptions.removeOnFail).toMatchObject({ age: expect.any(Number) });
	f.waiting.deliver.push({ timestamp: NOW - 60_000 });
	const manual = f.job({ userId: 'alice', ruleIds: ['d1'], requestId: 'req' });

	expect(await run(f.processor, manual)).toBe('delayed');

	const childOptions = f.addedJobs.at(-1)!.options as any;
	expect(childOptions.removeOnComplete).not.toBe(false);
	expect(childOptions.attempts).toBeLessThan(1000);
	expect(childOptions.removeOnFail).toMatchObject({ age: expect.any(Number) });
});

test('OC2: 완료된 이어 받기 체인은 새 요청이 루트와 자손을 함께 정리한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	const first = await f.service.request('alice', ['d1']);
	const root = f.jobs.get(first.jobId) as any;
	root.data.handoff = { next: { requestId: 'req', step: 1 } };
	root.getState = async () => 'completed';
	const childId = 'note-cleanup-req-1';
	f.jobs.set(childId, { data: { requestId: 'req', step: 1 }, getState: async () => 'completed', remove: async () => { f.jobs.delete(childId); } });

	const second = await f.service.request('alice', ['d1']);

	expect(second.queued).toBe(true);
	expect(f.jobs.has(childId)).toBe(false);
});

test('OC2: 이어 받기 자식이 유실·만료돼도 같은 요청을 다시 접수할 수 있다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	const first = await f.service.request('alice', ['d1']);
	const root = f.jobs.get(first.jobId) as any;
	root.data.handoff = { next: { requestId: 'req', step: 1 } };
	root.getState = async () => 'completed';
	// 자식 작업이 보존 기한 만료 등으로 사라진 상태

	const second = await f.service.request('alice', ['d1']);

	expect(second.queued).toBe(true);
	expect(f.jobs.has(first.jobId)).toBe(true);
});

test('OC2: 실패한 이어 받기 자식은 루트와 함께 정리되고 새 요청을 접수한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	const first = await f.service.request('alice', ['d1']);
	const root = f.jobs.get(first.jobId) as any;
	root.data.handoff = { next: { requestId: 'req', step: 1 } };
	root.getState = async () => 'completed';
	const childId = 'note-cleanup-req-1';
	f.jobs.set(childId, { data: { requestId: 'req', step: 1 }, getState: async () => 'failed', remove: async () => { f.jobs.delete(childId); } });

	const second = await f.service.request('alice', ['d1']);

	expect(second.queued).toBe(true);
	expect(f.jobs.has(childId)).toBe(false);
});

test('Sol6: 최종 완료는 체인 정리를 접수하고 정리 작업은 종료된 루트를 제거한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	f.addNotes('alice', 1);
	const first = await f.service.request('alice', ['d1']);
	const root = f.jobs.get(first.jobId) as any;
	root.getState = async () => 'completed';
	const manual = f.job({ userId: 'alice', ruleIds: ['d1'], requestId: 'req' });

	expect(await run(f.processor, manual)).toBe('done');

	const sweep = f.addedJobs.at(-1)!;
	expect(sweep.data).toMatchObject({ userId: 'alice', sweep: first.jobId });
	expect((sweep.options as any).delay).toBeGreaterThan(0);
	expect((sweep.options as any).removeOnComplete).toBe(true);

	await f.processor.process({ data: sweep.data } as any);

	expect(f.jobs.has(first.jobId)).toBe(false);
});

test('Sol6: 체인 정리는 진행 중인 체인을 건드리지 않고 종료된 루트와 자손만 제거한다', async () => {
	const f = fixture();
	f.addUser('alice');
	f.rows.Rule.push(deleteRule('alice', 'd1', 60, false));
	const first = await f.service.request('alice', ['d1']);
	const root = f.jobs.get(first.jobId) as any;
	root.data.handoff = { next: { requestId: 'req', step: 1 } };
	root.getState = async () => 'completed';
	let childState = 'delayed';
	const childId = 'note-cleanup-req-1';
	f.jobs.set(childId, { data: { requestId: 'req', step: 1 }, getState: async () => childState, remove: async () => { f.jobs.delete(childId); } });

	await f.service.sweepRequestChain('alice', first.jobId);
	expect(f.jobs.has(childId)).toBe(true);
	expect(f.jobs.has(first.jobId)).toBe(true);

	childState = 'completed';
	await f.service.sweepRequestChain('alice', first.jobId);
	expect(f.jobs.has(childId)).toBe(false);
	expect(f.jobs.has(first.jobId)).toBe(false);
});
