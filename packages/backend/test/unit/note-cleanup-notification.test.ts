/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/models/_.js', () => Object.fromEntries(['MiNote', 'MiUser', 'MiClip', 'MiClipNote', 'MiChannel', 'MiPoll', 'MiDriveFile', 'MiNoteFavorite', 'MiNoteReaction', 'MiUserNotePining'].map(name => [name, { name }])));
vi.mock('../../src/models/NoteCleanupRule.js', () => ({ MiNoteCleanupRule: { name: 'Rule' }, MiNoteCleanupState: { name: 'State' } }));
vi.mock('../../src/logger.js', () => ({ default: class { error() {} } }));
vi.mock('../../src/core/QueueService.js', () => ({ QueueService: class {} }));
vi.mock('../../src/core/NoteDeleteService.js', () => ({ NoteDeleteService: class {} }));
vi.mock('../../src/core/CacheService.js', () => ({ CacheService: class {} }));
vi.mock('../../src/core/GlobalEventService.js', () => ({ GlobalEventService: class {} }));
vi.mock('../../src/core/PushNotificationService.js', () => ({ PushNotificationService: class {} }));
vi.mock('../../src/core/UserListService.js', () => ({ UserListService: class {} }));
vi.mock('../../src/core/entities/NotificationEntityService.js', () => ({ NotificationEntityService: class {} }));
vi.mock('../../src/core/IdService.js', () => ({ IdService: class {} }));
import { ReactionsBufferingService } from '../../src/core/ReactionsBufferingService.js';
import { NoteCleanupService } from '../../src/core/NoteCleanupService.js';
import { NotificationService } from '../../src/core/NotificationService.js';
const services: NotificationService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });
vi.mock('../../src/misc/promise-tracker.js', () => ({ trackPromise: (promise: Promise<unknown>) => { void promise.catch(() => {}); } }));

// detached: 실제 DB처럼 조회 결과를 저장 행과 분리한 복사본으로 돌려준다.
function fixture({ detached = true, noteCreatedAt = (_id: string) => new Date(0) } = {}) {
	const rows: Record<string, any[]> = { Rule: [], State: [{ userId: 'alice', cursor: null, migrated: true }], MiUser: [{ id: 'alice', host: null }], MiNote: [] };
	const failing = new Set<string>();
	const noteReads: string[][] = [];
	// failingWrites: 해당 엔티티의 쓰기 실패를 주입한다.
	const failingWrites = new Set<string>();
	const write = (name: string, input: any) => {
		if (name === 'Rule' && input.protectionNotification?.status === 'accepted' && delivery.ackFailure) throw new Error('ack unavailable');
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
			update: async (id: any, input: any) => { write(entity.name, input); let affected = 0; for (const row of data) if (typeof id === 'object' ? matches(row, id) : row.id === id || row.userId === id) { Object.assign(row, structuredClone(input)); affected++; } return { affected }; },
			delete: async (where: any) => { write(entity.name, {}); for (let i = data.length - 1; i >= 0; i--) if (matches(data[i], where)) data.splice(i, 1); },
			createQueryBuilder: () => {
				let afterId: string | undefined;
				let ids: string[] | undefined;
				let limit = Infinity;
				const filter = (_sql: string, params?: { afterId?: string; ids?: string[] }) => { afterId = params?.afterId ?? afterId; ids = params?.ids ?? ids; return builder; };
				const builder: any = { where: filter, andWhere: filter, innerJoin: () => builder, orderBy: () => builder, take: (value: number) => { limit = value; return builder; }, select: () => builder, getRawMany: async () => [], getMany: async () => { if (failing.has(entity.name)) throw new Error(`${entity.name} query unavailable`); const result = copy(data.filter(row => (!afterId || row.id > afterId) && (!ids || ids.includes(row.id))).slice(0, limit)); if (entity.name === 'MiNote') noteReads.push(result.map(row => row.id)); return result; } };
				return builder;
			},
		};
	};
	const lock = { available: true, released: 0, held: false };
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
	const db = { getRepository: repository, transaction, createQueryRunner: () => ({ connect: async () => {}, query: async (sql: string) => { if (sql.includes('pg_advisory_unlock')) { lock.held = false; return []; } const acquired = lock.available && !lock.held; if (acquired) lock.held = true; return [{ locked: acquired }]; }, release: async () => { lock.released++; } }) };
	let nextId = 0;
	const notifications: any[] = [];
	const delivery = { profileFailure: false, storageFailure: false, packFailure: false, disabled: false, loseReply: false, ackFailure: false, profileGate: undefined as Promise<void> | undefined, storageGate: undefined as Promise<void> | undefined, pushFailure: false };
	const markers = new Map<string, number>();
	const xadd = async (...args: any[]) => {
		await delivery.storageGate;
		if (delivery.storageFailure) throw new Error('XADD unavailable');
		notifications.push(JSON.parse(args.at(-1)));
		return `${notifications.length}-0`;
	};
	// Lua의 저장 계약을 모형화한다. 실제 스크립트 실행·원자성·클러스터 슬롯은 별도 검증 대상이다.
	const redis = { xadd, del: async (key: string) => Number(markers.delete(key)), get: async () => null, eval: async (_script: string, _count: number, stream: string, marker: string, generation: string, max: string, id: string, payload: string) => {
		if ((markers.get(marker) ?? 0) > Number(generation)) return -1;
		if ((markers.get(marker) ?? 0) === Number(generation)) return 0;
		await xadd(stream, 'MAXLEN', '~', max, id, 'data', payload);
		markers.set(marker, Number(generation));
		if (delivery.loseReply) { delivery.loseReply = false; throw new Error('response lost after storage'); }
		return 1;
	} };
	const cache = { userProfileCache: { fetch: async () => {
		await delivery.profileGate;
		if (delivery.profileFailure) throw new Error('profile unavailable');
		return { notificationRecieveConfig: delivery.disabled ? { noteCleanupProtectionFailed: { type: 'never' } } : {} };
	} } };
	const notificationService = new NotificationService({ perUserNotificationsMaxCount: 100 } as any, redis as any, {} as any,
		{ pack: async (value: unknown) => { if (delivery.packFailure) throw new Error('pack unavailable'); return value; } } as any,
		{ gen: () => String(++nextId), parseFull: (id: string) => ({ date: Number(id), additional: 0n }) } as any,
		{ publishMainStream: () => { if (delivery.pushFailure) throw new Error('push unavailable'); } } as any, { pushNotification: () => {} } as any, cache as any, {} as any);
	services.push(notificationService);
	const jobs = new Map<string, unknown>();
	const meta = { enableReactionsBuffering: false };
	const buffered = new Map<string, { deltas: Record<string, number>; pairs: [string, string][] }>();
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	Object.defineProperty(buffering, 'getMany', { value: async () => buffered, writable: true });
	const createService = () => new NoteCleanupService(db as any, { gen: () => String(++nextId), parse: (id: string) => ({ date: noteCreatedAt(id) }) } as any, { systemQueue: { toKey: (s: string) => s, getJob: async (id: string) => jobs.get(id), add: async (name: string, data: unknown, options: { jobId: string }) => { jobs.set(options.jobId, { name, data }); } } } as any, { delete: async (_user: unknown, note: { id: string }) => { rows.MiNote.splice(rows.MiNote.findIndex(n => n.id === note.id), 1); } } as any, notificationService, { eval: async () => 5 } as any, meta as any, buffering);
	const service = createService();
	const condition = { type: 'age', operator: 'gte', seconds: 60 };
	return { rows, service, createService, markerCount: () => markers.size, notificationService, delivery, notifications, jobs, failing, failingWrites, lock, meta, buffered, buffering, noteReads, input: { name: '정리', action: 'delete' as const, condition } };
}

const keep = () => ({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });

// 실제 두 서비스의 저장 경계를 실행하며 Redis·DB 자체는 메모리 의존성으로 대체한다.
test.each(['profileFailure', 'storageFailure'] as const)('최초 %s 뒤 같은 미해결 오류의 알림 접수를 재시도한다', async (failure) => {
	const { service, rows, delivery, notifications } = fixture();
	rows.Rule.push(keep());
	delivery[failure] = true;

	await service.list('alice');
	await new Promise<void>(resolve => setImmediate(resolve));
	expect(rows.Rule[0].lastError.code).toBe('MISSING_CLIP');
	expect(notifications).toHaveLength(0);
	delivery[failure] = false;
	await service.list('alice');
	await new Promise<void>(resolve => setImmediate(resolve));

	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toMatchObject({ type: 'noteCleanupProtectionFailed', ruleId: 'keep', errorCode: 'MISSING_CLIP' });
	await service.list('alice');
	expect(notifications).toHaveLength(1);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

test.each(['packFailure', 'pushFailure'] as const)('저장 뒤 %s는 같은 오류 알림을 다시 만들지 않는다', async (failure) => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery[failure] = true;

	await service.list('alice');
	await service.list('alice');

	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	expect(notifications).toHaveLength(1);
});

test.each(['loseReply', 'ackFailure'] as const)('접수 뒤 %s는 다음 검사와 서비스 재생성에서도 같은 알림을 중복하지 않는다', async (failure) => {
	const { rows, service, createService, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery[failure] = true;

	await service.list('alice');
	expect(rows.Rule[0].protectionNotification.status).toBe('pending');
	expect(notifications).toHaveLength(1);
	delivery[failure] = false;
	await createService().list('alice');

	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	expect(notifications).toHaveLength(1);
});

test('명시 수신 거부는 실패와 구분하고 해결 뒤 재발은 새 세대로 접수한다', async () => {
	const { rows, service, notifications, delivery, jobs } = fixture();
	rows.Rule.push(keep());
	delivery.disabled = true;

	await service.list('alice');
	expect(rows.Rule[0].protectionNotification.status).toBe('suppressed');
	delivery.disabled = false;
	await service.list('alice');
	expect(notifications).toHaveLength(0);
	rows.MiClip.push({ id: 'gone', userId: 'alice' });
	expect((await service.list('alice')).blocked).toBe(false);
	expect(jobs.size).toBe(0);
	rows.MiClip.splice(0);
	await service.list('alice');
	await service.list('alice');

	expect(notifications).toHaveLength(1);
	expect(rows.Rule[0].protectionNotification.generation).toBe(2);
});

test('오류만 남은 구 형식은 한 번 재접수하고 내부 상태를 공개 응답에서 제외한다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push({ ...keep(), lastError: { ruleId: 'keep', code: 'MISSING_CLIP', path: 'condition', message: 'MISSING_CLIP', referenceType: 'clip', referenceId: 'gone', userActionable: true } });

	const response = await service.list('alice');
	await service.list('alice');

	expect(notifications).toHaveLength(1);
	expect(response.rules[0]).not.toHaveProperty('protectionNotification');
	expect(JSON.stringify(response)).not.toContain('generation');
});

test('자료 확인 실패는 userActionable=false여도 접수 실패 후 다시 알린다', async () => {
	const { rows, service, input, notifications, delivery, failing } = fixture();
	rows.Rule.push({ ...input, id: 'delete', userId: 'alice', enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ ...keep(), condition: { type: 'flag', field: 'pinned', value: true } });
	rows.MiNote.push({ id: '0', userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });
	failing.add('MiUserNotePining');
	delivery.storageFailure = true;

	await service.preview('alice', ['delete']);
	expect(rows.Rule[1].lastError.userActionable).toBe(false);
	delivery.storageFailure = false;
	await service.list('alice');
	await service.list('alice');

	expect(notifications).toHaveLength(1);
	expect(notifications[0].errorCode).toBe('TEMPORARY_FAILURE');
	expect(rows.MiNote).toHaveLength(1);
});

test('지우기 규칙 오류와 규칙 조회 인프라 실패에는 보호 알림을 만들지 않는다', async () => {
	const { rows, service, notifications, failing } = fixture();
	rows.Rule.push({ ...keep(), action: 'delete' });

	await service.list('alice');
	failing.add('Rule');
	await expect(service.list('alice')).rejects.toThrow('lookup unavailable');

	expect(notifications).toHaveLength(0);
});

test('오류 저장 전 실패하면 알림을 접수하지 않고 다음 검사에서 복구한다', async () => {
	const { rows, service, notifications, failingWrites } = fixture();
	rows.Rule.push(keep());
	failingWrites.add('Rule');

	await expect(service.list('alice')).rejects.toThrow('write unavailable');
	expect(notifications).toHaveLength(0);
	failingWrites.clear();
	await service.list('alice');

	expect(notifications).toHaveLength(1);
});

test.each(['newError', 'resolved', 'otherUser', 'removed'] as const)('늦은 접수 결과는 %s 상태를 덮지 않는다', async (change) => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	const gate = deferred();
	delivery.profileGate = gate.promise;
	const first = service.list('alice');
	await vi.waitFor(() => expect(rows.Rule[0].protectionNotification?.status).toBe('pending'));
	const newer = { generation: 2, identity: '새 오류', status: 'pending' };
	if (change === 'newError') rows.Rule[0].protectionNotification = newer;
	if (change === 'resolved') { rows.Rule[0].lastError = null; rows.Rule[0].protectionNotification = { generation: 1, identity: null, status: 'resolved' }; }
	if (change === 'otherUser') rows.Rule[0].userId = 'bob';
	if (change === 'removed') rows.Rule.splice(0);
	gate.resolve();
	await first;

	if (change === 'newError') expect(rows.Rule[0].protectionNotification).toEqual(newer);
	if (change === 'resolved') expect(rows.Rule[0].protectionNotification.status).toBe('resolved');
	if (change === 'otherUser') expect(rows.Rule[0].protectionNotification.status).toBe('pending');
	if (change === 'removed') expect(rows.Rule).toHaveLength(0);
	expect(notifications).toHaveLength(1);
});

test('접수 중 동시 검사는 기존 계정 잠금에서 거부하고 하나만 접수한다', async () => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	const gate = deferred();
	delivery.profileGate = gate.promise;
	const first = service.list('alice');
	await vi.waitFor(() => expect(rows.Rule[0].protectionNotification?.status).toBe('pending'));

	await expect(service.list('alice')).rejects.toThrow('CLEANUP_BUSY');
	gate.resolve();
	await first;
	await service.list('alice');

	expect(notifications).toHaveLength(1);
});

test('새 오류 identity와 해결 후 같은 오류 재발은 각각 최초 한 번 접수한다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push(keep());

	await service.list('alice');
	rows.Rule[0].condition.ids = ['another'];
	await service.list('alice');
	await service.list('alice');
	expect(notifications).toHaveLength(2);
	rows.MiClip.push({ id: 'another', userId: 'alice' });
	await service.list('alice');
	rows.MiClip.splice(0);
	await service.list('alice');

	expect(notifications).toHaveLength(3);
	expect(rows.Rule[0].protectionNotification.generation).toBe(3);
});

test('일반 createNotification 호출은 기존 XADD와 수신 설정을 사용한다', async () => {
	const { notificationService, notifications, delivery } = fixture();

	notificationService.createNotification('alice', 'noteCleanupProtectionFailed', { ruleId: 'ordinary', errorCode: 'MISSING_CLIP' });
	await vi.waitFor(() => expect(notifications).toHaveLength(1));
	delivery.disabled = true;
	notificationService.createNotification('alice', 'noteCleanupProtectionFailed', { ruleId: 'ordinary', errorCode: 'MISSING_CLIP' });
	await new Promise<void>(resolve => setImmediate(resolve));

	expect(notifications).toHaveLength(1);
});

test('다음 자동 검사에서 자료 재확인이 실패해도 미접수 보호 알림은 재시도한다', async () => {
	const { rows, service, input, notifications, delivery, failing } = fixture();
	rows.Rule.push({ ...input, id: 'delete', userId: 'alice', enabled: true, automatic: true, lastError: null });
	rows.Rule.push({ ...keep(), condition: { type: 'flag', field: 'pinned', value: true } });
	rows.MiNote.push({ id: '0', userId: 'alice', text: '정리', cw: null, fileIds: [], hasPoll: false, renoteId: null, replyId: null, channelId: null, localOnly: false, visibility: 'public', reactions: {}, renoteCount: 0, tags: [] });
	failing.add('MiUserNotePining');
	delivery.storageFailure = true;
	await service.preview('alice', ['delete']);
	expect(notifications).toHaveLength(0);
	delivery.storageFailure = false;
	failing.add('MiNote');

	await expect(service.processUser('alice')).rejects.toThrow('query unavailable');

	expect(notifications).toHaveLength(1);
	expect(rows.Rule[1].lastError.code).toBe('TEMPORARY_FAILURE');
});

test('저장 응답이 오기 전에는 최초 알림을 접수 완료로 기록하지 않는다', async () => {
	const { rows, service, delivery, notifications } = fixture();
	rows.Rule.push(keep());
	const gate = deferred();
	delivery.storageGate = gate.promise;
	const listing = service.list('alice');
	await vi.waitFor(() => expect(rows.Rule[0].protectionNotification?.status).toBe('pending'));

	expect(notifications).toHaveLength(0);
	gate.resolve();
	await listing;

	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	expect(notifications).toHaveLength(1);
});

test('새 세대 접수 뒤 도착한 과거 세대는 성공으로 추정하지 않는다', async () => {
	const { notificationService, notifications } = fixture();
	const data = { ruleId: 'keep', errorCode: 'MISSING_CLIP' };

	await expect(notificationService.createNoteCleanupProtectionNotification('alice', data, 2)).resolves.toBe('accepted');
	await expect(notificationService.createNoteCleanupProtectionNotification('alice', data, 1)).rejects.toThrow('Invalid cleanup notification acceptance result');
	await expect(notificationService.createNoteCleanupProtectionNotification('alice', data, 2)).resolves.toBe('accepted');

	expect(notifications).toHaveLength(1);
});

test('규칙 삭제는 해당 규칙의 중복 억제 메타데이터도 반환한다', async () => {
	const { rows, service, markerCount } = fixture();
	rows.Rule.push(keep());
	await service.list('alice');
	expect(markerCount()).toBe(1);

	await service.remove('alice', 'keep');

	expect(rows.Rule).toHaveLength(0);
	expect(markerCount()).toBe(0);
});
