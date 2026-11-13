/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
vi.mock('../../src/models/_.js', () => Object.fromEntries(['MiNote', 'MiUser', 'MiClip', 'MiClipNote', 'MiChannel', 'MiPoll', 'MiDriveFile', 'MiNoteFavorite', 'MiNoteReaction', 'MiUserNotePining'].map(name => [name, { name }])));
vi.mock('../../src/models/NoteCleanupRule.js', () => ({ MiNoteCleanupRule: { name: 'Rule' }, MiNoteCleanupState: { name: 'State' } }));
vi.mock('../../src/logger.js', () => ({ default: class { error() {} } }));
vi.mock('../../src/core/QueueService.js', () => ({ QueueService: class {} }));
vi.mock('../../src/core/NoteDeleteService.js', () => ({ NoteDeleteService: class {} }));
vi.mock('../../src/core/NotificationService.js', () => ({ NotificationService: class {} }));
vi.mock('../../src/core/IdService.js', () => ({ IdService: class {} }));
import { ReactionsBufferingService } from '../../src/core/ReactionsBufferingService.js';
import { CleanupInputError, NoteCleanupService } from '../../src/core/NoteCleanupService.js';
import UpdateAutoDeleteSettings from '../../src/server/api/endpoints/i/update-auto-delete-settings.js';
import { meta as previewMeta } from '../../src/server/api/endpoints/i/note-cleanup/preview.js';

// detached: 실제 DB처럼 조회 결과를 저장 행과 분리한 복사본으로 돌려준다.
function fixture({ detached = false, noteCreatedAt = (_id: string) => new Date(0) } = {}) {
	const rows: Record<string, any[]> = { Rule: [], State: [{ userId: 'alice', cursor: null, migrated: true }], MiUser: [{ id: 'alice', host: null }], MiNote: [] };
	const failing = new Set<string>();
	const noteReads: string[][] = [];
	// failingWrites: 해당 엔티티의 쓰기 실패를 주입한다.
	const failingWrites = new Set<string>();
	const write = (name: string, input: any) => {
		if (failingWrites.has(name)) throw new Error(`${name} write unavailable`);
		// PostgreSQL integer 열처럼 정수가 아닌 구 기간 값을 거부한다.
		if (name === 'MiUser' && input.autoDeleteNotesAfterDays != null && !Number.isInteger(input.autoDeleteNotesAfterDays)) throw new Error('invalid input syntax for type integer');
	};
	const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => typeof v === 'object' && v !== null ? ('_type' in v || JSON.stringify(row[k]) === JSON.stringify(v)) : row[k] === v);
	const copy = (list: any[]) => detached ? list.map(row => structuredClone(row)) : list;
	const repository = (entity: { name: string }) => {
		const data = rows[entity.name] ??= [];
		const lookup = (where: any) => {
			if (failing.has(entity.name)) throw new Error(`${entity.name} lookup unavailable`);
			return copy(data.filter(row => matches(row, where)));
		};
		return {
			find: async ({ where }: any) => lookup(where),
			findBy: async (where: any) => lookup(where),
			existsBy: async (where: any) => data.some(row => matches(row, where)),
			findOneBy: async (where: any) => data.find(row => matches(row, where)) ?? null,
			findOneByOrFail: async (where: any) => { const row = data.find(row => matches(row, where)); if (!row) throw new Error('not found'); return row; },
			countBy: async (where: any) => data.filter(row => matches(row, where)).length,
			save: async (input: any) => { write(entity.name, input); const i = data.findIndex(row => row.id === input.id); if (i >= 0) data[i] = input; else data.push(input); return input; },
			update: async (id: any, input: any) => { write(entity.name, input); for (const row of data) if (typeof id === 'object' ? matches(row, id) : row.id === id || row.userId === id) Object.assign(row, input); },
			delete: async (where: any) => { write(entity.name, {}); for (let i = data.length - 1; i >= 0; i--) if (matches(data[i], where)) data.splice(i, 1); },
			createQueryBuilder: () => {
				let afterId: string | undefined;
				let ids: string[] | undefined;
				let limit = Infinity;
				const filter = (_sql: string, params?: { afterId?: string; ids?: string[] }) => { afterId = params?.afterId ?? afterId; ids = params?.ids ?? ids; return builder; };
				const builder: any = { where: filter, andWhere: filter, innerJoin: () => builder, orderBy: () => builder, take: (value: number) => { limit = value; return builder; }, select: () => builder, getRawMany: async () => [], getMany: async () => { const result = copy(data.filter(row => (!afterId || row.id > afterId) && (!ids || ids.includes(row.id))).slice(0, limit)); if (entity.name === 'MiNote') noteReads.push(result.map(row => row.id)); return result; } };
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
	const db = { getRepository: repository, transaction, createQueryRunner: () => ({ connect: async () => {}, query: async () => [{ locked: lock.available }], release: async () => { lock.released++; } }) };
	let nextId = 0;
	const notifications: unknown[] = [];
	const jobs = new Map<string, unknown>();
	const meta = { enableReactionsBuffering: false };
	const buffered = new Map<string, { deltas: Record<string, number>; pairs: [string, string][] }>();
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	Object.defineProperty(buffering, 'getMany', { value: async () => buffered, writable: true });
	const service = new NoteCleanupService(db as any, { gen: () => String(++nextId), parse: (id: string) => ({ date: noteCreatedAt(id) }) } as any, { systemQueue: { toKey: (s: string) => s, getJob: async (id: string) => jobs.get(id), add: async (name: string, data: unknown, options: { jobId: string }) => { jobs.set(options.jobId, { name, data }); } } } as any, { delete: async (_user: unknown, note: { id: string }) => { rows.MiNote.splice(rows.MiNote.findIndex(n => n.id === note.id), 1); } } as any, { deleteNoteCleanupProtectionMarker: async () => {}, createNoteCleanupProtectionNotification: async (...args: unknown[]) => { notifications.push(args); return 'accepted'; } } as any, { eval: async () => 5 } as any, meta as any, buffering);
	const condition = { type: 'age', operator: 'gte', seconds: 60 };
	return { rows, service, notifications, jobs, failing, failingWrites, lock, meta, buffered, buffering, noteReads, input: { name: '정리', action: 'delete' as const, condition } };
}

const note = (id: string) => ({ id, userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });
// 회복 범위를 뺀 공개 응답의 일시 실패 형식
const temporaryFailure = (ruleId: string) => ({ ruleId, code: 'TEMPORARY_FAILURE', path: 'condition', message: 'TEMPORARY_FAILURE', userActionable: false });

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

test('부분 페이지 미리 보기 토큰은 현재 규칙만 활성화하며 변경 후에는 무효다', async () => {
	const { service, input } = fixture();
	const { rule } = await service.save('alice', input);
	await expect(service.save('alice', { ...input, automatic: true }, rule.id)).rejects.toThrow('PREVIEW_REQUIRED');
	const preview = await service.preview('alice', [rule.id], undefined, 1);
	const updated = await service.save('alice', { ...input, automatic: true, previewToken: preview.previewToken }, rule.id);
	expect(updated.rule.automatic).toBe(true);
});

test('비활성 지우기와 다른 사용자의 규칙은 미리 보기 및 요청에 사용할 수 없다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'foreign', userId: 'bob', ...input, enabled: true });
	await expect(service.preview('alice', ['foreign'])).rejects.toThrow('INVALID_RULE_SELECTION');
	await expect(service.request('alice', ['foreign'])).rejects.toThrow('INVALID_RULE_SELECTION');
});

test('사라진 남기기 참조는 경로와 ID를 표시하고 미해결 알림을 중복하지 않는다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'all', children: [{ type: 'clip', ids: ['gone'] }] }, lastError: null, legacy: null });
	const first = await service.list('alice');
	expect(first.blocked).toBe(true);
	expect(first.rules[0].lastError).toMatchObject({ code: 'MISSING_CLIP', path: 'condition.children.0', referenceId: 'gone', referenceType: 'clip' });
	await service.list('alice');
	expect(notifications).toHaveLength(1);
});

test('실제 처리 서비스는 삭제 경로를 사용하고 소량 예산과 재시도 통계를 지킨다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	for (let i = 0; i < 7; i++) rows.MiNote.push({ id: String(i), userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });
	expect((await service.processUser('alice')).deleted).toBe(5);
	expect(rows.MiNote.map(n => n.id)).toEqual(['5', '6']);
	expect((await service.processUser('alice')).deleted).toBe(2);
	expect((await service.processUser('alice')).deleted).toBe(0);
});

test('남기기 참조 오류는 실제 처리 서비스의 모든 삭제를 막는다', async () => {
	const { rows, service, input } = fixture();
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', action: 'keep', enabled: true, condition: { type: 'channel', ids: ['missing'] }, lastError: null });
	rows.MiNote.push({ id: '0', userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
});

test('최초 미리 보기 확인 상태는 서버에 보관하여 자동 실행을 다시 켤 때 반복 확인하지 않는다', async () => {
	const { service, input } = fixture();
	const { rule } = await service.save('alice', input);
	const preview = await service.preview('alice', [rule.id]);
	await service.save('alice', { ...input, automatic: true, previewToken: preview.previewToken }, rule.id);
	await service.save('alice', { ...input, automatic: false }, rule.id);
	const result = await service.save('alice', { ...input, automatic: true }, rule.id);
	expect(result.rule.automaticConfirmed).toBe(true);
});

test('사라진 참조를 가진 보호 규칙도 조건을 잃지 않고 명시 확인 후 비활성화할 수 있다', async () => {
	const { rows, service } = fixture();
	const condition = { type: 'clip', ids: ['gone'] };
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition, lastError: null, legacy: null });
	const result = await service.save('alice', { name: '보호', action: 'keep', enabled: false, condition, confirmed: true }, 'keep');
	expect(result.rule.enabled).toBe(false);
	expect(result.rule.condition).toEqual(condition);
});

test('같은 진행 요청은 중복 등록하지 않고 규칙 수정도 큐를 교체하지 않는다', async () => {
	const { service, input, jobs } = fixture();
	const { rule } = await service.save('alice', input);
	expect((await service.request('alice', [rule.id])).queued).toBe(true);
	expect((await service.request('alice', [rule.id])).queued).toBe(false);
	await service.save('alice', { ...input, condition: { type: 'age', operator: 'gt', seconds: 3600 } }, rule.id);
	expect(jobs.size).toBe(1);
});

test('타인 소유의 클립을 보존이나 지우기 조건으로 저장하지 않는다', async () => {
	const { service, input, rows } = fixture();
	rows.MiClip = [{ id: 'foreign', userId: 'bob' }];
	for (const action of ['keep', 'delete'] as const) await expect(service.save('alice', { ...input, action, condition: { type: 'clip', ids: ['foreign'] } })).rejects.toThrow('INVALID_CLIP');
});

test('DB JSON 키 순서가 달라도 최초 확인과 미해결 알림 중복 억제를 보존한다', async () => {
	const { rows, service, input, notifications } = fixture();
	const { rule } = await service.save('alice', input);
	rows.Rule[0].condition = { seconds: 60, operator: 'gte', type: 'age' };
	const preview = await service.preview('alice', [rule.id]);
	expect((await service.save('alice', { ...input, automatic: true, previewToken: preview.previewToken }, rule.id)).rule.automatic).toBe(true);
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	await service.list('alice');
	const error = rows.Rule[1].lastError;
	rows.Rule[1].lastError = Object.fromEntries(Object.entries(error).sort(([a], [b]) => a.localeCompare(b)));
	await service.list('alice');
	expect(notifications).toHaveLength(1);
});

test('다른 처리가 잠금을 가진 경우 새 판정을 시작하지 않고 DB 연결을 반환한다', async () => {
	const { service, lock } = fixture();
	lock.available = false;
	await expect(service.list('alice')).rejects.toThrow('CLEANUP_BUSY');
	expect(lock.released).toBe(1);
});

test('DB 미반영 리액션 델타를 공용 버퍼 서비스로 합쳐 보호 임계값을 판정한다', async () => {
	const { rows, service, input, meta, buffered } = fixture();
	meta.enableReactionsBuffering = true;
	buffered.set('0', { deltas: { like: 1 }, pairs: [] });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', action: 'keep', enabled: true, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null });
	rows.MiNote.push({ id: '0', userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: { like: 1 }, renoteCount: 0, tags: [] });
	expect((await service.preview('alice', ['delete'])).protectedCount).toBe(1);
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
});

test('리액션 버퍼 조회 실패는 보호 실패로 지속 표시하고 새 삭제와 중복 알림을 막는다', async () => {
	const { rows, service, input, meta, buffering, notifications } = fixture();
	meta.enableReactionsBuffering = true;
	buffering.getMany = async () => { throw new Error('Redis unavailable'); };
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', action: 'keep', enabled: true, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null });
	rows.MiNote.push({ id: '0', userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE', userActionable: false });
	expect(notifications).toHaveLength(1);
});

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

test('이번 참조 검증이 일시 실패한 남기기 규칙은 반복 처리에서도 모든 새 삭제를 막고 알림을 중복하지 않는다', async () => {
	const { rows, service, input, failing, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	failing.add('MiClip');
	expect((await service.preview('alice', ['delete'])).deleteCount).toBe(0);
	for (let i = 0; i < 3; i++) expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE', userActionable: false });
	expect((await service.list('alice')).blocked).toBe(true);
	expect(notifications).toHaveLength(1);
});

test('이번 참조 검증이 일시 실패한 지우기 규칙은 NOT 조건으로 참 전환되지 않고 규칙 전체가 제외된다', async () => {
	const { rows, service, failing } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', name: '정리', action: 'delete', enabled: true, automatic: true, condition: { type: 'not', child: { type: 'clip', ids: ['gone'] } }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	failing.add('MiClip');
	expect((await service.preview('alice', ['delete'])).deleteCount).toBe(0);
	for (let i = 0; i < 2; i++) expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
	expect(rows.Rule[0].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE' });
});

test('지난 일시 실패 뒤 새로 확인한 참조 오류는 지난 오류를 근거로 지우지 않고 같은 오류를 다시 알리지 않는다', async () => {
	const { rows, service, input, failing, notifications } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	// 지난 일시 실패는 현재 참조 조회 실패 writer로 만든다.
	failing.add('MiClip');
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE', recovery: { source: 'reference' } });
	failing.delete('MiClip');
	const before = notifications.length;
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'MISSING_CLIP', referenceId: 'gone' });
	expect((await service.list('alice')).blocked).toBe(true);
	failing.add('MiClip');
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'MISSING_CLIP', referenceId: 'gone' });
	expect(rows.MiNote).toHaveLength(1);
	expect(notifications).toHaveLength(before + 1);
});

test('저장된 자료 조회 실패는 목록 다시 불러오기에서 자료를 확인한 뒤에만 해제하고 큐를 만들지 않는다', async () => {
	const { rows, service, input, meta, buffering, jobs, notifications } = fixture({ detached: true });
	meta.enableReactionsBuffering = true;
	const available = buffering.getMany;
	buffering.getMany = async () => { throw new Error('Redis unavailable'); };
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'));
	// 현재 자료 오류 writer가 실패한 페이지 범위를 기록한다.
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE', recovery: { source: 'data', noteIds: ['0'] } });
	expect((await service.list('alice')).blocked).toBe(true);
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE' });
	buffering.getMany = available;
	const recovered = await service.list('alice');
	expect(recovered.blocked).toBe(false);
	expect(recovered.rules.find(rule => rule.id === 'keep')?.lastError).toBeNull();
	expect(jobs.size).toBe(0);
	expect(notifications).toHaveLength(1);
	expect((await service.processUser('alice')).deleted).toBe(1);
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
	const condition = { type: 'any', children: [{ type: 'flag', field: 'favorite', value: true }, { type: 'all', children: [{ type: 'keyword', mode: 'literal', value: '중요', flags: '', targets: ['text'] }, { type: 'not', child: { type: 'flag', field: 'reply', value: true } }] }] };
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
	expect((await service.list('bob')).migrated).toBe(false);
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
	expect(listed.migrated).toBe(false);
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

test('미리 보기 응답은 공개 스키마의 항목 필드만 담고, 규칙 오류는 최상위 errors와 blocked 판정으로 모두 전달한다', async () => {
	const { rows, service, input, meta, buffering } = fixture({ detached: true });
	meta.enableReactionsBuffering = true;
	buffering.getMany = async () => { throw new Error('Redis unavailable'); };
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: false, lastError: null, legacy: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null, legacy: null });
	rows.MiNote.push(note('0'), note('1'));
	const preview = await service.preview('alice', ['delete']);
	const itemKeys = Object.keys(previewMeta.res.properties.items.items.properties).sort();
	expect(preview.items).toHaveLength(2);
	for (const item of preview.items) {
		expect(Object.keys(item).sort()).toEqual(itemKeys);
		expect(item).toMatchObject({ decision: 'keep', reason: 'blocked' });
	}
	expect(Object.keys(preview).sort()).toEqual(Object.keys(previewMeta.res.properties).sort());
	// 보호 규칙의 런타임 실패는 저장된 오류로 최상위 errors에 규칙별로 실리고 삭제 수에 들지 않는다.
	expect(preview.errors).toEqual([expect.objectContaining({ ruleId: 'keep', code: 'TEMPORARY_FAILURE', userActionable: false })]);
	expect(preview.deleteCount).toBe(0);
	expect((await service.list('alice')).blocked).toBe(true);
});

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

import CreateEndpoint, { meta as createMeta } from '../../src/server/api/endpoints/i/note-cleanup/create.js';

import UpdateEndpoint, { meta as updateMeta } from '../../src/server/api/endpoints/i/note-cleanup/update.js';

import DeleteEndpoint, { meta as deleteMeta } from '../../src/server/api/endpoints/i/note-cleanup/delete.js';

import ListEndpoint, { meta as listMeta } from '../../src/server/api/endpoints/i/note-cleanup/list.js';

import RequestEndpoint, { meta as requestMeta } from '../../src/server/api/endpoints/i/note-cleanup/request.js';

import PreviewEndpoint from '../../src/server/api/endpoints/i/note-cleanup/preview.js';

for (const [EndpointClass, meta, params] of [
	[CreateEndpoint, createMeta, { name: '정리', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 60 } }],
	[UpdateEndpoint, updateMeta, { ruleId: 'rule', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 60 } }],
	[DeleteEndpoint, deleteMeta, { ruleId: 'rule' }], [ListEndpoint, listMeta, {}],
	[PreviewEndpoint, previewMeta, { ruleIds: ['rule'] }], [RequestEndpoint, requestMeta, { ruleIds: ['rule'] }],
] as const) {
	test(`${meta.errors.invalidCleanup.id}: 실제 endpoint 잠금 충돌은 503 서버 혼잡이다`, async () => {
		const { service, lock } = fixture();
		lock.available = false;
		const endpoint = new EndpointClass(service);
		await expect(endpoint.exec(params, { id: 'alice' } as any, null, null)).rejects.toMatchObject({ code: 'CLEANUP_BUSY', kind: 'server', httpStatusCode: 503 });
		expect((meta.errors as any).cleanupBusy).toMatchObject({ code: 'CLEANUP_BUSY', kind: 'server', httpStatusCode: 503 });
	});
	test(`${meta.errors.invalidCleanup.id}: 입력 오류 세부 정보와 원래 예외를 보존한다`, async () => {
		for (const error of [new CleanupInputError('INVALID_CLIP', 'condition'), new Error('database unavailable')]) {
			const fail = async () => { throw error; };
			const endpoint = new EndpointClass({ save: fail, remove: fail, list: fail, preview: fail, request: fail } as any);
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

test('이름·실행설정 저장은 미해결 보호 알림을 초기화하지 않고 자료 복구 뒤에만 해제한다', async () => {
	const { rows, service, input, notifications, meta, buffering } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	const condition = { type: 'count', field: 'reactions', operator: 'gte', value: 2 };
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', defaultName: 'selfReaction', action: 'keep', enabled: true, automatic: false, condition, lastError: null });
	rows.MiNote.push(note('0'));
	meta.enableReactionsBuffering = true;
	buffering.getMany = async () => { throw new Error('Redis unavailable'); };
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(notifications).toHaveLength(1);
	for (const change of [{ name: '새 이름' }, { enabled: false, confirmed: true }, { enabled: true, confirmed: true }]) {
		const saved = await service.save('alice', { action: 'keep', condition, ...change }, 'keep');
		expect(saved.rule.lastError).toEqual(temporaryFailure('keep'));
	}
	expect((await service.list('alice')).blocked).toBe(true);
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(notifications).toHaveLength(1);
	// 조건을 실제로 바꾸어도 저장의 참조 확인만으로 자료 오류를 해소하지 않는다.
	const changed = { ...condition, value: 3 };
	expect((await service.save('alice', { action: 'keep', condition: changed }, 'keep')).rule.lastError).toEqual(temporaryFailure('keep'));
	expect((await service.list('alice')).blocked).toBe(true);
	expect(notifications).toHaveLength(1);
	buffering.getMany = async () => new Map();
	expect((await service.list('alice')).blocked).toBe(false);
	expect(rows.Rule.find(r => r.id === 'keep').lastError).toBeNull();
	buffering.getMany = async () => { throw new Error('Redis unavailable again'); };
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(notifications).toHaveLength(2);
});

test('조건·행동 변경은 중지 요청이어도 참조 검증을 건너뛰지 않고 과거 오류는 자료 확인 뒤 해제한다', async () => {
	const { rows, service, input, noteReads } = fixture({ detached: true });
	// 현재 자료 오류 writer가 남기는 실패 페이지 범위를 가진 과거 오류
	const old = { ...temporaryFailure('rule'), recovery: { source: 'data', noteIds: ['0'] } };
	rows.Rule.push({ id: 'rule', userId: 'alice', ...input, enabled: true, automatic: false, lastError: old });
	rows.MiNote.push(note('0'), note('1'));
	await expect(service.save('alice', { action: 'delete', condition: { type: 'clip', ids: ['gone'] }, automatic: false }, 'rule')).rejects.toThrow('MISSING_CLIP');
	expect(rows.Rule[0].lastError).toEqual(old);
	const saved = await service.save('alice', { action: 'keep', condition: input.condition }, 'rule');
	expect(saved.rule.lastError).toEqual(temporaryFailure('rule'));
	expect(rows.Rule[0].lastError).toEqual(old);
	noteReads.length = 0;
	expect((await service.list('alice')).blocked).toBe(false);
	expect(noteReads).toEqual([['0']]);
	expect(rows.Rule[0].lastError).toBeNull();
});

test('실제 처리 → 이름 저장 → 같은 실패 재처리는 최초 보호 알림을 반복하지 않는다', async () => {
	const { rows, service, input, notifications, meta, buffering } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	const condition = { type: 'count', field: 'reactions', operator: 'gte', value: 2 };
	rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition, lastError: null });
	rows.MiNote.push(note('0'));
	meta.enableReactionsBuffering = true;
	buffering.getMany = async () => { throw new Error('Redis unavailable'); };
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(notifications).toHaveLength(1);
	await service.save('alice', { name: '이름만 수정', action: 'keep', condition }, 'keep');
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(rows.MiNote).toHaveLength(1);
	expect(notifications).toHaveLength(1);
});

// 실제 endpoint의 고정 오류 계약을 검사한다. 번역과 오류 해석은 프런트 시험에서 검사한다.
test.each(['clip', 'channel'] as const)('사라진 %s 저장 오류는 고정 코드와 조건 경로로 안내한다', async type => {
	const { service, input } = fixture();
	const { default: Create } = await import('../../src/server/api/endpoints/i/note-cleanup/create.js');
	const condition = { type: 'all', children: [{ type, ids: ['missing-secret'] }] };
	let caught: unknown;
	try { await new Create(service).exec({ ...input, condition } as any, { id: 'alice' } as any, null, null); } catch (error) { caught = error; }

	expect(caught).toMatchObject({ code: 'INVALID_CLEANUP', info: { code: type === 'clip' ? 'MISSING_CLIP' : 'MISSING_CHANNEL', path: 'condition.children.0' } });
	expect((caught as any).info.code).not.toContain('missing-secret');
});

test('구 endpoint의 같은 즐겨찾기 저장은 미해결 보호 오류와 이름을 보존하고 재알림하지 않는다', async () => {
	const { rows, service, linked, failing, notifications, jobs } = await legacyFixture(30, true);
	const favorite = linked('favorite');
	Object.assign(favorite, { name: '내 보호', defaultName: null });
	rows.MiNote.push(note('000'));
	failing.add('MiNoteFavorite');
	await service.preview('alice', [linked('age').id]);
	const error = structuredClone(linked('favorite').lastError);

	await new UpdateAutoDeleteSettings(service).exec({ autoDeleteKeepFavorites: true }, { id: 'alice' } as any, null, null);

	expect(linked('favorite').lastError).toEqual(error);
	expect(linked('favorite')).toMatchObject({ id: favorite.id, name: '내 보호', defaultName: null });
	expect(rows.Rule).toHaveLength(2);
	expect((await service.processUser('alice')).deleted).toBe(0);
	expect(notifications).toHaveLength(1);
	expect(jobs.size).toBe(0);
});

function latePageFixture() {
	const f = fixture({ detached: true });
	f.rows.Rule.push({ id: 'delete', userId: 'alice', ...f.input, enabled: true, automatic: true, lastError: null });
	f.rows.Rule.push({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 }, lastError: null });
	for (let i = 0; i < 150; i++) f.rows.MiNote.push(note(String(i).padStart(3, '0')));
	f.rows.MiNote[125].reactions = { like: -1 };
	return f;
}

test('뒤쪽 페이지의 미해결 자료 오류는 첫 정상 100개 목록 확인으로 해제하거나 재알림하지 않는다', async () => {
	const { rows, service, notifications, jobs } = latePageFixture();
	await service.preview('alice', ['delete'], '099');
	expect(notifications).toHaveLength(1);

	expect((await service.list('alice')).blocked).toBe(true);
	expect((await service.processUser('alice')).deleted).toBe(0);
	await service.preview('alice', ['delete'], '099');

	expect(rows.MiNote).toHaveLength(150);
	expect(notifications).toHaveLength(1);
	expect(jobs.size).toBe(0);
});

test.each(['repair', 'delete-note', 'delete-page', 'condition'] as const)('실패 자료 범위의 실제 해결 %s 뒤 새 실패에는 최초 알림을 다시 보낸다', async resolution => {
	const { rows, service, notifications, jobs, noteReads } = latePageFixture();
	await service.preview('alice', ['delete'], '099');
	expect(notifications).toHaveLength(1);
	if (resolution === 'repair') rows.MiNote[125].reactions = {};
	if (resolution === 'delete-note') rows.MiNote.splice(125, 1);
	if (resolution === 'delete-page') rows.MiNote.splice(100);
	if (resolution === 'condition') await service.save('alice', { name: '보호', action: 'keep', condition: { type: 'flag', field: 'favorite', value: true } }, 'keep');
	noteReads.length = 0;

	const recovered = await service.list('alice');

	expect(recovered.blocked).toBe(false);
	expect(rows.Rule[1].lastError).toBeNull();
	expect(noteReads).toHaveLength(1);
	expect(noteReads[0].every(id => id > '099')).toBe(true);
	expect(noteReads[0].length).toBeLessThanOrEqual(50);
	expect(jobs.size).toBe(0);
	expect(notifications).toHaveLength(1);
	if (resolution === 'condition') {
		await service.save('alice', { name: '보호', action: 'keep', condition: { type: 'count', field: 'reactions', operator: 'gte', value: 2 } }, 'keep');
	} else rows.MiNote[0].reactions = { like: -1 };
	await service.preview('alice', ['delete'], resolution === 'condition' ? '099' : undefined);

	expect(notifications).toHaveLength(2);
	expect((await service.list('alice')).blocked).toBe(true);
	expect(notifications).toHaveLength(2);
});

test('뒤쪽 자료 오류는 무관한 빈 미리 보기와 조건 저장만으로 해제하지 않고 내부 범위는 API에 노출하지 않는다', async () => {
	const { rows, service, jobs } = latePageFixture();
	await service.preview('alice', ['delete'], '099');
	const saved = await service.save('alice', { action: 'keep', condition: rows.Rule[1].condition }, 'keep');

	expect(saved.rule.lastError).not.toHaveProperty('recovery');
	expect(rows.Rule[1].lastError.recovery).toMatchObject({ source: 'data' });
	const preview = await service.preview('alice', ['delete'], '999');
	expect(preview.items).toEqual([]);
	expect(preview.errors).toHaveLength(1);
	expect(preview.errors[0]).not.toHaveProperty('recovery');
	const listed = await service.list('alice');
	expect(listed.blocked).toBe(true);
	expect(listed.rules[1].lastError).not.toHaveProperty('recovery');
	expect(jobs.size).toBe(0);
});

test('뒤쪽 지우기 자료 오류는 해당 규칙만 제외하고 다른 지우기는 계속 판정한다', async () => {
	const { rows, service, notifications } = latePageFixture();
	Object.assign(rows.Rule[1], { action: 'delete' });
	await service.preview('alice', ['delete', 'keep'], '099');

	expect(rows.Rule[1].lastError).toMatchObject({ code: 'TEMPORARY_FAILURE' });
	expect((await service.list('alice')).blocked).toBe(false);
	const preview = await service.preview('alice', ['delete', 'keep']);
	expect(preview.items.every(item => item.deleteRuleIds.includes('delete') && !item.deleteRuleIds.includes('keep'))).toBe(true);
	expect(notifications).toHaveLength(0);
});

test('참조 조회 실패는 자료 페이지와 구분하여 같은 참조 확인 성공으로 회복한다', async () => {
	const { rows, service, input, failing, notifications, noteReads } = fixture({ detached: true });
	rows.Rule.push({ id: 'delete', userId: 'alice', ...input, enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ id: 'keep', userId: 'alice', action: 'keep', enabled: true, condition: { type: 'clip', ids: ['clip'] }, lastError: null });
	rows.MiClip = [{ id: 'clip', userId: 'alice' }];
	failing.add('MiClip');
	await service.list('alice');
	expect(rows.Rule[1].lastError.recovery.source).toBe('reference');
	expect(notifications).toHaveLength(1);
	failing.clear();
	noteReads.length = 0;

	expect((await service.list('alice')).blocked).toBe(false);
	expect(noteReads).toEqual([]);
	rows.MiClip.splice(0);
	await service.list('alice');
	expect(rows.Rule[1].lastError).toMatchObject({ code: 'MISSING_CLIP', referenceId: 'clip' });
	expect(notifications).toHaveLength(2);
});

test('자료 오류 도중 참조가 사라졌다 복원돼도 원래 실패 범위가 해결되기 전에는 해제하지 않는다', async () => {
	const { rows, service, notifications } = latePageFixture();
	rows.MiClip = [{ id: 'clip', userId: 'alice' }];
	rows.Rule[1].condition = { type: 'all', children: [rows.Rule[1].condition, { type: 'clip', ids: ['clip'] }] };
	await service.preview('alice', ['delete'], '099');
	rows.MiClip.splice(0);
	await service.list('alice');
	expect(notifications).toHaveLength(2);
	rows.MiClip.push({ id: 'clip', userId: 'alice' });

	expect((await service.list('alice')).blocked).toBe(true);
	await service.preview('alice', ['delete'], '099');
	expect(notifications).toHaveLength(3);
	rows.MiNote[125].reactions = {};
	expect((await service.list('alice')).blocked).toBe(false);
});

test.each([
	['gt', ['keep', 'keep', 'delete']],
	['gte', ['keep', 'delete', 'delete']],
	['lt', ['delete', 'keep', 'keep']],
	['lte', ['delete', 'delete', 'keep']],
] as const)('작성 ID 시각의 기간 %s는 최근 수정과 관계없이 60초 경계를 판정한다', async (operator, decisions) => {
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

		expect(result.items.map(item => item.noteId)).toEqual(['before', 'equal', 'after']);
		expect(result.items.map(item => item.decision)).toEqual(decisions);
		expect(result.items.map(item => item.createdAt)).toEqual([...created.values()].map(date => date.toISOString()));
	} finally {
		vi.useRealTimers();
	}
});
