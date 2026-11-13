/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
// 공통 삭제 서비스 자체를 실행하고 외부 전송 의존성만 대체한다.
vi.mock('../../src/core/NoteDeleteChartService.js', () => ({ NoteDeleteChartService: class {} }));
vi.mock('../../src/core/UtilityService.js', () => ({ UtilityService: class {} }));
vi.mock('../../src/core/QueueService.js', () => ({ QueueService: class {} }));
vi.mock('../../src/core/LoggerService.js', () => ({ LoggerService: class {} }));
vi.mock('../../src/core/IdService.js', () => ({ IdService: class {} }));
vi.mock('../../src/core/SystemAccountService.js', () => ({ SystemAccountService: class {} }));
vi.mock('../../src/core/FederatedInstanceService.js', () => ({ FederatedInstanceService: class {} }));
vi.mock('../../src/core/chart/charts/notes.js', () => ({ default: class {} }));
vi.mock('../../src/core/chart/charts/per-user-notes.js', () => ({ default: class {} }));
vi.mock('../../src/core/chart/charts/instance.js', () => ({ default: class {} }));
vi.mock('../../src/core/GlobalEventService.js', () => ({ GlobalEventService: class {} }));
vi.mock('../../src/core/activitypub/ApRendererService.js', () => ({ ApRendererService: class {} }));
import { ApDeliverManagerService } from '../../src/core/activitypub/ApDeliverManagerService.js';
import { RelayService } from '../../src/core/RelayService.js';
vi.mock('../../src/core/entities/UserEntityService.js', () => ({ UserEntityService: class {} }));
vi.mock('../../src/core/SearchService.js', () => ({ SearchService: class {} }));
vi.mock('../../src/core/ModerationLogService.js', () => ({ ModerationLogService: class {} }));
import { MiFollowing } from '../../src/models/Following.js';
import { MiNoteDeleteDelivery } from '../../src/models/NoteDeleteDelivery.js';
import { MiNoteDeleteReceipt } from '../../src/models/NoteDeleteReceipt.js';
import { NoteDeletePayloadService } from '../../src/core/NoteDeletePayloadService.js';
import { NoteDeleteService } from '../../src/core/NoteDeleteService.js';

const author = { id: 'alice', uri: null, host: null, isBot: false };
const inbox = 'https://remote.test/inbox';
const note = {
	id: 'note', userId: 'alice', userHost: null, replyId: 'parent', renoteId: null,
	localOnly: false, mentionedRemoteUsers: '[]', text: 'private note text', cw: null,
	fileIds: [], hasPoll: false, visibility: 'public', token: 'SECRET', privateKey: 'SECRET',
};

function fixture() {
	const receipts: any[] = [];
	const obligations: any[] = [];
	const state = { present: true, replies: 1, active: false, failDelivery: false };
	const calls: unknown[] = [];
	const remote = { id: 'remote', uri: 'https://remote.test/u', host: 'remote.test', inbox, sharedInbox: inbox, token: 'SECRET' };
	const transactionFollowers = { find: vi.fn(async (): Promise<{ followerSharedInbox: string | null; followerInbox: string | null }[]> => {
		expect(state.active).toBe(true);
		if (transactionFollowers.find.mock.calls.length === 1) expect(state.present).toBe(true);
		return [
			{ followerSharedInbox: inbox, followerInbox: 'https://remote.test/personal' },
			{ followerSharedInbox: inbox, followerInbox: null },
			{ followerSharedInbox: null, followerInbox: null },
		];
	}) };
	const receiptRepository = {
		insert: vi.fn(async (value: unknown) => { receipts.push(structuredClone(value)); }),
		findOneBy: vi.fn(async (where: any) => {
			expect(state.active).toBe(false);
			return receipts.find(r => r.noteId === where.noteId && r.userId === where.userId);
		}),
		findOne: vi.fn(async (options: any) => {
			expect(state.active).toBe(true);
			expect(options.lock).toEqual({ mode: 'pessimistic_write' });
			return receipts.find(r => r.noteId === options.where.noteId && r.userId === options.where.userId);
		}),
		update: vi.fn(async (_where: unknown, values: any) => { Object.assign(receipts[0], structuredClone(values)); }),
	};
	const getRepository = (target: unknown): any => {
		calls.push(target);
		if (target === 'Note') return repository;
		if (target === 'User') return { find: async () => [remote, remote, { ...remote, inbox: null }] };
		if (target === MiFollowing) return transactionFollowers;
		if (target === MiNoteDeleteReceipt) return receiptRepository;
		if (target === MiNoteDeleteDelivery) return { insert: async (values: unknown[]) => {
			obligations.push(structuredClone(values[0]));
			if (state.failDelivery) throw new Error('obligation insert failed');
			obligations.splice(obligations.length - 1, 1, ...structuredClone(values));
		} };
		throw new Error('unexpected repository');
	};
	// 직렬화와 롤백을 흉내 낸다. PostgreSQL 잠금이나 격리의 증거가 아니다.
	let tail = Promise.resolve();
	const manager = { getRepository, transaction: (work: (m: any) => Promise<unknown>) => {
		const operation = tail.then(async () => {
			const before = structuredClone({ state, receipts, obligations });
			state.active = true;
			try { return await work({ getRepository }); } catch (error) {
				Object.assign(state, before.state);
				receipts.splice(0, receipts.length, ...before.receipts);
				obligations.splice(0, obligations.length, ...before.obligations);
				throw error;
			} finally { state.active = false; }
		});
		tail = operation.then(() => {}, () => {});
		return operation;
	} };
	const original = { id: 'original', uri: 'https://remote.test/notes/original' };
	const repository = {
		target: 'Note', manager,
		existsBy: async () => state.present,
		findOneBy: vi.fn(async () => original),
		delete: vi.fn(async () => { const affected = state.present ? 1 : 0; state.present = false; return { affected }; }),
		decrement: vi.fn(async () => { state.replies--; }),
		createQueryBuilder: () => {
			const q: any = { leftJoinAndSelect: () => q, where: () => q, andWhere: () => q, getMany: async () => [] };
			return q;
		},
	};
	const logger: any = { createSubLogger: () => logger, warn: vi.fn() };
	const queue = { deliver: vi.fn(), deliverMany: vi.fn() };
	const ap = new ApDeliverManagerService({ find: () => { throw new Error('pool followers'); } } as any, {} as any, queue as any, { getLogger: () => logger } as any);
	const renderer = {
		addContext: vi.fn((value: any) => ({ '@context': ['context', { extension: 'urn:extension' }], ...value, id: value.id ?? 'https://local.test/delete-id' })),
		renderTombstone: (id: string) => ({ id, type: 'Tombstone' }),
		renderDelete: (object: any) => ({ type: 'Delete', object, actor: 'https://local.test/users/alice' }),
		renderAnnounce: vi.fn((object: string) => ({ type: 'Announce', id: 'https://local.test/notes/note/activity', object })),
		renderUndo: vi.fn((object: any) => ({ type: 'Undo', id: `${object.id}/undo`, object })),
		attachLdSignature: vi.fn(async (activity: any) => {
			expect(state.active).toBe(false);
			return { ...activity, signature: { type: 'RsaSignature2017', signatureValue: 'signed' } };
		}),
	};
	const relayRepository = { findBy: vi.fn(async () => {
		expect(state.active).toBe(false);
		return [{ id: 'relay', inbox, status: 'accepted', privateKey: 'SECRET' }];
	}) };
	const relay = new RelayService(relayRepository as any, {} as any, queue as any, {} as any, renderer as any);
	const fastFollowers = vi.spyOn(ap, 'deliverToFollowers').mockResolvedValue();
	const fastDirect = vi.spyOn(ap, 'deliverToUsers').mockResolvedValue();
	const fastRelay = vi.spyOn(relay, 'deliverToRelays').mockResolvedValue();
	const scan = vi.fn(async () => 0);
	const service = new NoteDeleteService(
		{ url: 'https://local.test' } as any, {} as any,
		{ target: 'User', find: () => { throw new Error('pool user'); } } as any, repository as any,
		{ isLocalUser: (u: any) => u.host == null, isRemoteUser: () => false } as any,
		relay, renderer as any, ap, { runOne: async () => {} } as any, {} as any,
		new NoteDeletePayloadService({ manager } as any, renderer as any),
		{ requestRecovery: scan } as any,
	);
	return { scan, service, state, receipts, obligations, renderer, transactionFollowers, calls, queue, ap, relay, relayRepository, receiptRepository, fastFollowers, fastDirect, fastRelay };
}

const remove = (f: ReturnType<typeof fixture>, change: object = {}, quiet = false) =>
	f.service.delete(author, { ...note, ...change } as any, quiet);

test('실제 선택 helper는 경로 안 Map과 null 생략을 유지하고 경로 사이 중복은 보존한다', async () => {
	const f = fixture();

	await remove(f, { mentionedRemoteUsers: '[{"uri":"https://remote.test/u"}]' });

	const plan = f.receipts[0].snapshot.delivery;
	expect(plan.followers).toEqual([{ endpoint: inbox, isSharedInbox: true, targetKey: expect.any(String) }]);
	expect(plan.directTargets).toEqual([{ endpoint: inbox, isSharedInbox: false, targetKey: expect.any(String) }]);
	expect(plan.relays).toEqual([{ endpoint: inbox, isSharedInbox: false, targetKey: 'relay', relayId: 'relay' }]);
	expect(f.obligations).toHaveLength(3);
	expect(f.obligations.map(o => o.channel)).toEqual(['followers', 'direct', 'relay']);
	expect(f.obligations.every(o => o.state === 'pending' && o.ownerUserId === 'alice' && o.claimVersion === 0 && o.generation === 0)).toBe(true);
	expect(f.calls).toContain(MiFollowing);
	expect(f.calls).toContain(MiNoteDeleteDelivery);
	expect(f.queue.deliver).not.toHaveBeenCalled();
	expect(f.queue.deliverMany).not.toHaveBeenCalled();
	expect(f.fastFollowers).not.toHaveBeenCalled();
	expect(f.fastDirect).not.toHaveBeenCalled();
	expect(f.fastRelay).not.toHaveBeenCalled();
	expect(f.scan).toHaveBeenCalledTimes(1);
});

test.each(['Delete', 'Undo'])('%s 문자열/digest와 context·ID를 고정하고 보안 필드와 노트 본문을 payload에 복제하지 않는다', async (kind) => {
	const f = fixture();

	await remove(f, kind === 'Undo' ? { text: null, replyId: null, renoteId: 'original' } : {});

	const plan = JSON.parse(JSON.stringify(f.receipts[0].snapshot.delivery));
	expect(plan.activity.digest).toBe(`SHA-256=${createHash('sha256').update(plan.activity.content).digest('base64')}`);
	const activity = JSON.parse(plan.activity.content);
	expect(activity.type).toBe(kind);
	expect(activity['@context']).toEqual(['context', { extension: 'urn:extension' }]);
	expect(plan.activity.content).not.toContain('SECRET');
	expect(plan.activity.content).not.toContain('private note text');
	expect(plan.relayUnsigned.content).not.toContain('SECRET');
	expect(JSON.parse(plan.relayUnsigned.content).to).toEqual(['https://www.w3.org/ns/activitystreams#Public']);
	expect(plan.relaySigned).toBeNull();
	expect(f.renderer.attachLdSignature).not.toHaveBeenCalled();
	if (kind === 'Undo') {
		expect(activity.id).toBe('https://local.test/notes/note/activity/undo');
		expect(activity.object.object).toBe('https://remote.test/notes/original');
	} else expect(activity.object).toEqual({ id: 'https://local.test/notes/note', type: 'Tombstone' });
	const saved = plan.activity.content;
	await remove(f);
	expect(f.receipts[0].snapshot.delivery.activity.content).toBe(saved);
});

test.each(['quiet', 'localOnly', 'remote'])('%s는 명시적인 빈 전달 계획이다', async (kind) => {
	const f = fixture();

	if (kind === 'remote') await f.service.delete({ ...author, host: 'remote.test' }, note as any);
	else await remove(f, { localOnly: kind === 'localOnly' }, kind === 'quiet');

	expect(f.receipts[0].snapshot.delivery).toEqual({
		version: 2, reason: kind, followers: [], directTargets: [], relays: [],
		activity: null, relayUnsigned: null, relaySigned: null,
	});
	expect(f.obligations).toEqual([]);
	expect(f.relayRepository.findBy).not.toHaveBeenCalled();
	expect(f.transactionFollowers.find).not.toHaveBeenCalled();
});

test('승자만 의무 한 세트를 저장하고 의무 insert 실패는 receipt·부모·삭제를 롤백한다', async () => {
	const failed = fixture();
	failed.state.failDelivery = true;

	await expect(remove(failed)).rejects.toThrow('obligation insert failed');

	expect(failed.state.present).toBe(true);
	expect(failed.state.replies).toBe(1);
	expect(failed.receipts).toEqual([]);
	expect(failed.obligations).toEqual([]);
	expect(failed.fastFollowers).not.toHaveBeenCalled();
	const winner = fixture();
	const results = await Promise.all([remove(winner), remove(winner)]);
	expect(results).toEqual([true, false]);
	expect(winner.receipts).toHaveLength(1);
	expect(winner.obligations).toHaveLength(2);
});

test('relay는 기존 accepted 캐시를 재사용하고 clone/to 보정은 원본을 변경하지 않는다', async () => {
	const f = fixture();

	const targets = await f.relay.snapshotDeliveryTargets();
	targets[0].inbox = 'https://changed.test/inbox';
	expect((await f.relay.snapshotDeliveryTargets())[0].inbox).toBe(inbox);
	expect(f.relayRepository.findBy).toHaveBeenCalledTimes(1);
	const original = { to: ['urn:existing'], nested: { value: 1 } };
	const copy = f.relay.prepareActivity(original);
	copy.nested.value = 2;
	expect(copy.to).toEqual(['urn:existing']);
	expect(original.nested.value).toBe(1);
});

test('relay 서명은 transaction 밖에서 하고 경합 시 최초 문자열만 저장하며 최신 snapshot/effects를 보존한다', async () => {
	const f = fixture();
	await remove(f);
	let arrived = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.renderer.attachLdSignature.mockImplementation(async (activity: any) => {
		expect(f.state.active).toBe(false);
		const candidate = ++arrived;
		if (arrived === 2) {
			f.receipts[0].effects.search = { completedAt: 'later' };
			f.receipts[0].snapshot.charts.notes = false;
			f.receipts[0].snapshot.auditNote = null;
			f.receipts[0].snapshot.author = null;
			f.receipts[0].snapshot.deleter = null;
			release();
		}
		await gate;
		return { ...activity, signature: { signatureValue: `candidate-${candidate}` } } as any;
	});

	const results = await Promise.all([
		f.service.prepareRelaySignedPayload('note', 'alice'),
		f.service.prepareRelaySignedPayload('note', 'alice'),
	]);

	expect(arrived).toBe(2);
	expect(results[0]).toEqual(results[1]);
	expect(f.receiptRepository.update).toHaveBeenCalledTimes(1);
	expect(f.receipts[0].snapshot.delivery.relaySigned).toEqual(results[0]);
	expect(f.receipts[0].effects.search).toEqual({ completedAt: 'later' });
	expect(f.receipts[0].snapshot.charts.notes).toBe(false);
	expect(f.receipts[0].snapshot.auditNote).toBeNull();
	expect(f.receipts[0].snapshot.author).toBeNull();
	expect(f.receipts[0].snapshot.deleter).toBeNull();
	expect(f.obligations.every(o => o.state === 'pending')).toBe(true);
	expect(await f.service.prepareRelaySignedPayload('note', 'mallory')).toBeNull();
	expect(await f.service.prepareRelaySignedPayload('note', 'alice')).toEqual(results[0]);
	expect(f.renderer.attachLdSignature).toHaveBeenCalledTimes(2);
});

test('서명 실패는 미서명 계획과 pending 의무를 보존한다', async () => {
	const f = fixture();
	await remove(f);
	f.renderer.attachLdSignature.mockRejectedValueOnce(new Error('key unavailable'));

	await expect(f.service.prepareRelaySignedPayload('note', 'alice')).rejects.toThrow('key unavailable');

	expect(f.receipts[0].snapshot.delivery.relaySigned).toBeNull();
	expect(f.obligations.every(o => o.state === 'pending')).toBe(true);
	expect(f.receiptRepository.update).not.toHaveBeenCalled();
});

test('기존 execute도 같은 선택 helper를 사용하고 한 manager 안 sharedInbox 중복만 생략한다', async () => {
	const f = fixture();
	const followings = { find: vi.fn(async () => [{ followerSharedInbox: inbox, followerInbox: null }]) };
	const activity = { id: 'urn:test', type: 'Delete' };
	const manager = f.ap.createDeliverManager(author, activity as any, false, followings as any);
	manager.addFollowersRecipe();
	manager.addDirectRecipe({ inbox: 'https://remote.test/personal', sharedInbox: inbox } as any);
	manager.addDirectRecipe({ inbox: null, sharedInbox: null } as any);

	await manager.execute();

	expect(f.queue.deliverMany).toHaveBeenCalledWith({ id: 'alice' }, activity, new Map([[inbox, true]]));
});

test('긴 endpoint를 자르지 않고 서로 다른 targetKey로 보존한다', async () => {
	const f = fixture();
	const first = `https://remote.test/${'x'.repeat(5000)}a`;
	const second = `https://remote.test/${'x'.repeat(5000)}b`;
	f.transactionFollowers.find.mockResolvedValueOnce([
		{ followerSharedInbox: null, followerInbox: first },
		{ followerSharedInbox: null, followerInbox: second },
	]);

	await remove(f);

	const targets = f.receipts[0].snapshot.delivery.followers;
	expect(targets.map((target: any) => target.endpoint)).toEqual([first, second]);
	expect(targets[0].targetKey).not.toBe(targets[1].targetKey);
	expect(targets.every((target: any) => target.targetKey.length === 64)).toBe(true);
});

test('선택적 followers와 Map 덮어쓰기 규칙은 기존 manager에서 유지된다', async () => {
	const f = fixture();
	const followings = { find: vi.fn(async () => [
		{ followerHost: 'remote.test', followerSharedInbox: inbox, followerInbox: null },
		{ followerHost: 'remote.test', followerSharedInbox: null, followerInbox: inbox },
		{ followerHost: 'other.test', followerSharedInbox: 'https://other.test/inbox', followerInbox: null },
	]) };
	const manager = f.ap.createDeliverManager(author, null, false, followings as any);
	manager.addFollowersRecipe();
	manager.addSelectiveFollowersRecipe({ mode: 'include', hosts: ['remote.test'] });

	expect(await manager.selectInboxes()).toEqual(new Map([[inbox, false]]));
	expect(f.queue.deliverMany).not.toHaveBeenCalled();
});

test.each([
	['본문', { text: 'private quote' }, 'Delete'],
	['빈 본문', { text: '' }, 'Delete'],
	['CW', { cw: 'private cw' }, 'Delete'],
	['답글', { replyId: 'reply' }, 'Delete'],
	['설문', { hasPoll: true }, 'Delete'],
	['첨부', { fileIds: ['private-file'] }, 'Delete'],
	['본문 없는 리노트', {}, 'Undo'],
])('원본 %s 분류로 고정 AP를 먼저 만들고 복구 본문은 복사하지 않는다', async (_kind, change, expected) => {
	const f = fixture();
	await remove(f, { text: null, cw: null, replyId: null, renoteId: 'original', renoteUserId: 'remote', hasPoll: false, fileIds: [], ...change });

	const snapshot = f.receipts[0].snapshot;
	expect(JSON.parse(snapshot.delivery.activity.content).type).toBe(expected);
	expect(snapshot.note.hasRenote).toBe(true);
	expect(snapshot.note.hasFile).toBe('fileIds' in change);
	expect(snapshot.note).not.toHaveProperty('text');
	expect(snapshot.note).not.toHaveProperty('cw');
	expect(snapshot.delivery).not.toHaveProperty('direct');
	expect(snapshot.delivery.directTargets.length).toBeGreaterThan(0);
});

test.each(['all', 'delivery'] as const)('늦은 relay 서명 CAS는 %s 종료를 먼저 확인하고 제거된 payload를 복원하지 않는다', async state => {
	const f = fixture();
	await remove(f);
	f.renderer.attachLdSignature.mockImplementationOnce(async (activity: any) => {
		f.receipts[0].snapshot = state === 'all' ? { version: 2, state: 'settled' } : { ...f.receipts[0].snapshot, version: 3, state: 'delivery_settled', delivery: null };
		f.receipts[0].completedAt = state === 'all' ? new Date() : null;
		f.receipts[0].effects.activityPub = { outcome: 'permanentFailed', summary: { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 1 } };
		return { ...activity, signature: { signatureValue: 'late' } };
	});

	expect(await f.service.prepareRelaySignedPayload('note', 'alice')).toBeNull();
	const settled = structuredClone(f.receipts[0]);
	expect(await f.service.prepareRelaySignedPayload('note', 'alice')).toBeNull();

	expect(f.receiptRepository.update).not.toHaveBeenCalled();
	expect(f.renderer.attachLdSignature).toHaveBeenCalledTimes(1);
	expect(f.receipts[0]).toEqual(settled);
});

test('서명 준비의 미지원 미완료 형식은 정상 종료와 구별하고 입력을 보존한다', async () => {
	const f = fixture();
	await remove(f);
	f.receipts[0].snapshot.version = 999;
	const before = structuredClone(f.receipts[0]);

	await expect(f.service.prepareRelaySignedPayload('note', 'alice')).rejects.toThrow('unsupported');

	expect(f.renderer.attachLdSignature).not.toHaveBeenCalled();
	expect(f.receipts[0]).toEqual(before);
});
