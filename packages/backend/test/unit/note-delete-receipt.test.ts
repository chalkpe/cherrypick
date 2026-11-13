/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';
import { expect, test, vi } from 'vitest';
// 공통 삭제 서비스 자체를 실행하고 외부 전송 의존성만 대체한다.
vi.mock('../../src/core/RelayService.js', () => ({ RelayService: class {} }));
vi.mock('../../src/core/FederatedInstanceService.js', () => ({ FederatedInstanceService: class {} }));
vi.mock('../../src/core/chart/charts/notes.js', () => ({ default: class {} }));
vi.mock('../../src/core/chart/charts/per-user-notes.js', () => ({ default: class {} }));
vi.mock('../../src/core/chart/charts/instance.js', () => ({ default: class {} }));
vi.mock('../../src/core/GlobalEventService.js', () => ({ GlobalEventService: class {} }));
vi.mock('../../src/core/activitypub/ApRendererService.js', () => ({ ApRendererService: class {} }));
vi.mock('../../src/core/activitypub/ApDeliverManagerService.js', () => ({ ApDeliverManagerService: class {} }));
vi.mock('../../src/core/entities/UserEntityService.js', () => ({ UserEntityService: class {} }));
vi.mock('../../src/core/SearchService.js', () => ({ SearchService: class {} }));
vi.mock('../../src/core/ModerationLogService.js', () => ({ ModerationLogService: class {} }));
import { MiFollowing } from '../../src/models/Following.js';
import { MiNoteDeleteReceipt } from '../../src/models/NoteDeleteReceipt.js';
vi.mock('../../src/core/UtilityService.js', () => ({ UtilityService: class {} }));
import { receiptStore } from '../helpers/note-delete-receipts.js';
import { NoteDeleteService } from '../../src/core/NoteDeleteService.js';
import { runCleanupBatch } from '../../src/core/NoteCleanupRunner.js';

const author = { id: 'alice', uri: null, host: null, isBot: false };
const reply = { id: 'reply', userId: 'alice', userHost: null, replyId: 'parent', renoteId: null, localOnly: false, mentionedRemoteUsers: '[]', text: 'reply', cw: null, fileIds: [], hasPoll: false };

function fixture(meta: Record<string, boolean> = {}) {
	const receipts: any[] = [];
	const snapshots: any[] = [];
	const state = { failInsert: false, present: true, replies: 1, failDelete: false, failParent: false, failCommit: false };
	const effects = Array.from({ length: 7 }, () => vi.fn());
	const [events, chart, perUser, unindex, followers, relays, recipients] = effects;
	const instance = vi.fn();
	const log = vi.fn();
	const remote = { id: 'remote', host: 'remote.test' };
	const original = { id: 'original', uri: 'https://remote.test/notes/original' };
	const renderAnnounce = vi.fn((...args: unknown[]) => ({ type: 'Announce', args }));
	const renderUndo = vi.fn((...args: unknown[]) => ({ type: 'Undo', args }));
	let atDelete: (() => Promise<void>) | undefined;
	const repository: any = {
		target: 'Note',
		existsBy: vi.fn(async (criteria: { userId: string }) => state.present && criteria.userId === author.id),
		findOneBy: async () => original,
		decrement: vi.fn(async () => { if (state.failParent) throw new Error('parent failed'); state.replies--; }),
		delete: vi.fn(async (criteria: { id: string; userId: string }) => {
			await atDelete?.();
			if (state.failDelete) throw new Error('delete failed');
			const affected = state.present && criteria.id === reply.id && criteria.userId === author.id ? 1 : 0;
			if (affected) state.present = false;
			return { affected };
		}),
		createQueryBuilder: () => {
			const builder: any = { leftJoinAndSelect: () => builder, where: () => builder, andWhere: () => builder, getMany: async () => state.present ? [{ user: remote }] : [] };
			return builder;
		},
	};
	// 롤백과 affected만 흉내 낸다. PostgreSQL의 잠금, 격리, 커밋 실패는 검증하지 않는다.
	repository.manager = { transaction: async (work: (manager: unknown) => Promise<unknown>) => {
		const before = { ...state };
		const beforeReceipts = receipts.slice();
		try {
			const result = await work({ getRepository: (target: unknown) => {
				if (target === repository.target) return repository;
				if (target === 'User') return transactionUsers;
				if (target === MiFollowing) return {};
				if (target === MiNoteDeleteReceipt) return { insert: async (receipt: unknown) => {
					if (state.failInsert) throw new Error('insert failed');
					receipts.push(structuredClone(receipt));
					snapshots.push(structuredClone((receipt as any).snapshot));
				} };
				throw new Error('unexpected repository');
			} });
			if (state.failCommit) throw new Error('commit failed');
			return result;
		} catch (error) { Object.assign(state, before); receipts.splice(0, receipts.length, ...beforeReceipts); throw error; }
	} };
	const transactionUsers = { find: vi.fn(async () => []), findOneByOrFail: vi.fn(async () => ({ username: 'alice', host: null })) };
	const poolUsers = { target: 'User', find: vi.fn(() => { throw new Error('pool user lookup'); }), findOneByOrFail: vi.fn(() => { throw new Error('pool user lookup'); }) };
	const runnerStore = receiptStore(receipts);
	runnerStore.charts.notes.applyDeletionInTransaction.mockImplementation(chart);
	runnerStore.charts.perUser.applyDeletionInTransaction.mockImplementation(perUser);
	runnerStore.events.mockImplementation(events);
	runnerStore.search.mockImplementation(unindex);
	runnerStore.decrement.mockImplementation(instance);
	runnerStore.log.mockImplementation(log);
	const utility = { toPuny: vi.fn((host: string) => domainToASCII(host.toLowerCase())) };
	const settings = { enableChartsForRemoteUser: true, enableStatsForFederatedInstances: true, enableChartsForFederatedInstances: true, ...meta };
	const scan = vi.fn(async () => 0);
	const service = new NoteDeleteService(
		{ url: 'https://local.test' } as any, settings as any,
		poolUsers as any, repository,
		{ isLocalUser: (u: typeof author) => u.host == null, isRemoteUser: (u: typeof author) => u.host != null } as any,
		{ deliverToRelays: relays, snapshotDeliveryTargets: async () => [] } as any,
		{ addContext: (x: unknown) => x, renderDelete: (x: unknown) => x, renderTombstone: (x: unknown) => x, renderAnnounce, renderUndo } as any,
		{ deliverToFollowers: followers, deliverToUsers: recipients, createDeliverManager: () => ({ addFollowersRecipe: () => {}, addDirectRecipe: () => {}, selectInboxes: async () => new Map() }) } as any,
		runnerStore.createRunner(),
		utility as any,
		{} as any,
		{ requestRecovery: scan } as any,
	);
	return { snapshots, scan, meta: settings, utility, runnerStore, receipts, transactionUsers, poolUsers, service, state, repository, effects, recipients, renderAnnounce, renderUndo, original, remote, log, instance, barrier: (fn: () => Promise<void>) => { atDelete = fn; } };
}

test('승자 하나가 영수증 하나만 남기며 deletedAt을 재시도에서 유지한다', async () => {
	const f = fixture();
	const results = await Promise.all([f.service.delete(author, reply as any), f.service.delete(author, reply as any)]);

	expect(results.sort()).toEqual([false, true]);
	expect(f.receipts).toHaveLength(1);
	await f.runnerStore.createRunner().scan();
	const saved = structuredClone(f.receipts[0]);
	expect(await f.service.delete(author, reply as any)).toBe(false);
	expect(f.receipts[0]).toEqual(saved);
	expect(saved.deletedAt).toBeInstanceOf(Date);
	expect(+saved.nextAttemptAt).toBeGreaterThan(+saved.deletedAt);
	expect(saved.effects.noteStream).toBeDefined();
	expect(saved.effects.search).toBeDefined();
	expect(saved.effects.activityPub).toMatchObject({ outcome: 'skipped', summary: { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 0 } });
	expect(saved.effects.notesChart).toMatchObject({ outcome: 'applied' });
	expect(saved.effects.charts).toBeDefined();
	expect(saved.completedAt).toBeInstanceOf(Date);
	expect(saved.snapshot).toEqual({ version: 2, state: 'settled' });
});

test('영수증 insert 실패는 삭제와 부모 감소를 모두 롤백한다', async () => {
	const f = fixture();
	f.state.failInsert = true;

	await expect(f.service.delete(author, reply as any)).rejects.toThrow('insert failed');
	expect(f.state.present).toBe(true);
	expect(f.state.replies).toBe(1);
	expect(f.receipts).toEqual([]);
	for (const effect of f.effects) expect(effect).not.toHaveBeenCalled();
});

test('부모 감소 실패는 영수증을 남기지 않는다', async () => {
	const f = fixture();
	f.state.failParent = true;

	await expect(f.service.delete(author, reply as any)).rejects.toThrow('parent failed');
	expect(f.state.present).toBe(true);
	expect(f.state.replies).toBe(1);
	expect(f.receipts).toEqual([]);
});

test('다른 소유자는 노트와 영수증을 읽거나 쓰지 않는다', async () => {
	const f = fixture();

	expect(await f.service.delete({ ...author, id: 'mallory' }, reply as any)).toBe(false);
	expect(f.repository.delete).not.toHaveBeenCalled();
	expect(f.transactionUsers.find).not.toHaveBeenCalled();
	expect(f.receipts).toEqual([]);
	expect(f.state.present).toBe(true);
});

test('snapshot은 허용한 필드만 저장하고 사용자 조회는 transaction manager를 사용한다', async () => {
	const f = fixture();
	f.runnerStore.search.mockRejectedValueOnce(new Error('keep pending'));
	Object.assign(f.remote, { uri: 'https://remote.test/users/u', inbox: 'https://remote.test/inbox', sharedInbox: null, token: 'secret', privateKey: 'secret' });
	f.transactionUsers.find.mockResolvedValue([f.remote] as any);
	const unsafe = { ...reply, mentionedRemoteUsers: '[{"uri":"https://remote.test/users/u"}]', user: { token: 'secret' }, token: 'secret' };
	const moderator = { id: 'mod', username: 'mod', host: null, token: 'secret', privateKey: 'secret' };

	await f.service.delete({ ...author, token: 'secret' } as any, unsafe as any, false, moderator as any);
	await f.runnerStore.createRunner().scan();

	expect(f.transactionUsers.find).toHaveBeenCalledTimes(1);
	expect(f.transactionUsers.findOneByOrFail).toHaveBeenCalledWith({ id: 'alice' });
	expect(f.poolUsers.find).not.toHaveBeenCalled();
	expect(f.poolUsers.findOneByOrFail).not.toHaveBeenCalled();
	const snapshot = f.receipts[0].snapshot;
	expect(JSON.stringify(snapshot)).not.toContain('secret');
	expect(snapshot.actor).toEqual({ id: author.id, host: author.host });
	expect(snapshot.deleter).toBeNull();
	expect(snapshot.author).toBeNull();
	expect(snapshot.note.id).toBe(reply.id);
	expect(snapshot.delivery).toBeNull();
	expect(snapshot).toMatchObject({ version: 3, state: 'delivery_settled' });
	expect(f.log.mock.calls[0][0].info.note.mentionedRemoteUsers).toBe(unsafe.mentionedRemoteUsers);
});

test('Undo 원본과 quiet 및 실패한 후처리의 미완료 상태를 보존한다', async () => {
	const undo = fixture();
	undo.effects[0].mockImplementation(() => { throw new Error('publish failed'); });

	await expect(undo.service.delete(author, { ...reply, text: null, replyId: null, renoteId: 'original' } as any)).resolves.toBe(true);
	await undo.runnerStore.createRunner().scan();
	expect(undo.receipts[0].lastErrorCode).toBe('noteStream_failed');
	expect(+undo.receipts[0].nextAttemptAt).toBeGreaterThan(+undo.receipts[0].deletedAt);
	expect(undo.receipts[0].snapshot).not.toHaveProperty('undoOriginal');
	expect(undo.renderUndo).toHaveBeenCalled();
	expect(undo.receipts[0].effects.noteStream).toBeUndefined();
	expect(undo.receipts[0].effects.search).toBeDefined();
	expect(undo.receipts[0].effects.charts).toBeDefined();
	expect(undo.receipts[0].completedAt).toBeNull();
	const quiet = fixture();
	await quiet.service.delete(author, reply as any, true);
	await quiet.runnerStore.createRunner().scan();
	expect(quiet.receipts[0].quiet).toBe(true);
	expect(quiet.receipts[0].effects.search).toBeDefined();
	expect(quiet.receipts[0].completedAt).toBeInstanceOf(Date);
});

test('호출자가 소유자 snapshot을 위조해도 DB 삭제 조건의 패자는 영수증을 만들지 않는다', async () => {
	const f = fixture();

	expect(await f.service.delete({ ...author, id: 'mallory' }, { ...reply, userId: 'mallory' } as any)).toBe(false);
	expect(f.repository.existsBy).toHaveBeenCalledWith({ id: reply.id, userId: 'mallory' });
	expect(f.repository.delete).not.toHaveBeenCalled();
	expect(f.receipts).toEqual([]);
	expect(f.state.present).toBe(true);
	expect(f.state.replies).toBe(1);
});

test('커밋 실패는 이미 insert한 영수증도 롤백한다', async () => {
	const f = fixture();
	f.state.failCommit = true;

	await expect(f.service.delete(author, reply as any)).rejects.toThrow('commit failed');
	expect(f.receipts).toEqual([]);
	expect(f.state.present).toBe(true);
	expect(f.state.replies).toBe(1);
	for (const effect of f.effects) expect(effect).not.toHaveBeenCalled();
});

test('서비스와 실행기의 차트 연결은 quiet와 삭제 당시 설정 및 소유자 경계를 보존한다', async () => {
	const quiet = fixture();
	await quiet.service.delete(author, reply as any, true);
	await quiet.runnerStore.createRunner().scan();
	expect(quiet.runnerStore.applyBatch).toHaveBeenCalledTimes(1);
	expect(quiet.snapshots[0].charts).toEqual({ version: 1, notes: false, perUser: null, instance: null });
	expect(quiet.receipts[0].effects.notesChart).toMatchObject({ outcome: 'excluded', reason: 'quiet' });
	expect(quiet.runnerStore.charts.notes.applyDeletionInTransaction).not.toHaveBeenCalled();

	const remote = fixture({ enableChartsForRemoteUser: false, enableChartsForFederatedInstances: false });
	const user = { ...author, host: 'remote.test' };
	await remote.service.delete(user, { ...reply, userHost: user.host } as any);
	await remote.runnerStore.createRunner().scan();
	expect(remote.snapshots[0].charts).toEqual({ version: 1, notes: true, perUser: null, instance: null });
	expect(remote.receipts[0].effects.perUserNotesChart).toMatchObject({ outcome: 'excluded', reason: 'settings' });
	expect(remote.runnerStore.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(1);
	expect(await remote.service.delete(user, { ...reply, userHost: user.host } as any)).toBe(false);
	expect(remote.runnerStore.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(1);

	const other = fixture();
	expect(await other.service.delete({ ...author, id: 'other' }, reply as any)).toBe(false);
	expect(other.runnerStore.applyBatch).not.toHaveBeenCalled();
	expect(other.receipts).toHaveLength(0);
});

test('삭제 시점 설정과 quiet를 chart 대상 snapshot에 보존한다', async () => {
	const local = fixture();
	await local.service.delete(author, reply as any);
	expect(local.snapshots[0].charts).toEqual({ version: 1, notes: true, perUser: 'alice', instance: null });

	const remote = fixture();
	remote.meta.enableChartsForRemoteUser = false;
	await remote.service.delete({ ...author, host: 'remote.test' }, { ...reply, userHost: 'remote.test' } as any);
	expect(remote.snapshots[0].charts).toEqual({ version: 1, notes: true, perUser: null, instance: 'remote.test' });
	remote.meta.enableChartsForFederatedInstances = false;
	expect(remote.snapshots[0].charts.instance).toBe('remote.test');

	const quiet = fixture();
	await quiet.service.delete(author, reply as any, true);
	expect(quiet.snapshots[0].charts).toEqual({ version: 1, notes: false, perUser: null, instance: null });
});

test.each(['enableStatsForFederatedInstances', 'enableChartsForFederatedInstances'] as const)('%s 꺼짐은 instance 대상을 삭제 시점에 제외한다', async (setting) => {
	const f = fixture();
	f.meta[setting] = false;
	await f.service.delete({ ...author, host: 'remote.test' }, { ...reply, userHost: 'remote.test' } as any);

	expect(f.snapshots[0].charts.instance).toBeNull();
});

test('instance chart 그룹은 삭제 시점 UtilityService의 정규형을 저장한다', async () => {
	const f = fixture();
	await f.service.delete({ ...author, host: '한글.Example' }, { ...reply, userHost: '한글.Example' } as any);

	expect(f.utility.toPuny).toHaveBeenCalledWith('한글.Example');
	expect(f.snapshots[0].charts.instance).toBe('xn--bj0bj06e.example');
});

test.each([
	{ host: null, failure: 'search' }, { host: 'remote.test', failure: 'search' },
	{ host: null, failure: 'Redis' }, { host: 'remote.test', failure: 'Redis' },
])('일반 삭제는 $failure 실패 중에도 본문과 미사용 원본을 저장하지 않는다: $host', async ({ host, failure }) => {
	const f = fixture();
	if (failure === 'search') f.runnerStore.search.mockRejectedValue(new Error('search down'));
	else f.scan.mockRejectedValue(new Error('Redis down'));
	await f.service.delete({ ...author, host }, { ...reply, userHost: host, text: 'PRIVATE BODY', cw: 'PRIVATE CW', fileIds: ['private-file'], attachedFileTypes: ['image/private'], tags: ['private-tag'], emojis: ['private-emoji'], visibility: 'public' } as any);
	await f.runnerStore.createRunner().scan();

	const snapshot = failure === 'Redis' ? f.snapshots[0] : f.receipts[0].snapshot;
	if (failure === 'Redis') expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(snapshot.note).not.toHaveProperty('text');
	expect(snapshot.note).not.toHaveProperty('cw');
	for (const key of ['fileIds', 'attachedFileTypes', 'tags', 'emojis', 'mentionedRemoteUsers', 'deliveryTargets', 'updatedAt']) expect(snapshot.note).not.toHaveProperty(key);
	expect(snapshot.note.hasFile).toBe(true);
	expect(snapshot.auditNote).toBeNull();
	expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
	if (failure === 'search') expect(f.receipts[0].effects.search).toBeUndefined();
	else expect(f.receipts[0].effects.search).toBeDefined();
});

test.each([
	{ host: null, present: true }, { host: null, present: false },
	{ host: 'remote.test', present: true }, { host: 'remote.test', present: false },
])('감사 확정과 주체 소실 제외는 검색 실패와 독립적으로 복구 내용을 제거한다: $host $present', async ({ host, present }) => {
	const f = fixture();
	f.runnerStore.state.moderatorPresent = present;
	f.runnerStore.search.mockRejectedValue(new Error('search down'));
	await f.service.delete({ ...author, host }, { ...reply, userHost: host, text: 'AUDIT BODY', cw: 'AUDIT CW' } as any, false, { id: 'mod', username: 'mod', host: null } as any);
	await f.runnerStore.createRunner().scan();

	if (present) expect(f.log.mock.calls[0][0].info.note).toMatchObject({ text: 'AUDIT BODY', cw: 'AUDIT CW' });
	else expect(f.receipts[0].effects.moderationLog).toMatchObject({ outcome: 'excluded', reason: 'subject_deleted' });
	expect(f.receipts[0].snapshot.auditNote).toBeNull();
	expect(f.receipts[0].snapshot.deleter).toBeNull();
	expect(f.receipts[0].snapshot.author).toBeNull();
	expect(JSON.stringify(f.receipts[0].snapshot)).not.toContain('AUDIT');
});

test('감사 표식 실패는 복구용 원본을 보존하고 재시도 확정 때만 제거한다', async () => {
	const f = fixture();
	f.runnerStore.state.failEffectMark = 'moderationLog';
	await f.service.delete(author, { ...reply, text: 'AUDIT RETRY', cw: 'CW RETRY' } as any, false, { id: 'mod', username: 'mod', host: null } as any);

	expect(f.receipts[0].snapshot.auditNote).toMatchObject({ text: 'AUDIT RETRY', cw: 'CW RETRY' });
	expect(f.receipts[0].effects.moderationLog).toBeUndefined();
	f.runnerStore.state.failEffectMark = null;
	f.receipts[0].nextAttemptAt = new Date(0);
	await f.runnerStore.createRunner().scan();

	expect(f.receipts[0].effects.moderationLog).toBeDefined();
	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
});

test('stream은 비공개 라우팅을 소비한 뒤 제거하고 quiet에는 복사하지 않는다', async () => {
	const routing = { visibleUserIds: ['recipient'], mentions: ['mention'], replyUserId: 'reply-user' };
	const f = fixture();
	await f.service.delete(author, { ...reply, ...routing, visibility: 'specified' } as any);
	await f.runnerStore.createRunner().scan();

	expect(f.receipts[0].effects.noteStream).toBeDefined();
	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.runnerStore.events.mock.calls[0][0]).toMatchObject({ id: reply.id, ...routing, visibility: 'specified' });
	const quiet = fixture();
	await quiet.service.delete(author, { ...reply, ...routing } as any, true);
	await quiet.runnerStore.createRunner().scan();
	expect(quiet.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(JSON.stringify(quiet.receipts[0].snapshot)).not.toContain('recipient');
});
