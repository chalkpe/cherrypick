/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { domainToASCII } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

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
	const service = new NoteDeleteService(
		{ url: 'https://local.test' } as any, { enableChartsForRemoteUser: true, enableStatsForFederatedInstances: true, enableChartsForFederatedInstances: true } as any,
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
	return { scan, utility, runnerStore, receipts, transactionUsers, poolUsers, service, state, repository, effects, recipients, renderAnnounce, renderUndo, original, remote, log, instance, barrier: (fn: () => Promise<void>) => { atDelete = fn; } };
}

// 실제 서비스의 커밋 뒤 실패를 실행한다. DB·Redis·연합의 내구성 증거는 아니다.
for (const kind of ['Delete', 'Undo'] as const) {
	test(`${kind}: 삭제 확정 뒤 이벤트 실패가 있어도 재시도에서 남은 후처리를 복구한다`, async () => {
		const f = fixture();
		const note = kind === 'Undo' ? { ...reply, text: null, replyId: null, renoteId: 'original' } : { ...reply };
		f.effects[0].mockImplementationOnce(() => {
			expect(f.state.present).toBe(false);
			throw new Error('publish failed after commit');
		});

		await f.service.delete(author, note as any).catch(error => {
			expect(String(error)).toContain('publish failed after commit');
		});
		expect(f.state.present).toBe(false);
		await f.runnerStore.createRunner().scan();
		vi.advanceTimersByTime(5_000);
		expect(await f.service.delete(author, note as any)).toBe(false);
		await f.runnerStore.createRunner().scan();

		expect(f.effects[3]).toHaveBeenCalledTimes(1);
		expect(f.effects[4]).not.toHaveBeenCalled();
		expect(f.recipients).not.toHaveBeenCalled();
		expect(f.scan).toHaveBeenCalled();
		if (kind === 'Undo') expect(f.renderUndo).toHaveBeenCalledTimes(1);
		else expect(f.state.replies).toBe(0);
	});
}

test('quiet 검색 실패 뒤 재시도는 검색과 타인 삭제 로그를 복구한다', async () => {
	const f = fixture();
	const moderator = { id: 'moderator' } as any;
	f.effects[3].mockImplementationOnce(() => { throw new Error('search failed after commit'); });

	await f.service.delete(author, reply as any, true, moderator).catch(error => {
		expect(String(error)).toContain('search failed after commit');
	});
	expect(f.state.present).toBe(false);
	await f.runnerStore.createRunner().scan();
	vi.advanceTimersByTime(5_000);
	expect(await f.service.delete(author, reply as any, true, moderator)).toBe(false);
	await f.runnerStore.createRunner().scan();

	expect(f.effects[3]).toHaveBeenCalledTimes(2);
	expect(f.log).toHaveBeenCalledTimes(1);
	expect(f.state.replies).toBe(0);
});

test('삭제 요청은 검색 완료를 기다리지 않고 영수증은 완료 전까지 남는다', async () => {
	const f = fixture();
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.effects[3].mockImplementationOnce(async () => { entered(); await gate; });

	expect(await f.service.delete(author, reply as any)).toBe(true);
	const processing = f.runnerStore.createRunner().scan();
	await started;
	expect(f.receipts[0].completedAt).toBeNull();
	release();
	await processing;
	expect(f.receipts[0].effects.search).toBeDefined();
});
