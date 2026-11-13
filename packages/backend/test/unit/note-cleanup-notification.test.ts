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
	// 저장 확인 조회는 실제 XREVRANGE 계약처럼 시작 커서('+' 또는 배타적 '(id')와 COUNT 페이지를 따른다.
	let streamReads = 0;
	const xrevrange = async (_key: string, start: string, _end: string, ...args: unknown[]) => {
		streamReads++;
		const count = args[0] === 'COUNT' ? Number(args[1]) : Infinity;
		const seq = (id: string) => Number(id.split('-')[0]);
		let entries = notifications.map((payload, i) => [`${i + 1}-0`, ['data', JSON.stringify(payload)]] as [string, string[]]).reverse();
		if (start !== '+') entries = entries.filter(([id]) => start.startsWith('(') ? seq(id) < seq(start.slice(1)) : seq(id) <= seq(start));
		return entries.slice(0, count);
	};
	// Lua의 저장 계약을 모형화한다. 실제 스크립트 실행·원자성·클러스터 슬롯은 별도 검증 대상이다.
	const redis = { xadd, xrevrange, del: async (key: string) => Number(markers.delete(key)), get: async () => null, eval: async (_script: string, _count: number, stream: string, marker: string, generation: string, max: string, id: string, payload: string) => {
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
	// 보존 한도는 실제 기본값(500)을 쓴다. 최신 50개 밖의 세대도 스트림에는 남아 있을 수 있다.
	const notificationService = new NotificationService({ perUserNotificationsMaxCount: 500 } as any, redis as any, {} as any,
		{ pack: async (value: unknown) => { if (delivery.packFailure) throw new Error('pack unavailable'); return value; } } as any,
		{ gen: () => String(++nextId), parseFull: (id: string) => ({ date: Number(id), additional: 0n }) } as any,
		{ publishMainStream: () => { if (delivery.pushFailure) throw new Error('push unavailable'); } } as any, { pushNotification: () => {} } as any, cache as any, {} as any);
	services.push(notificationService);
	const jobs = new Map<string, unknown>();
	const meta = { enableReactionsBuffering: false };
	const buffered = new Map<string, { deltas: Record<string, number>; pairs: [string, string][] }>();
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	Object.defineProperty(buffering, 'getMany', { value: async () => buffered, writable: true });
	const createService = () => new NoteCleanupService(db as any, { gen: () => String(++nextId), parse: (id: string) => ({ date: noteCreatedAt(id) }) } as any, { systemQueue: { toKey: (s: string) => s, getJob: async (id: string) => jobs.get(id), add: async (name: string, data: unknown, options: { jobId: string }) => { jobs.set(options.jobId, { name, data }); } } } as any, { delete: async (_user: unknown, note: { id: string }) => { rows.MiNote.splice(rows.MiNote.findIndex(n => n.id === note.id), 1); } } as any, notificationService, { eval: async () => 5 } as any, meta as any, buffering, redis as any, cache as any);
	const service = createService();
	const condition = { type: 'age', operator: 'gte', seconds: 60 };
	return { rows, service, createService, markerCount: () => markers.size, notificationService, delivery, notifications, jobs, failing, failingWrites, lock, meta, buffered, buffering, noteReads, streamReads: () => streamReads, input: { name: '정리', action: 'delete' as const, condition } };
}

const keep = () => ({ id: 'keep', userId: 'alice', name: '보호', action: 'keep', enabled: true, automatic: false, condition: { type: 'clip', ids: ['gone'] }, lastError: null, legacy: null });

// 실제 두 서비스의 저장 경계를 실행하며 Redis·DB 자체는 메모리 의존성으로 대체한다.
test.each(['packFailure', 'pushFailure'] as const)('저장 뒤 %s는 같은 오류 알림을 다시 만들지 않는다', async (failure) => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery[failure] = true;

	await service.list('alice');
	await service.list('alice');

	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	expect(notifications).toHaveLength(1);
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

test('규칙 삭제는 규칙에 보관한 중복 억제 상태도 제거한다', async () => {
	const { rows, service } = fixture();
	rows.Rule.push(keep());
	await service.list('alice');
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');

	await service.remove('alice', 'keep');

	expect(rows.Rule).toHaveLength(0);
});

// === 최종 검토 지적 재현 (review-fix) ===

test('Sol1: 프로필 조회 실패로 저장되지 않은 알림은 다음 검사에서 다시 접수한다', async () => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery.profileFailure = true;

	await service.list('alice');
	expect(notifications).toHaveLength(0);
	expect(rows.Rule[0].protectionNotification.status).not.toBe('accepted');
	delivery.profileFailure = false;
	await service.list('alice');

	expect(notifications).toHaveLength(1);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
});

test('Sol1: XADD 실패로 저장되지 않은 알림은 다음 검사에서 다시 접수한다', async () => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery.storageFailure = true;

	await service.list('alice');
	expect(notifications).toHaveLength(0);
	delivery.storageFailure = false;
	await service.list('alice');

	expect(notifications).toHaveLength(1);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
});

test('Sol1: 수신을 끈 사용자는 발송 없이 억제 상태로 구분하고 같은 오류를 재발송하지 않는다', async () => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery.disabled = true;

	await service.list('alice');

	expect(notifications).toHaveLength(0);
	expect(rows.Rule[0].protectionNotification.status).toBe('suppressed');
	delivery.disabled = false;
	await service.list('alice');
	expect(notifications).toHaveLength(0);
});

test('Sol1: 접수 기록 쓰기가 반복 실패해도 이미 저장된 알림은 다시 만들지 않는다', async () => {
	const { rows, service, notifications, delivery } = fixture();
	rows.Rule.push(keep());
	delivery.ackFailure = true;

	await service.list('alice');
	await service.list('alice');

	expect(notifications).toHaveLength(1);
	delivery.ackFailure = false;
	await service.list('alice');
	expect(notifications).toHaveLength(1);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
});

test('Sol1: 저장 뒤 접수 기록 전에 중단된 세대는 스트림 확인으로 중복 없이 접수한다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push(keep());
	await service.list('alice');
	expect(notifications).toHaveLength(1);
	// 접수 기록 직전 프로세스가 중단된 것처럼 같은 세대를 pending으로 되돌린다.
	rows.Rule[0].protectionNotification = { ...rows.Rule[0].protectionNotification, status: 'pending' };

	await service.list('alice');

	expect(notifications).toHaveLength(1);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
});

// === 델타 검토 지적 재현 (review-fix2) ===

// 다른 종류의 알림을 스트림 뒤에 쌓아 저장 확인의 읽기 창 밖으로 세대를 밀어낸다.
const newerNotifications = (notifications: any[], count: number) => {
	for (let i = 0; i < count; i++) notifications.push({ id: `other-${i}`, type: 'reaction', createdAt: new Date().toISOString() });
};

test('Sol2: 저장 확인 창 밖으로 밀린 세대도 페이지 이어읽기로 찾아 중복 알림을 만들지 않는다', async () => {
	const { rows, service, notifications, streamReads } = fixture();
	rows.Rule.push(keep());
	await service.list('alice');
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	// 원래 알림은 스트림에 남아 있지만 최신 50개(한 페이지) 밖으로 밀린다.
	newerNotifications(notifications, 120);
	const before = streamReads();
	rows.Rule[0].protectionNotification = { ...rows.Rule[0].protectionNotification, status: 'pending' };

	await service.list('alice');

	expect(notifications).toHaveLength(121);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	expect(streamReads() - before).toBeGreaterThanOrEqual(2);
});

test('Sol2: 원래 알림이 유실되면 창 밖 세대라도 끝까지 확인한 뒤 새 알림을 한 번만 만든다', async () => {
	const { rows, service, notifications } = fixture();
	rows.Rule.push(keep());
	await service.list('alice');
	// 보존 기한 초과 등으로 원래 알림이 사라지고 다른 알림만 남은 상태
	notifications.splice(0);
	newerNotifications(notifications, 120);
	rows.Rule[0].protectionNotification = { ...rows.Rule[0].protectionNotification, status: 'pending' };

	await service.list('alice');

	expect(notifications).toHaveLength(121);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
});

test('Sol2: 저장 확인은 기준 시각 이전 항목을 만나면 페이지 읽기를 멈춘다', async () => {
	const { rows, service, notifications, streamReads } = fixture();
	// 기준 시각(pendingSince)보다 오래된 항목을 먼저 쌓는다.
	for (let i = 0; i < 80; i++) notifications.push({ id: `old-${i}`, type: 'reaction', createdAt: new Date(0).toISOString() });
	rows.Rule.push(keep());
	await service.list('alice');
	// 원래 알림이 유실된 뒤 최신 항목이 쌓인 상태: 최신 60개 + 기준 이전 80개
	notifications.splice(80, 1);
	newerNotifications(notifications, 60);
	const before = streamReads();
	rows.Rule[0].protectionNotification = { ...rows.Rule[0].protectionNotification, status: 'pending' };

	await service.list('alice');

	expect(notifications).toHaveLength(141);
	expect(rows.Rule[0].protectionNotification.status).toBe('accepted');
	// 첫 확인은 기준 이전 항목에서 멈추고(1회), 새 알림 저장 확인에서 바로 찾는다(1회).
	expect(streamReads() - before).toBe(2);
});
