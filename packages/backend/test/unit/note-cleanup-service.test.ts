/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { FindOperator } from 'typeorm';
vi.mock('../../src/models/_.js', () => Object.fromEntries(['MiNote', 'MiUser', 'MiClip', 'MiClipNote', 'MiChannel', 'MiPoll', 'MiDriveFile', 'MiNoteFavorite', 'MiNoteReaction', 'MiUserNotePining'].map(name => [name, { name }])));
vi.mock('../../src/models/NoteCleanupRule.js', () => ({ MiNoteCleanupRule: { name: 'Rule' }, MiNoteCleanupState: { name: 'State' } }));
vi.mock('../../src/logger.js', () => ({ default: class { error() {} } }));
vi.mock('../../src/core/QueueService.js', () => ({ QueueService: class {} }));
vi.mock('../../src/core/NoteDeleteService.js', () => ({ NoteDeleteService: class {} }));
vi.mock('../../src/core/NotificationService.js', () => ({ NotificationService: class {} }));
vi.mock('../../src/core/IdService.js', () => ({ IdService: class {} }));
import { ReactionsBufferingService } from '../../src/core/ReactionsBufferingService.js';
import { cleanupDependencies } from '../../src/core/NoteCleanupCondition.js';
import { CleanupInputError, NoteCleanupService } from '../../src/core/NoteCleanupService.js';
import UpdateAutoDeleteSettings from '../../src/server/api/endpoints/i/update-auto-delete-settings.js';
import PreviewEndpoint, { meta as previewMeta } from '../../src/server/api/endpoints/i/note-cleanup/preview.js';

// detached: 실제 DB처럼 조회 결과를 저장 행과 분리한 복사본으로 돌려준다.
function fixture({ detached = false, noteCreatedAt = (_id: string) => new Date(0) } = {}) {
	const rows: Record<string, any[]> = { Rule: [], State: [{ userId: 'alice', cursor: null, migrated: true, manualRequest: null }], MiUser: [{ id: 'alice', host: null }], MiNote: [] };
	const failing = new Set<string>();
	// retryable: 재시도 가능한 연결 오류로 조회를 실패시킨다.
	const retryable = new Set<string>();
	const faults = { createQueryRunner: false };
	const noteReads: string[][] = [];
	// failingWrites: 해당 엔티티의 쓰기 실패를 주입한다.
	const failingWrites = new Set<string>();
	const write = (name: string, input: any) => {
		if (failingWrites.has(name)) throw new Error(`${name} write unavailable`);
		// PostgreSQL integer 열처럼 정수가 아닌 구 기간 값을 거부한다.
		if (name === 'MiUser' && input.autoDeleteNotesAfterDays != null && !Number.isInteger(input.autoDeleteNotesAfterDays)) throw new Error('invalid input syntax for type integer');
	};
	// typeorm 조회 연산자 중 이 경로가 쓰는 In·IsNull만 해석하고, 나머지 객체 조건은 값 비교로 본다.
	const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => {
		if (v instanceof FindOperator) {
			if (v.type === 'in') return (v.value as unknown[]).includes(row[k]);
			if (v.type === 'isNull') return row[k] == null;
			throw new Error(`unsupported operator ${v.type}`);
		}
		return typeof v === 'object' && v !== null ? JSON.stringify(row[k]) === JSON.stringify(v) : row[k] === v;
	});
	const copy = (list: any[]) => detached ? list.map(row => structuredClone(row)) : list;
	const repository = (entity: { name: string }) => {
		const data = rows[entity.name] ??= [];
		const lookup = (where: any) => {
			if (failing.has(entity.name)) throw new Error(`${entity.name} lookup unavailable`);
			if (retryable.has(entity.name)) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
			return copy(data.filter(row => matches(row, where)));
		};
		return {
			find: async ({ where }: any) => lookup(where),
			findBy: async (where: any) => lookup(where),
			existsBy: async (where: any) => data.some(row => matches(row, where)),
			findOneBy: async (where: any) => { lookup(where); return data.find(row => matches(row, where)) ?? null; },
			findOneByOrFail: async (where: any) => { lookup(where); const row = data.find(row => matches(row, where)); if (!row) throw new Error('not found'); return row; },
			countBy: async (where: any) => data.filter(row => matches(row, where)).length,
			save: async (input: any) => { write(entity.name, input); const i = data.findIndex(row => row.id === input.id); if (i >= 0) data[i] = input; else data.push(input); return input; },
			update: async (id: any, input: any) => { write(entity.name, input); let affected = 0; for (const row of data) if (typeof id === 'object' ? matches(row, id) : row.id === id || row.userId === id) { Object.assign(row, input); affected++; } return { affected }; },
			delete: async (where: any) => { write(entity.name, {}); for (let i = data.length - 1; i >= 0; i--) if (matches(data[i], where)) data.splice(i, 1); },
			createQueryBuilder: () => {
				let afterId: string | undefined;
				let ids: string[] | undefined;
				let limit = Infinity;
				const filter = (_sql: string, params?: { afterId?: string; ids?: string[] }) => { afterId = params?.afterId ?? afterId; ids = params?.ids ?? ids; return builder; };
				const builder: any = { where: filter, andWhere: filter, innerJoin: () => builder, orderBy: () => builder, take: (value: number) => { limit = value; return builder; }, select: () => builder, getRawMany: async () => [], getMany: async () => { if (retryable.has(entity.name)) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }); const result = copy(data.filter(row => (!afterId || row.id > afterId) && (!ids || ids.includes(row.id))).slice(0, limit)); if (entity.name === 'MiNote') noteReads.push(result.map(row => row.id)); return result; } };
				return builder;
			},
		};
	};
	const lock = { available: true, released: 0 };
	const manager = { getRepository: repository, update: async (entity: { name: string }, id: string, input: any) => repository(entity).update(id, input), findOneByOrFail: async (entity: { name: string }, where: any) => repository(entity).findOneByOrFail(where),
		insert: async (entity: { name: string }, input: any) => { write(entity.name, input); (rows[entity.name] ??= []).push({ ...input }); } };
	// 트랜잭션은 실패하면 저장 행 전체를 이전 상태로 되돌리는 것으로만 흉내 낸다. 격리·잠금·실제 SQL 오류는 재현하지 않는다.
	const transaction = async (work: (manager: unknown) => Promise<unknown>) => {
		const snapshot = structuredClone(rows);
		try { return await work(manager); } catch (error) {
			for (const key of Object.keys(rows)) rows[key].splice(0, rows[key].length, ...(snapshot[key] ?? []));
			throw error;
		}
	};
	const db = { getRepository: repository, transaction, createQueryRunner: () => { if (faults.createQueryRunner) throw new Error('runner unavailable'); return { connect: async () => {}, query: async () => [{ locked: lock.available }], release: async () => { lock.released++; } }; } };
	let nextId = 0;
	const notifications: unknown[] = [];
	const jobs = new Map<string, unknown>();
	const evalCalls: unknown[][] = [];
	const meta = { enableReactionsBuffering: false };
	const buffered = new Map<string, { deltas: Record<string, number>; pairs: [string, string][] }>();
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	Object.defineProperty(buffering, 'getMany', { value: async () => buffered, writable: true });
	const service = new NoteCleanupService(db as any, { gen: () => String(++nextId), parse: (id: string) => ({ date: noteCreatedAt(id) }) } as any, { systemQueue: { toKey: (s: string) => s, getJob: async (id: string) => jobs.get(id), add: async (name: string, data: unknown, options: { jobId: string }) => { jobs.set(options.jobId, { name, data, getState: async () => 'waiting', remove: async () => { jobs.delete(options.jobId); } }); } } } as any, { delete: async (_user: unknown, note: { id: string }) => { rows.MiNote.splice(rows.MiNote.findIndex(n => n.id === note.id), 1); } } as any, { createNotification: (userId: string, type: string, data: Record<string, unknown>) => { notifications.push([userId, type, data]); } } as any, { eval: async (...args: unknown[]) => { evalCalls.push(args); return 5; } } as any, meta as any, buffering);
	const condition = { type: 'age', operator: 'gte', seconds: 60 };
	return { rows, service, notifications, jobs, evalCalls, failing, failingWrites, retryable, faults, lock, meta, buffered, buffering, noteReads, input: { name: '정리', action: 'delete' as const, condition } };
}

const note = (id: string) => ({ id, userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });

// === 규칙 저장과 권한 ===

test('다른 사용자의 규칙 수정과 삭제는 거부한다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'foreign', userId: 'bob', ...input });
	await expect(service.save('alice', input, 'foreign')).rejects.toThrow('NO_SUCH_RULE');
	await expect(service.remove('alice', 'foreign')).rejects.toThrow('NO_SUCH_RULE');
	expect(rows.Rule).toHaveLength(1);
});

test('저장으로 자동 실행을 시작하지 않고 활성 변경은 명시 확인이 필요하다', async () => {
	const { service, input } = fixture();
	await expect(service.save('alice', { ...input, automatic: true })).rejects.toThrow('PREVIEW_REQUIRED');
	const { rule } = await service.save('alice', input);
	expect(rule.automatic).toBe(false);
	await expect(service.save('alice', { ...input, enabled: false }, rule.id)).rejects.toThrow('CONFIRMATION_REQUIRED');
	const updated = await service.save('alice', { ...input, enabled: false, confirmed: true }, rule.id);
	expect(updated.rule.enabled).toBe(false);
});

test('최초 자동 실행은 명시 확인으로만 켜고 한 번 확인하면 다시 켤 때 반복 확인하지 않는다', async () => {
	const { service, input } = fixture();
	const { rule } = await service.save('alice', input);
	await expect(service.save('alice', { ...input, automatic: true }, rule.id)).rejects.toThrow('PREVIEW_REQUIRED');
	const confirmed = await service.save('alice', { ...input, automatic: true, confirmed: true }, rule.id);
	expect(confirmed.rule.automaticConfirmed).toBe(true);
	await service.save('alice', { ...input, automatic: false }, rule.id);
	const again = await service.save('alice', { ...input, automatic: true }, rule.id);
	expect(again.rule.automatic).toBe(true);
	expect(again.rule.automaticConfirmed).toBe(true);
});

test('비활성 지우기와 다른 사용자의 규칙은 미리 보기 및 요청에 사용할 수 없다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'foreign', userId: 'bob', ...input, enabled: true });
	await expect(service.preview('alice', ['foreign'])).rejects.toThrow('INVALID_RULE_SELECTION');
	await expect(service.request('alice', ['foreign'])).rejects.toThrow('INVALID_RULE_SELECTION');
});

test('요청은 소유권과 활성 선택만 확인하므로 참조 오류가 있어도 접수한다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null });
	expect((await service.request('alice', ['delete'])).queued).toBe(true);
	expect(rows.State[0].manualRequest).toEqual({ ruleIds: ['delete'], cursor: null });
});

test('타인 소유의 클립을 보존이나 지우기 조건으로 저장하지 않는다', async () => {
	const { service, input, rows } = fixture();
	rows.MiClip = [{ id: 'foreign', userId: 'bob' }];
	for (const action of ['keep', 'delete'] as const) await expect(service.save('alice', { ...input, action, condition: { type: 'clip', ids: ['foreign'] } })).rejects.toThrow('INVALID_CLIP');
});

test('반전 조건은 더 이상 지원하지 않아 저장을 거부한다', async () => {
	const { service, input } = fixture();
	await expect(service.save('alice', { ...input, condition: { type: 'not', child: { type: 'flag', field: 'pinned', value: true } } })).rejects.toThrow('INVALID_CONDITION');
});

// === 보호 실패 알림 ===

test('사라진 남기기 참조는 경로와 ID를 표시하고 미해결 알림을 중복하지 않는다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'all', children: [{ type: 'clip', ids: ['gone'] }] }, lastError: null, legacy: null });
	const first = await service.list('alice');
	expect(first.blocked).toBe(true);
	expect(first.rules[0].lastError).toMatchObject({ code: 'MISSING_CLIP', path: 'condition.children.0', referenceId: 'gone', referenceType: 'clip' });
	await service.list('alice');
	expect(notifications).toHaveLength(1);
});

test('같은 오류는 한 번만 알리고 오류가 바뀌거나 해결된 뒤 다시 생기면 새로 알린다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	await service.list('alice');
	await service.list('alice');
	expect(notifications).toHaveLength(1);
	expect(rows.Rule[0].protectionNotified).toBe(true);
	rows.Rule[0].condition = { type: 'clip', ids: ['other'] };
	await service.list('alice');
	expect(notifications).toHaveLength(2);
	rows.MiClip = [{ id: 'other', userId: 'alice' }];
	expect((await service.list('alice')).blocked).toBe(false);
	expect(rows.Rule[0].lastError).toBeNull();
	expect(rows.Rule[0].protectionNotified).toBe(false);
	rows.MiClip.splice(0);
	await service.list('alice');
	expect(notifications).toHaveLength(3);
});

test('DB JSON 키 순서가 달라도 미해결 알림 중복 억제를 보존한다', async () => {
	const { rows, service, input, notifications } = fixture();
	const { rule } = await service.save('alice', input);
	rows.Rule[0].condition = { seconds: 60, operator: 'gte', type: 'age' };
	expect((await service.save('alice', { ...input, automatic: true, confirmed: true }, rule.id)).rule.automatic).toBe(true);
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	await service.list('alice');
	const error = rows.Rule[1].lastError;
	rows.Rule[1].lastError = Object.fromEntries(Object.entries(error).sort(([a], [b]) => a.localeCompare(b)));
	await service.list('alice');
	expect(notifications).toHaveLength(1);
});

test('알림 접수 쓰기가 실패하면 발송 없이 유실하고 다음 검사에서 한 번만 접수한다', async () => {
	const { rows, service, notifications, failingWrites } = fixture({ detached: true });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	failingWrites.add('Rule');
	await expect(service.list('alice')).rejects.toThrow('write unavailable');
	expect(rows.Rule[0].lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	failingWrites.clear();
	await service.list('alice');
	expect(notifications).toHaveLength(1);
	await service.list('alice');
	expect(notifications).toHaveLength(1);
});

test('이름·활성 저장은 미해결 보호 오류를 보존하고 참조 재확인이 성공한 뒤에만 해제한다', async () => {
	const { rows, service, input, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	const condition = { type: 'clip', ids: ['gone'] };
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition, lastError: null });
	rows.MiNote.push(note('0'));
	expect((await service.list('alice')).blocked).toBe(true);
	expect(notifications).toHaveLength(1);
	// 조건이 그대로인 끄기는 참조 검증을 건너뛰어 오류를 보존한다.
	const stopped = await service.save('alice', { action: 'keep', condition, enabled: false, confirmed: true }, 'keep');
	expect(stopped.rule.lastError).toMatchObject({ code: 'MISSING_CLIP' });
	rows.MiClip = [{ id: 'gone', userId: 'alice' }];
	await service.save('alice', { action: 'keep', condition, enabled: true, confirmed: true }, 'keep');
	const renamed = await service.save('alice', { name: '새 이름', action: 'keep', condition }, 'keep');
	expect(renamed.rule.lastError).toMatchObject({ code: 'MISSING_CLIP' });
	expect(notifications).toHaveLength(1);
	expect((await service.list('alice')).blocked).toBe(false);
	expect(rows.Rule.find(r => r.id === 'keep').lastError).toBeNull();
	rows.MiClip.splice(0);
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(notifications).toHaveLength(2);
	expect(rows.MiNote).toHaveLength(1);
});

test('조건·행동 변경은 중지 요청이어도 참조 검증을 건너뛰지 않고 과거 오류는 목록 재확인 뒤 해제한다', async () => {
	const { rows, service, input, noteReads } = fixture({ detached: true });
	const old = { ruleId: 'rule', code: 'MISSING_CLIP', path: 'condition.children.0', message: 'MISSING_CLIP', referenceType: 'clip', referenceId: 'gone' };
	rows.Rule.push({ id: 'rule', userId: 'alice', ...input, enabled: true, automatic: false, lastError: old });
	rows.MiNote.push(note('0'), note('1'));
	await expect(service.save('alice', { action: 'delete', condition: { type: 'clip', ids: ['other'] }, automatic: false }, 'rule')).rejects.toThrow('MISSING_CLIP');
	expect(rows.Rule[0].lastError).toEqual(old);
	const saved = await service.save('alice', { action: 'keep', condition: input.condition }, 'rule');
	expect(saved.rule.lastError).toEqual(old);
	noteReads.length = 0;
	expect((await service.list('alice')).blocked).toBe(false);
	// 목록은 참조만 다시 확인하고 노트를 읽지 않는다.
	expect(noteReads).toEqual([]);
	expect(rows.Rule[0].lastError).toBeNull();
});

// === 미리 보기 ===

test('미리 보기는 지워질 노트만 돌려주고 nextCursor로 이어 읽는다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: false, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'hashtag', value: '보존' }, lastError: null });
	for (let i = 0; i < 150; i++) rows.MiNote.push({ ...note(String(i).padStart(3, '0')), tags: i === 5 ? ['보존'] : [] });
	const first = await service.preview('alice', ['delete'], undefined, 100);
	expect(first.notes.map(n => n.id)).toEqual(Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0')).filter(id => id !== '005'));
	expect(first.nextCursor).toBe('099');
	expect(first.complete).toBe(false);
	const second = await service.preview('alice', ['delete'], '099', 100);
	expect(second.notes).toHaveLength(50);
	expect(second.complete).toBe(true);
});

test('미리 보기 응답은 공개 스키마의 최상위 필드만 담는다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: false, lastError: null });
	rows.MiNote.push(note('0'));
	const endpoint = new PreviewEndpoint(service, { packMany: async (notes: unknown[]) => notes } as any);
	const result = await endpoint.exec({ ruleIds: ['delete'] }, { id: 'alice' } as any, null, null);
	expect(Object.keys(result).sort()).toEqual(Object.keys(previewMeta.res.properties).sort());
	expect(result.notes).toHaveLength(1);
	expect(result.complete).toBe(true);
	expect(result.errors).toEqual([]);
});

test('남기기 참조 오류는 미리 보기의 모든 삭제를 막고 오류를 최상위로 전달한다', async () => {
	const { rows, service, input, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: false, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null });
	rows.MiNote.push(note('0'));
	const preview = await service.preview('alice', ['delete']);
	expect(preview.notes).toEqual([]);
	expect(preview.errors).toEqual([expect.objectContaining({ ruleId: 'keep', code: 'MISSING_CLIP' })]);
	expect((await service.list('alice')).blocked).toBe(true);
	expect(notifications).toHaveLength(1);
});

test('참조 오류가 있는 지우기 규칙은 제외하고 다른 지우기는 계속 판정한다', async () => {
	const { rows, service, input, notifications } = fixture();
	rows.Rule.push({ id: 'bad', userId: 'alice', ...input, enabled: true, automatic: true, condition: { type: 'clip', ids: ['gone'] }, lastError: null });
	rows.Rule.push({ id: 'good', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.MiNote.push(note('0'));
	const preview = await service.preview('alice', ['bad', 'good']);
	expect(preview.notes.map(n => n.id)).toEqual(['0']);
	expect(preview.errors).toEqual([expect.objectContaining({ ruleId: 'bad', code: 'MISSING_CLIP' })]);
	expect((await service.list('alice')).blocked).toBe(false);
	expect(notifications).toHaveLength(0);
	expect((await service.processUser('alice')).deleted).toBe(1);
});

test('DB 미반영 리액션 델타를 공용 버퍼 서비스로 합쳐 보호 임계값을 판정한다', async () => {
	const { rows, service, input, meta, buffered } = fixture();
	meta.enableReactionsBuffering = true;
	buffered.set('0', { deltas: { like: 1 }, pairs: [] });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', action: 'keep', enabled: true, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null });
	rows.MiNote.push({ ...note('0'), reactions: { like: 1 } });
	expect((await service.preview('alice', ['delete'])).notes).toEqual([]);
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
});

test.each([
	['gt', ['after']],
	['gte', ['equal', 'after']],
	['lt', ['before']],
	['lte', ['before', 'equal']],
] as const)('작성 ID 시각의 기간 %s는 최근 수정과 관계없이 60초 경계를 판정한다', async (operator, expected) => {
	vi.useFakeTimers();
	try {
		const now = new Date('2026-11-13T00:00:00.000Z');
		vi.setSystemTime(now);
		const created = new Map([
			['before', new Date(now.getTime() - 59999)],
			['equal', new Date(now.getTime() - 60000)],
			['after', new Date(now.getTime() - 60001)],
		]);
		const { rows, service, input } = fixture({ noteCreatedAt: id => created.get(id)! });
		for (const id of created.keys()) rows.MiNote.push({ ...note(id), updatedAt: new Date(now.getTime() - 1) });
		const { rule } = await service.save('alice', { ...input, condition: { type: 'age', operator, seconds: 60 } });

		const result = await service.preview('alice', [rule.id]);

		expect(result.notes.map(n => n.id)).toEqual(expected);
		expect(result.complete).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

// === 일시 장애 ===

test('남기기 자료 조회의 연결 오류는 오류·알림 없이 묶음을 실패시키고 커서를 진행하지 않는다', async () => {
	const { rows, service, input, retryable, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'selfReaction', value: true }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	retryable.add('MiNoteReaction');

	await expect(service.processUser('alice')).rejects.toThrow('Connection terminated');

	expect(rows.MiNote).toHaveLength(1);
	expect(rows.Rule[1].lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	expect(rows.State[0].cursor).toBeNull();
	retryable.clear();
	expect((await service.processUser('alice')).deleted).toBe(1);
});

test('참조 조회의 연결 오류도 오류·알림 없이 묶음 전체를 실패시킨다', async () => {
	const { rows, service, input, retryable, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['clip'] }, lastError: null, legacy: null });
	rows.MiClip = [{ id: 'clip', userId: 'alice' }];
	rows.MiNote.push(note('0'));
	retryable.add('MiClip');

	await expect(service.processUser('alice')).rejects.toThrow('Connection terminated');
	await expect(service.preview('alice', ['delete'])).rejects.toThrow('Connection terminated');

	expect(rows.Rule[1].lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	expect(rows.MiNote).toHaveLength(1);
});

test('남기기 조건이 쓰지 않는 자료는 조회하지 않아 그 자료의 장애가 정리를 막지 않는다', async () => {
	const { rows, service, input, retryable, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'pinned', value: true }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	retryable.add('MiNoteFavorite');

	expect((await service.processUser('alice')).deleted).toBe(1);

	expect(rows.Rule[1].lastError).toBeNull();
	expect(notifications).toHaveLength(0);
});

test('남기기 조건이 쓰는 자료의 연결 오류는 오류·알림 없이 재시도로 중단한다', async () => {
	const { rows, service, input, retryable, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'favorite', value: true }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	retryable.add('MiNoteFavorite');

	await expect(service.processUser('alice')).rejects.toThrow('Connection terminated');

	expect(rows.MiNote).toHaveLength(1);
	expect(rows.Rule[1].lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	retryable.clear();
	expect((await service.processUser('alice')).deleted).toBe(1);
});

test('재시도 불가한 병합 실패도 오류 기록 없이 묶음을 실패시킨다', async () => {
	const { rows, service, input, buffering, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'count', userId: 'alice', name: '반응 보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null, legacy: null });
	rows.Rule.push({ id: 'pinned', userId: 'alice', name: '고정 보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'pinned', value: true }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	// bindThis 접근자 대신 인스턴스 속성으로 교체해 병합 실패를 주입한다.
	Object.defineProperty(buffering, 'mergeReactions', { value: () => { throw new Error('merge failed'); }, writable: true, configurable: true });

	await expect(service.processUser('alice')).rejects.toThrow('merge failed');

	expect(rows.Rule.find(r => r.id === 'count')!.lastError).toBeNull();
	expect(rows.Rule.find(r => r.id === 'pinned')!.lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	expect(rows.MiNote).toHaveLength(1);
});

test('참조 검증의 일시 실패는 지우기 규칙도 예외 없이 묶음 전체를 실패시킨다', async () => {
	const { rows, service, input, failing } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	failing.add('MiClip');

	await expect(service.processUser('alice')).rejects.toThrow('lookup unavailable');

	expect(rows.Rule[0].lastError).toBeNull();
	expect(rows.MiNote).toHaveLength(1);
	failing.clear();
	// 조회가 복구되면 일시 실패가 아니라 사용자가 고칠 수 있는 참조 오류로 기록하고 규칙만 제외한다.
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.Rule[0].lastError).toMatchObject({ code: 'MISSING_CLIP' });
});

test('일시 실패 뒤 새로 확인한 참조 오류는 한 번 알리고 이후 일시 실패는 오류를 보존한다', async () => {
	const { rows, service, input, failing, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	failing.add('MiClip');
	await expect(service.processUser('alice')).rejects.toThrow('lookup unavailable');
	expect(rows.Rule[1].lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	failing.delete('MiClip');
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'MISSING_CLIP', referenceId: 'gone' });
	expect(notifications).toHaveLength(1);
	failing.add('MiClip');
	await expect(service.processUser('alice')).rejects.toThrow('lookup unavailable');
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'MISSING_CLIP', referenceId: 'gone' });
	expect(rows.MiNote).toHaveLength(1);
	expect(notifications).toHaveLength(1);
});

test('자료 조회 실패는 오류를 저장하지 않고 복구 뒤 바로 삭제한다', async () => {
	const { rows, service, input, meta, buffering, jobs, notifications } = fixture({ detached: true });
	meta.enableReactionsBuffering = true;
	buffering.getMany = async () => { throw new Error('Redis unavailable'); };
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));

	await expect(service.processUser('alice')).rejects.toThrow('Redis unavailable');

	expect(rows.Rule[1].lastError).toBeNull();
	expect((await service.list('alice')).blocked).toBe(false);
	expect(notifications).toHaveLength(0);
	expect(jobs.size).toBe(0);
	buffering.getMany = async () => new Map();
	expect((await service.processUser('alice')).deleted).toBe(1);
});

// === 처리량 예산 ===

test('실제 처리 서비스는 삭제 경로를 사용하고 소량 예산과 재시도 통계를 지킨다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	for (let i = 0; i < 7; i++) rows.MiNote.push(note(String(i)));
	expect((await service.processUser('alice')).deleted).toBe(5);
	expect(rows.MiNote.map(n => n.id)).toEqual(['5', '6']);
	expect((await service.processUser('alice')).deleted).toBe(2);
	expect((await service.processUser('alice')).deleted).toBe(0);
});

test('예약한 예산은 실제 사용량과 무관하게 전액 소비하고 반납하지 않는다', async () => {
	const { rows, service, input, evalCalls } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	for (let i = 0; i < 7; i++) rows.MiNote.push(note(String(i)));
	await service.processUser('alice');
	// 검사와 삭제 예약 각 한 번뿐이며 반납 실행은 없다.
	expect(evalCalls).toHaveLength(2);
	expect(evalCalls.every(call => call[1] === 2 && String(call[0]).includes('INCRBY'))).toBe(true);
	await service.processUser('alice');
	expect(evalCalls).toHaveLength(4);
	// 지울 노트가 없는 페이지는 삭제 예산을 예약하지 않는다.
	await service.processUser('alice');
	expect(evalCalls).toHaveLength(5);
});

test('보존만 하는 페이지는 삭제 예산을 쓰지 않는다', async () => {
	const { rows, service, input, evalCalls } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'pinned', value: false }, lastError: null });
	rows.MiNote.push(note('0'));
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(evalCalls).toHaveLength(1);
	expect(rows.State[0].cursor).toBeNull();
});

test('남기기 참조 오류는 실제 처리 서비스의 모든 삭제를 막는다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', action: 'keep', enabled: true, condition: { type: 'channel', ids: ['missing'] }, lastError: null });
	rows.MiNote.push(note('0'));
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
});

test('다른 처리가 잠금을 가진 경우 새 판정을 시작하지 않고 DB 연결을 반환한다', async () => {
	const { service, lock } = fixture();
	lock.available = false;
	await expect(service.list('alice')).rejects.toThrow('CLEANUP_BUSY');
	expect(lock.released).toBe(1);
});

test('createQueryRunner 실패는 잠금 카운터를 새지 않아 이후 정리가 계속 가능하다', async () => {
	const { service, faults } = fixture();
	faults.createQueryRunner = true;
	for (let i = 0; i < 6; i++) await expect(service.list('alice')).rejects.toThrow('runner unavailable');
	faults.createQueryRunner = false;
	await expect(service.list('alice')).resolves.toBeDefined();
});

// === 수동 요청 ===

test('같은 진행 요청은 중복 등록하지 않고 규칙 수정도 큐를 교체하지 않는다', async () => {
	const { service, input, jobs } = fixture();
	const { rule } = await service.save('alice', input);
	expect((await service.request('alice', [rule.id])).queued).toBe(true);
	expect((await service.request('alice', [rule.id])).queued).toBe(false);
	await service.save('alice', { ...input, condition: { type: 'age', operator: 'gt', seconds: 3600 } }, rule.id);
	expect(jobs.size).toBe(1);
});

test('대기 마커가 끝날 때까지 같은 요청을 중복 접수하지 않고 완료 뒤에는 다시 요청할 수 있다', async () => {
	const { rows, service, input } = fixture();
	const { rule } = await service.save('alice', input);
	await service.request('alice', [rule.id]);
	expect(rows.State[0].manualRequest).toEqual({ ruleIds: [rule.id], cursor: null });

	expect((await service.request('alice', [rule.id])).queued).toBe(false);
	await service.continueManual('alice');

	expect(rows.State[0].manualRequest).toBeNull();
	expect((await service.request('alice', [rule.id])).queued).toBe(true);
});

test('수동 요청은 회차마다 한 페이지씩 이어 처리하고 완료 때 마커를 지운다', async () => {
	const { rows, service, input } = fixture();
	const { rule } = await service.save('alice', input);
	for (let i = 0; i < 7; i++) rows.MiNote.push(note(String(i)));
	await service.request('alice', [rule.id]);

	const first = await service.continueManual('alice');
	expect(first.deleted).toBe(5);
	expect(first.complete).toBe(false);
	expect(rows.State[0].manualRequest).toEqual({ ruleIds: [rule.id], cursor: '4' });

	const second = await service.continueManual('alice');
	expect(second.deleted).toBe(2);
	expect(second.complete).toBe(true);
	expect(rows.State[0].manualRequest).toBeNull();
	expect(rows.MiNote).toHaveLength(0);
});

test('수동 요청의 일시 실패는 마커를 보존하고 복구 뒤 같은 요청을 이어 처리한다', async () => {
	const { rows, service, input, retryable } = fixture();
	const { rule } = await service.save('alice', input);
	for (let i = 0; i < 7; i++) rows.MiNote.push(note(String(i)));
	await service.request('alice', [rule.id]);
	retryable.add('MiNote');

	await expect(service.continueManual('alice')).rejects.toThrow('Connection terminated');
	expect(rows.State[0].manualRequest).toEqual({ ruleIds: [rule.id], cursor: null });
	expect(rows.MiNote).toHaveLength(7);

	retryable.clear();
	expect((await service.continueManual('alice')).deleted).toBe(5);
});

test('수동 요청의 비재시도 오류는 마커를 지우고 새 요청을 접수할 수 있게 한다', async () => {
	const { rows, service, input, failing } = fixture();
	const { rule } = await service.save('alice', input);
	rows.MiNote.push(note('0'));
	await service.request('alice', [rule.id]);
	failing.add('MiNote');

	await expect(service.continueManual('alice')).rejects.toThrow('lookup unavailable');

	expect(rows.State[0].manualRequest).toBeNull();
	failing.clear();
	expect((await service.request('alice', [rule.id])).queued).toBe(true);
});

// === 구 설정 호환 ===

test('기존 API에서 기간 null은 규칙 없이 유지하고 나중의 유효한 기간은 호환 규칙을 만든다', async () => {
	const { rows, service, jobs } = fixture();
	Object.assign(rows.MiUser[0], { autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });
	await service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	expect(rows.Rule.map(rule => rule.legacy)).toEqual(['favorite']);
	expect(rows.MiUser[0].autoDeleteNotesAfterDays).toBeNull();
	expect(rows.State[0].migrated).toBe(true);
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: 30 });
	expect(rows.Rule.find(rule => rule.legacy === 'age')?.condition).toEqual({ type: 'age', operator: 'gt', seconds: 2592000 });
	expect(rows.Rule.find(rule => rule.legacy === 'age')?.automatic).toBe(true);
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: null });
	expect(rows.Rule.map(rule => rule.legacy)).toEqual(['favorite']);
	expect(rows.Rule[0].enabled).toBe(true);
	expect(jobs.size).toBe(0);
});

// 구 API로 호환 기간·즐겨찾기 규칙을 만든 상태에서 시작한다.
async function legacyFixture(days: number | null, favorite: boolean) {
	const f = fixture({ detached: true });
	Object.assign(f.rows.MiUser[0], { autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });
	await f.service.updateLegacy('alice', { autoDeleteNotesAfterDays: days, autoDeleteKeepFavorites: favorite });
	const user = () => f.rows.MiUser[0];
	const rule = (id: string) => f.rows.Rule.find(r => r.id === id);
	const linked = (legacy: 'age' | 'favorite') => f.rows.Rule.find(r => r.legacy === legacy);
	return { ...f, user, rule, linked };
}

const days = (n: number) => ({ type: 'age', operator: 'gt', seconds: n * 86400 });

test('호환 기간 규칙을 분·초·시간·소수 일수로 편집하면 조건을 그대로 둔 일반 규칙으로 전환하고 구 기간은 비활성 값으로 반영한다', async () => {
	for (const seconds of [1800, 0.5, 3600, 129600]) {
		const { service, user, rule, linked } = await legacyFixture(30, true);
		const age = linked('age');
		const condition = { type: 'age', operator: 'gt', seconds };
		const result = await service.save('alice', { name: age.name, action: 'delete', condition }, age.id);
		expect(result.rule).toMatchObject({ legacy: null, enabled: true, automatic: true, condition });
		expect(rule(age.id)).toMatchObject({ legacy: null, enabled: true, automatic: true, condition });
		expect(user()).toMatchObject({ autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: true });
	}
});

test('일반 규칙으로 전환된 기간 규칙은 이후 구 API가 명시한 필드에 대해서만 새 호환 규칙을 만든다', async () => {
	const { rows, service, user, rule, linked } = await legacyFixture(30, true);
	const age = linked('age');
	const condition = { type: 'age', operator: 'gt', seconds: 3600 };
	await service.save('alice', { name: age.name, action: 'delete', condition }, age.id);
	await service.updateLegacy('alice', { autoDeleteKeepFavorites: false });
	expect(rows.Rule.filter(r => r.action === 'delete')).toHaveLength(1);
	expect(rule(age.id)).toMatchObject({ legacy: null, enabled: true, automatic: true, condition });
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: 3 });
	expect(rule(age.id)).toMatchObject({ legacy: null, enabled: true, automatic: true, condition });
	expect(linked('age')).toMatchObject({ condition: days(3), enabled: true, automatic: true });
	expect(linked('age').id).not.toBe(age.id);
	expect(user()).toMatchObject({ autoDeleteNotesAfterDays: 3, autoDeleteKeepFavorites: false });
});

test('gt 이외 연산자나 다른 즐겨찾기 조건·행동으로 편집한 호환 규칙은 그대로 일반 규칙으로 전환한다', async () => {
	for (const operator of ['gte', 'lt', 'lte']) {
		const { service, user, rule, linked } = await legacyFixture(30, true);
		const age = linked('age');
		const condition = { type: 'age', operator, seconds: 7 * 86400 };
		await service.save('alice', { name: age.name, action: 'delete', condition }, age.id);
		expect(rule(age.id)).toMatchObject({ legacy: null, enabled: true, automatic: true, condition });
		expect(user().autoDeleteNotesAfterDays).toBeNull();
	}
	for (const change of [{ action: 'keep' as const, condition: { type: 'flag', field: 'favorite', value: false } }, { action: 'delete' as const, condition: { type: 'flag', field: 'favorite', value: true } }]) {
		const { service, user, rule, linked } = await legacyFixture(null, true);
		const favorite = linked('favorite');
		await service.save('alice', { name: favorite.name, ...change }, favorite.id);
		expect(rule(favorite.id)).toMatchObject({ legacy: null, enabled: true, ...change });
		expect(user().autoDeleteKeepFavorites).toBe(false);
	}
});

test('즐겨찾기 호환 규칙을 중첩 보호 조건으로 편집한 뒤 구 API에서 기간만 바꿔도 사용자 조건과 활성 상태를 잃지 않는다', async () => {
	const { rows, service, user, rule, linked } = await legacyFixture(30, true);
	const favorite = linked('favorite');
	const age = linked('age');
	const condition = { type: 'any', children: [{ type: 'flag', field: 'favorite', value: true }, { type: 'all', children: [{ type: 'keyword', mode: 'literal', value: '중요', flags: '', targets: ['text'] }, { type: 'flag', field: 'reply', value: false }] }] };
	await service.save('alice', { name: '중요한 글 보호', action: 'keep', condition }, favorite.id);
	const edited = { name: '중요한 글 보호', action: 'keep', enabled: true, condition };
	expect(rule(favorite.id)).toMatchObject(edited);
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: 7 });
	expect(rule(favorite.id)).toMatchObject(edited);
	expect(rule(favorite.id)?.legacy).toBeNull();
	expect(rows.Rule.filter(r => r.action === 'keep')).toHaveLength(1);
	expect(rule(age.id)).toMatchObject({ legacy: 'age', condition: days(7), enabled: true, automatic: true });
	expect(user()).toMatchObject({ autoDeleteNotesAfterDays: 7, autoDeleteKeepFavorites: false });
	expect((await service.list('alice')).blocked).toBe(false);
});

test('구 API에서 즐겨찾기만 바꾸면 멈추거나 끈 호환 기간 규칙을 보존한다', async () => {
	for (const change of [{ automatic: false }, { enabled: false, confirmed: true }]) {
		const { service, user, rule, linked } = await legacyFixture(30, false);
		const age = linked('age');
		await service.save('alice', { name: age.name, action: 'delete', condition: days(30), ...change }, age.id);
		const stopped = rule(age.id);
		expect(stopped.legacy).toBe('age');
		expect(user().autoDeleteNotesAfterDays).toBeNull();
		await service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
		expect(rule(age.id)).toEqual(stopped);
		expect(linked('favorite')?.enabled).toBe(true);
		expect(user()).toMatchObject({ autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: true });
	}
});

test('표현 가능한 이름·정수 일수·활성 변경은 호환 연결을 유지하고 구 API와 정확히 왕복한다', async () => {
	const { rows, service, user, rule, linked } = await legacyFixture(30, true);
	const age = linked('age');
	const favorite = linked('favorite');
	await service.save('alice', { name: '오래된 글 정리', action: 'delete', condition: days(7) }, age.id);
	expect(rule(age.id)).toMatchObject({ legacy: 'age', name: '오래된 글 정리', condition: days(7), automatic: true });
	expect(user().autoDeleteNotesAfterDays).toBe(7);
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: 14 });
	expect(rule(age.id)).toMatchObject({ legacy: 'age', name: '오래된 글 정리', condition: days(14), enabled: true, automatic: true });
	await service.save('alice', { name: '즐겨찾기 보호', action: 'keep', condition: favorite.condition, enabled: false, confirmed: true }, favorite.id);
	expect(rule(favorite.id)).toMatchObject({ legacy: 'favorite', name: '즐겨찾기 보호', enabled: false });
	expect(user()).toMatchObject({ autoDeleteNotesAfterDays: 14, autoDeleteKeepFavorites: false });
	await service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	expect(rule(favorite.id)).toMatchObject({ legacy: 'favorite', name: '즐겨찾기 보호', enabled: true, condition: { type: 'flag', field: 'favorite', value: true } });
	expect(rows.Rule).toHaveLength(2);
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: null });
	expect(rows.Rule.map(r => r.id)).toEqual([favorite.id]);
	expect(user()).toMatchObject({ autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: true });
});

test('저장·삭제·구 API 중 쓰기가 실패하면 규칙·상태·구 설정 어느 것도 일부만 반영되지 않는다', async () => {
	const { rows, service, failingWrites, user, rule, linked } = await legacyFixture(30, true);
	const age = linked('age');
	const before = structuredClone(rows);
	Object.assign(before.State[0], { cursor: 'cursor' });
	rows.State[0].cursor = 'cursor';
	for (const entity of ['MiUser', 'State']) {
		failingWrites.add(entity);
		await expect(service.save('alice', { name: '바뀐 이름', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 3600 } }, age.id)).rejects.toThrow('write unavailable');
		await expect(service.save('alice', { name: '바뀐 이름', action: 'delete', condition: days(7) }, age.id)).rejects.toThrow('write unavailable');
		await expect(service.remove('alice', age.id)).rejects.toThrow('write unavailable');
		await expect(service.updateLegacy('alice', { autoDeleteNotesAfterDays: 7 })).rejects.toThrow('write unavailable');
		failingWrites.clear();
		expect(rows).toEqual(before);
	}
	const listed = await service.list('alice');
	expect(listed.rules.find(r => r.id === age.id)).toMatchObject({ legacy: 'age', name: age.name, condition: days(30) });
	expect(rule(age.id)).toMatchObject({ condition: days(30) });
	expect(user().autoDeleteNotesAfterDays).toBe(30);
});

test('구 API의 소수 일수는 500 대신 INVALID_VALUE로 거부하고 아무것도 바꾸지 않는다', async () => {
	const { rows, service } = await legacyFixture(30, true);
	const before = structuredClone(rows);
	const endpoint = new UpdateAutoDeleteSettings(service);
	await expect(endpoint.exec({ autoDeleteNotesAfterDays: 1.5 }, { id: 'alice' } as any, null, null)).rejects.toMatchObject({ code: 'INVALID_VALUE', id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', kind: 'client' });
	expect(rows).toEqual(before);
});

test('구 API의 빈 호출과 같은 값 저장은 진행 커서를 초기화하지 않는다', async () => {
	const { rows, service } = await legacyFixture(30, true);
	rows.State[0].cursor = 'cursor';
	await service.updateLegacy('alice', {});
	expect(rows.State[0].cursor).toBe('cursor');
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: 30 });
	expect(rows.State[0].cursor).toBe('cursor');
	await service.updateLegacy('alice', { autoDeleteNotesAfterDays: 7 });
	expect(rows.State[0].cursor).toBeNull();
});

test('구 endpoint의 같은 즐겨찾기 저장은 이름과 규칙을 보존하고 큐를 만들지 않는다', async () => {
	const { rows, service, linked, jobs } = await legacyFixture(30, true);
	const favorite = linked('favorite');
	Object.assign(favorite, { name: '내 보호', defaultName: null });
	rows.MiNote.push(note('000'));

	await new UpdateAutoDeleteSettings(service).exec({ autoDeleteKeepFavorites: true }, { id: 'alice' } as any, null, null);

	expect(linked('favorite')).toMatchObject({ id: favorite.id, name: '내 보호', defaultName: null, enabled: true });
	expect(rows.Rule).toHaveLength(2);
	expect(jobs.size).toBe(0);
	expect((await service.processUser('alice')).deleted).toBe(1);
});

// === 신규 계정 기본 보호 ===

// 마이그레이션 뒤 가입해 상태 행이 없는 신규 계정. 구 설정 열은 엔티티 기본값이다.
function newAccountFixture() {
	const f = fixture({ detached: true });
	f.rows.MiUser.push({ id: 'bob', host: null, autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: true });
	const bob = () => f.rows.Rule.filter(r => r.userId === 'bob');
	const user = () => f.rows.MiUser.find(u => u.id === 'bob');
	const state = () => f.rows.State.find(s => s.userId === 'bob');
	const favoriteOnly = () => bob().filter(r => r.action === 'keep' && r.condition.type === 'flag' && r.condition.field === 'favorite');
	const summary = () => bob().map(r => [r.name, r.action, r.enabled, r.automatic, r.legacy]);
	return { ...f, bob, user, state, favoriteOnly, summary };
}

const newDefaults = (favorite: boolean) => [
	['고정한 내 글', 'keep', true, false, null],
	['내가 즐겨찾기한 내 글', 'keep', favorite, false, 'favorite'],
	['내 클립에 담은 내 글', 'keep', true, false, null],
	['내가 리액션한 내 글', 'keep', true, false, null],
];

test('상태가 없는 신규 계정은 구 API를 먼저 불러도 신규로 분류되어 기본 보호 4개를 받고, 즐겨찾기 해제는 원래 즐겨찾기 보호에만 적용된다', async () => {
	const { rows, service, jobs, user, state, favoriteOnly, summary } = newAccountFixture();
	await service.updateLegacy('bob', { autoDeleteKeepFavorites: false });
	expect(state()?.migrated).toBe(false);
	expect(summary()).toEqual(newDefaults(false));
	expect(favoriteOnly()).toHaveLength(1);
	expect(user()).toMatchObject({ autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });
	const favoriteId = favoriteOnly()[0].id;
	await service.updateLegacy('bob', { autoDeleteKeepFavorites: true });
	expect(summary()).toEqual(newDefaults(true));
	expect(favoriteOnly().map(r => r.id)).toEqual([favoriteId]);
	expect(user()?.autoDeleteKeepFavorites).toBe(true);
	// 기존 계정 상태와 규칙은 건드리지 않는다.
	expect(rows.Rule.filter(r => r.userId === 'alice')).toEqual([]);
	expect(rows.State.find(s => s.userId === 'alice')?.migrated).toBe(true);
	expect(jobs.size).toBe(0);
});

test('상태가 없는 신규 계정이 구 API로 기간만 먼저 설정해도 기본 보호 4개를 유지한 채 기간 규칙만 더한다', async () => {
	const { service, state, summary, user } = newAccountFixture();
	await service.updateLegacy('bob', { autoDeleteNotesAfterDays: 30 });
	expect(state()?.migrated).toBe(false);
	expect(summary()).toEqual([...newDefaults(true), ['기간이 지난 내 글', 'delete', true, true, 'age']]);
	expect(user()).toMatchObject({ autoDeleteNotesAfterDays: 30, autoDeleteKeepFavorites: true });
});

test('새 API를 먼저 부른 신규 계정도 같은 기본 보호를 받고, 이후 구 API의 즐겨찾기 변경은 같은 보호 하나만 바꾼다', async () => {
	const { service, state, summary, favoriteOnly, user, bob } = newAccountFixture();
	const listed = await service.list('bob');
	expect(listed.blocked).toBe(false);
	expect(summary()).toEqual(newDefaults(true));
	const favoriteId = favoriteOnly()[0].id;
	await service.updateLegacy('bob', { autoDeleteKeepFavorites: false });
	expect(summary()).toEqual(newDefaults(false));
	expect(favoriteOnly().map(r => r.id)).toEqual([favoriteId]);
	expect(state()?.migrated).toBe(false);
	expect(user()?.autoDeleteKeepFavorites).toBe(false);
	// 기본 보호는 각각 편집·삭제할 수 있다.
	const [pinned, , clip] = bob();
	await service.save('bob', { name: '내 클립 보호', action: 'keep', condition: clip.condition }, clip.id);
	await service.remove('bob', pinned.id);
	expect(summary()).toEqual([newDefaults(false)[1], ['내 클립 보호', 'keep', true, false, null], newDefaults(false)[3]]);
});

test('신규 계정의 즐겨찾기 기본 보호를 복합 조건으로 편집하면 구 API 즐겨찾기 변경이 그 규칙을 덮어쓰거나 무시되지 않는다', async () => {
	const { service, bob, favoriteOnly, user } = newAccountFixture();
	await service.list('bob');
	const favorite = favoriteOnly()[0];
	const condition = { type: 'any', children: [{ type: 'flag', field: 'favorite', value: true }, { type: 'keyword', mode: 'literal', value: '중요', flags: '', targets: ['text'] }] };
	await service.save('bob', { name: '중요한 글 보호', action: 'keep', condition }, favorite.id);
	const edited = { id: favorite.id, name: '중요한 글 보호', action: 'keep', enabled: true, legacy: null, condition };
	expect(bob().find(r => r.id === favorite.id)).toMatchObject(edited);
	expect(user()?.autoDeleteKeepFavorites).toBe(false);
	await service.updateLegacy('bob', { autoDeleteKeepFavorites: false });
	expect(bob().find(r => r.id === favorite.id)).toMatchObject(edited);
	expect(bob()).toHaveLength(4);
	// 명시적으로 켜면 기존 분리 정책대로 별도 호환 규칙을 만들고 복합 규칙은 그대로 둔다.
	await service.updateLegacy('bob', { autoDeleteKeepFavorites: true });
	expect(bob().find(r => r.id === favorite.id)).toMatchObject(edited);
	expect(favoriteOnly().filter(r => r.legacy === 'favorite')).toHaveLength(1);
	expect(bob()).toHaveLength(5);
});

test('이관된 상태가 있는 기존 계정은 구 API를 불러도 신규 기본 보호를 받지 않는다', async () => {
	const { rows, service } = fixture({ detached: true });
	Object.assign(rows.MiUser[0], { autoDeleteNotesAfterDays: null, autoDeleteKeepFavorites: false });
	rows.Rule.push({ id: 'favorite', userId: 'alice', name: '내가 즐겨찾기한 내 글', action: 'keep', enabled: false, automatic: false, automaticConfirmed: false, legacy: 'favorite', lastError: null, condition: { type: 'flag', field: 'favorite', value: true } });
	await service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	await service.list('alice');
	expect(rows.Rule.map(r => [r.id, r.enabled, r.legacy])).toEqual([['favorite', true, 'favorite']]);
	expect(rows.State).toHaveLength(1);
	expect(rows.State[0].migrated).toBe(true);
});

// === 기본 이름 ===

test('조건만 수정하면 제품 이름을 유지하고 다른 클라이언트의 명시 이름은 같은 문구여도 사용자 이름이다', async () => {
	const { rows, service, input } = fixture();
	const created = await service.save('alice', input);
	Object.assign(rows.Rule[0], { defaultName: 'age' });
	const { name, ...withoutName } = input;
	const edited = await service.save('alice', withoutName, created.rule.id);
	expect(edited.rule.name).toBe(name);
	expect(edited.rule.defaultName).toBe('age');
	const renamed = await service.save('alice', { ...input, name }, created.rule.id);
	expect(renamed.rule.defaultName).toBeNull();
	await service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	expect(rows.Rule.find(r => r.legacy === 'favorite').defaultName).toBe('favorite');
});

test('사용자 이름이 기본 문구와 같아도 생성·구 API 수정으로 기본 이름이 되지 않는다', async () => {
	const { rows, service, input } = fixture();
	const result = await service.save('alice', { ...input, name: '내가 즐겨찾기한 내 글', action: 'keep', condition: { type: 'flag', field: 'favorite', value: true } });
	expect(result.rule.defaultName).toBeNull();
	Object.assign(rows.Rule[0], { legacy: 'favorite' });
	await service.updateLegacy('alice', { autoDeleteKeepFavorites: true });
	expect(rows.Rule[0].defaultName).toBeNull();
});

test('이름을 생략한 켜기끄기·목록·미리 보기는 기본 이름 출처를 보존한다', async () => {
	const { rows, service, input } = fixture();
	const result = await service.save('alice', input);
	Object.assign(rows.Rule[0], { defaultName: 'age' });
	const { name: _name, ...conditionOnly } = input;
	await service.save('alice', { ...conditionOnly, enabled: false, confirmed: true }, result.rule.id);
	expect(rows.Rule[0].defaultName).toBe('age');
	await service.save('alice', { ...conditionOnly, enabled: true, confirmed: true }, result.rule.id);
	expect((await service.list('alice')).rules[0].defaultName).toBe('age');
	expect((await service.preview('alice', [result.rule.id])).rules[0].defaultName).toBe('age');
});

test('기본 이름의 역할과 다른 행동으로 바꾸면 기본 이름을 지운다', async () => {
	const { rows, service } = fixture();
	rows.Rule.push({ id: 'pinned', userId: 'alice', name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'pinned', value: true }, lastError: null, legacy: null });
	const result = await service.save('alice', { action: 'delete', condition: { type: 'flag', field: 'pinned', value: true } }, 'pinned');
	expect(result.rule.defaultName).toBeNull();
	expect(result.rule.name).toBe('고정한 내 글');
});

test('호환 규칙을 일반 규칙으로 전환할 때도 일반 규칙 수 제한을 적용한다', async () => {
	const { rows, service, linked } = await legacyFixture(30, true);
	for (let i = 0; i < 32; i++) rows.Rule.push({ id: `g${i}`, userId: 'alice', name: `일반${i}`, action: 'delete', enabled: true, automatic: false, condition: { type: 'age', operator: 'gt', seconds: 60 }, lastError: null, legacy: null });
	const age = linked('age');
	await expect(service.save('alice', { name: age.name, action: 'delete', condition: { type: 'keyword', mode: 'literal', value: 'x', flags: '', targets: ['text'] } }, age.id)).rejects.toThrow('RULE_LIMIT');
	expect(rows.Rule.filter(r => r.legacy === null)).toHaveLength(32);
});

// === API 진입점 ===

import CreateEndpoint, { meta as createMeta } from '../../src/server/api/endpoints/i/note-cleanup/create.js';

import UpdateEndpoint, { meta as updateMeta } from '../../src/server/api/endpoints/i/note-cleanup/update.js';

import DeleteEndpoint, { meta as deleteMeta } from '../../src/server/api/endpoints/i/note-cleanup/delete.js';

import ListEndpoint, { meta as listMeta } from '../../src/server/api/endpoints/i/note-cleanup/list.js';

import RequestEndpoint, { meta as requestMeta } from '../../src/server/api/endpoints/i/note-cleanup/request.js';

const noteEntityService = { packMany: async (notes: unknown[]) => notes };

for (const [EndpointClass, meta, params] of [
	[CreateEndpoint, createMeta, { name: '정리', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 60 } }],
	[UpdateEndpoint, updateMeta, { ruleId: 'rule', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 60 } }],
	[DeleteEndpoint, deleteMeta, { ruleId: 'rule' }], [ListEndpoint, listMeta, {}],
	[PreviewEndpoint, previewMeta, { ruleIds: ['rule'] }], [RequestEndpoint, requestMeta, { ruleIds: ['rule'] }],
] as const) {
	test(`${meta.errors.invalidCleanup.id}: 실제 endpoint 잠금 충돌은 503 서버 혼잡이다`, async () => {
		const { service, lock } = fixture();
		lock.available = false;
		const endpoint = new (EndpointClass as any)(service, noteEntityService);
		await expect(endpoint.exec(params, { id: 'alice' } as any, null, null)).rejects.toMatchObject({ code: 'CLEANUP_BUSY', kind: 'server', httpStatusCode: 503 });
		expect((meta.errors as any).cleanupBusy).toMatchObject({ code: 'CLEANUP_BUSY', kind: 'server', httpStatusCode: 503 });
	});
	test(`${meta.errors.invalidCleanup.id}: 입력 오류 세부 정보와 원래 예외를 보존한다`, async () => {
		for (const error of [new CleanupInputError('INVALID_CLIP', 'condition'), new Error('database unavailable')]) {
			const fail = async () => { throw error; };
			const endpoint = new (EndpointClass as any)({ save: fail, remove: fail, list: fail, preview: fail, request: fail }, noteEntityService);
			const result = endpoint.exec(params, { id: 'alice' } as any, null, null);
			if (error instanceof CleanupInputError) await expect(result).rejects.toMatchObject({ code: 'INVALID_CLEANUP', kind: 'client', info: { code: 'INVALID_CLIP', path: 'condition' } });
			else await expect(result).rejects.toBe(error);
		}
	});
}

test('create 진입점은 자동 실행 요청을 명시 거절하고 false·생략은 저장한다', async () => {
	const { service, input, rows } = fixture();
	const endpoint = new CreateEndpoint(service);
	for (const action of ['delete', 'keep']) {
		await expect(endpoint.exec({ ...input, action, automatic: true }, { id: 'alice' } as any, null, null)).rejects.toMatchObject({ code: 'INVALID_CLEANUP', info: { code: action === 'keep' ? 'KEEP_CANNOT_RUN' : 'PREVIEW_REQUIRED' } });
	}
	expect(rows.Rule).toHaveLength(0);
	for (const automatic of [false, undefined]) expect((await endpoint.exec({ ...input, automatic }, { id: 'alice' } as any, null, null)).rule.automatic).toBe(false);
});

// 실제 endpoint의 고정 오류 계약을 검사한다. 번역과 오류 해석은 프런트 시험에서 검사한다.
test.each(['clip', 'channel'] as const)('사라진 %s 저장 오류는 고정 코드와 조건 경로로 안내한다', async type => {
	const { service, input } = fixture();
	const condition = { type: 'all', children: [{ type, ids: ['missing-secret'] }] };
	let caught: unknown;
	try { await new CreateEndpoint(service).exec({ ...input, condition } as any, { id: 'alice' } as any, null, null); } catch (error) { caught = error; }

	expect(caught).toMatchObject({ code: 'INVALID_CLEANUP', info: { code: type === 'clip' ? 'MISSING_CLIP' : 'MISSING_CHANNEL', path: 'condition.children.0' } });
	expect((caught as any).info.code).not.toContain('missing-secret');
});

// === 조회 의존성 ===

test('노트 자체 필드만 쓰는 count renotes와 keyword text·cw는 외부 조회 의존성이 없다', () => {
	expect(cleanupDependencies({ type: 'count', field: 'renotes', operator: 'gte', value: 1 })).toEqual([]);
	expect(cleanupDependencies({ type: 'count', field: 'reactions', operator: 'gte', value: 1 })).toEqual(['reactions']);
	expect(cleanupDependencies({ type: 'keyword', mode: 'literal', value: 'x', flags: '', targets: ['text', 'cw'] })).toEqual([]);
	// 실제 조회 자료를 쓰는 대상은 의존성을 유지한다.
	expect(cleanupDependencies({ type: 'keyword', mode: 'literal', value: 'x', flags: '', targets: ['poll', 'fileComment', 'fileName', 'text'] })).toEqual(['poll', 'files', 'files']);
});

test('자체 필드 조건 남기기는 무관한 조회 실패의 영향을 받지 않고 정상 판정한다', async () => {
	const { rows, service, input, retryable, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'renotes', userId: 'alice', name: '리노트 보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'count', field: 'renotes', operator: 'gte', value: 1 }, lastError: null, legacy: null });
	rows.Rule.push({ id: 'kw', userId: 'alice', name: '본문 키워드 보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'keyword', mode: 'literal', value: 'x', flags: '', targets: ['text', 'cw'] }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	retryable.add('MiNoteFavorite');

	expect((await service.processUser('alice')).deleted).toBe(1);

	expect(rows.Rule.find(r => r.id === 'renotes')!.lastError).toBeNull();
	expect(rows.Rule.find(r => r.id === 'kw')!.lastError).toBeNull();
	expect(notifications).toHaveLength(0);
});

test('키워드가 쓰는 poll 자료의 조회 실패는 오류·알림 없이 재시도로 중단한다', async () => {
	const { rows, service, input, retryable, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'poll', userId: 'alice', name: '투표 보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'flag', field: 'poll', value: true }, lastError: null, legacy: null });
	rows.Rule.push({ id: 'kw', userId: 'alice', name: '투표 키워드 보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'keyword', mode: 'literal', value: 'x', flags: '', targets: ['poll'] }, lastError: null, legacy: null });
	rows.MiNote.push({ ...note('0'), fileIds: ['f1'] });
	retryable.add('MiPoll');
	retryable.add('MiDriveFile');

	await expect(service.processUser('alice')).rejects.toThrow('Connection terminated');

	expect(rows.Rule.find(r => r.id === 'poll')!.lastError).toBeNull();
	expect(rows.Rule.find(r => r.id === 'kw')!.lastError).toBeNull();
	expect(notifications).toHaveLength(0);
	retryable.clear();
	expect((await service.processUser('alice')).deleted).toBe(1);
});
