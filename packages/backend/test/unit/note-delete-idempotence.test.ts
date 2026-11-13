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

function fixture() {
	const receipts: any[] = [];
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
	const scan = vi.fn(async () => 0);
	const runner = runnerStore.createRunner();
	const runOne = vi.spyOn(runner, 'runOne');
	const directRecipe = vi.fn();
	const service = new NoteDeleteService(
		{ url: 'https://local.test' } as any, { enableChartsForRemoteUser: true, enableStatsForFederatedInstances: true, enableChartsForFederatedInstances: true } as any,
		poolUsers as any, repository,
		{ isLocalUser: (u: typeof author) => u.host == null, isRemoteUser: (u: typeof author) => u.host != null } as any,
		{ deliverToRelays: relays, snapshotDeliveryTargets: async () => [] } as any,
		{ addContext: (x: unknown) => x, renderDelete: (x: unknown) => x, renderTombstone: (x: unknown) => x, renderAnnounce, renderUndo } as any,
		{ deliverToFollowers: followers, deliverToUsers: recipients, createDeliverManager: () => ({ addFollowersRecipe: () => {}, addDirectRecipe: directRecipe, selectInboxes: async () => new Map() }) } as any,
		runner,
		utility as any,
		{} as any,
		{ requestRecovery: scan } as any,
	);
	return { directRecipe, runner, runOne, scan, utility, runnerStore, receipts, transactionUsers, poolUsers, service, state, repository, effects, recipients, renderAnnounce, renderUndo, original, remote, log, instance, barrier: (fn: () => Promise<void>) => { atDelete = fn; } };
}

test('DB 삭제 실패 뒤 다음 정리 순회에서 부모 통계와 후처리를 중복하지 않는다', async () => {
	const f = fixture();
	f.state.failDelete = true;
	const remove = () => f.service.delete(author, { ...reply } as any);
	const failed = await runCleanupBatch([{ id: reply.id, decision: 'delete' }], 1, remove, () => {});
	expect(failed.deleted).toBe(0);
	expect.soft(f.state.replies).toBe(1);
	for (const effect of f.effects) expect.soft(effect).not.toHaveBeenCalled();
	f.state.failDelete = false;
	const retry = await runCleanupBatch([{ id: reply.id, decision: 'delete' }], 1, remove);
	expect(retry.deleted).toBe(1);
	await f.runner.scan();
	expect.soft(f.state.replies).toBe(0);
	for (const effect of f.effects.slice(0, 4)) expect.soft(effect).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.slice(4)) expect.soft(effect).not.toHaveBeenCalled();
	expect(f.scan).toHaveBeenCalled();
});

test('정리와 일반 삭제가 같은 원본을 읽고 진입해도 affected 승자만 후처리한다', async () => {
	const f = fixture();
	let arrived = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.barrier(async () => { if (++arrived === 2) release(); await gate; });
	const cleanup = runCleanupBatch([{ id: reply.id, decision: 'delete' }], 1, () => f.service.delete(author, { ...reply } as any));
	const normal = f.service.delete(author, { ...reply } as any);
	await Promise.all([cleanup, normal]);
	await f.runner.scan();
	expect(arrived).toBe(2);
	expect.soft(f.state.replies).toBe(0);
	for (const effect of f.effects.slice(0, 4)) expect.soft(effect).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.slice(4)) expect.soft(effect).not.toHaveBeenCalled();
	expect(f.scan).toHaveBeenCalled();
});

test('부모 통계 실패는 노트 삭제를 롤백하고 후처리를 시작하지 않는다', async () => {
	const f = fixture();
	f.state.failParent = true;
	await expect(f.service.delete(author, reply as any)).rejects.toThrow('parent failed');
	expect(f.state.present).toBe(true);
	for (const effect of f.effects) expect.soft(effect).not.toHaveBeenCalled();
});

test('삭제 전 원본 리노트와 원격 참여자를 보존하여 Undo 수신대상을 유지한다', async () => {
	const f = fixture();
	await f.service.delete(author, { ...reply, replyId: null, text: null, renoteId: 'original' } as any);
	await f.runner.scan();
	expect(f.renderAnnounce).toHaveBeenCalledWith(f.original.uri, expect.objectContaining({ id: reply.id }));
	expect(f.renderUndo).toHaveBeenCalledTimes(1);
	expect(f.directRecipe).toHaveBeenCalledWith(f.remote);
	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.recipients).not.toHaveBeenCalled();
});

test('quiet 삭제도 검색과 운영자 로그를 한 번만 처리한다', async () => {
	const f = fixture();
	const moderator = { id: 'moderator' } as any;
	expect(await f.service.delete(author, reply as any, true, moderator)).toBe(true);
	await f.runner.scan();
	expect(await f.service.delete(author, reply as any, true, moderator)).toBe(false);
	expect.soft(f.state.replies).toBe(0);
	expect(f.log).toHaveBeenCalledTimes(1);
	expect(f.effects[3]).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.filter((_, i) => i !== 3)) expect(effect).not.toHaveBeenCalled();
});

test('로컬전용은 연합하지 않고 원격 노트 통계는 승자만 갱신한다', async () => {
	const local = fixture();
	await local.service.delete(author, { ...reply, localOnly: true } as any);
	await local.runner.scan();
	expect(local.effects[4]).not.toHaveBeenCalled();
	expect(local.effects[1]).toHaveBeenCalledTimes(1);
	const remote = fixture();
	const user = { ...author, host: 'remote.test', uri: 'https://remote.test/users/alice' };
	await remote.service.delete(user, reply as any);
	await remote.runner.scan();
	await remote.service.delete(user, reply as any);
	expect(remote.instance).toHaveBeenCalledTimes(1);
	expect(remote.effects[4]).not.toHaveBeenCalled();
});

test('커밋 실패 시 외부 효과 없이 롤백하고 다음 삭제를 한 번만 처리한다', async () => {
	const f = fixture();
	f.state.failCommit = true;
	await expect(f.service.delete(author, reply as any)).rejects.toThrow('commit failed');
	expect(f.state.present).toBe(true);
	expect(f.state.replies).toBe(1);
	for (const effect of f.effects) expect(effect).not.toHaveBeenCalled();
	f.state.failCommit = false;
	expect(await f.service.delete(author, reply as any)).toBe(true);
	await f.runner.scan();
	expect(f.state.replies).toBe(0);
	for (const effect of f.effects.slice(0, 4)) expect(effect).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.slice(4)) expect(effect).not.toHaveBeenCalled();
	expect(f.scan).toHaveBeenCalled();
});

test('일반 삭제가 먼저 확정되면 정리 성공수는 0이며 후처리를 재실행하지 않는다', async () => {
	const f = fixture();
	await f.service.delete(author, reply as any);
	await f.runner.scan();
	const cleanup = await runCleanupBatch([{ id: reply.id, decision: 'delete' }], 1, () => f.service.delete(author, { ...reply } as any));
	expect(cleanup.deleted).toBe(0);
	expect(f.repository.decrement).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.slice(0, 4)) expect(effect).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.slice(4)) expect(effect).not.toHaveBeenCalled();
	expect(f.scan).toHaveBeenCalled();
});

test('삭제 커밋 뒤 claim DB 오류는 확정된 승자 응답과 영수증을 보존한다', async () => {
	const f = fixture();
	f.runnerStore.query.mockRejectedValueOnce(new Error('claim database failed'));

	await expect(f.service.delete(author, reply as any)).resolves.toBe(true);

	expect(f.state.present).toBe(false);
	expect(f.receipts).toHaveLength(1);
	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].snapshot.version).toBe(1);
});

test('커밋 뒤 완료 갱신 오류는 삭제 응답과 의무를 보존하고 실제 runner로 재시도한다', async () => {
	const f = fixture();
	f.runnerStore.state.failCompletion = true;

	await expect(f.service.delete(author, reply as any)).resolves.toBe(true);

	expect(f.state.present).toBe(false);
	await expect(f.runner.scan()).rejects.toThrow('completion failed');
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[0].completedAt).toBeNull();
	f.runnerStore.state.failCompletion = false;
	f.receipts[0].claimUntil = new Date(0);
	await f.runnerStore.createRunner().runOne(reply.id, author.id);
	expect(f.receipts[0].claimVersion).toBe(2);
	for (const effect of f.effects.slice(0, 4)) expect(effect).toHaveBeenCalledTimes(1);
	for (const effect of f.effects.slice(4)) expect(effect).not.toHaveBeenCalled();
});

test('커밋 응답이 불명확하면 삭제 승자로 추정하지 않는다', async () => {
	const f = fixture();
	f.repository.manager.transaction = async () => { throw new Error('commit outcome unknown'); };

	await expect(f.service.delete(author, reply as any)).rejects.toThrow('commit outcome unknown');

	expect(f.runnerStore.query).not.toHaveBeenCalled();
	for (const effect of f.effects) expect(effect).not.toHaveBeenCalled();
});

test('커밋 뒤 복구 작업 접수 오류는 영수증을 보존하고 이후 실행기가 복구한다', async () => {
	const f = fixture();
	f.scan.mockRejectedValue(new Error('queue unavailable'));

	await expect(f.service.delete(author, reply as any)).resolves.toBe(true);
	await expect(f.service.delete(author, reply as any)).resolves.toBe(false);

	expect(f.scan).toHaveBeenCalledTimes(2);
	expect(f.state.present).toBe(false);
	expect(f.receipts).toHaveLength(1);
	expect(f.receipts[0].completedAt).toBeNull();
	await f.runnerStore.createRunner().runOne(reply.id, author.id);
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[0].effects.search).toBeDefined();
	expect(f.receipts[0].completedAt).toBeInstanceOf(Date);
});
