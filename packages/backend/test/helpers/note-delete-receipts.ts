/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import type { GlobalEventService } from '../../src/core/GlobalEventService.js';
import type { SearchService } from '../../src/core/SearchService.js';
import { NoteDeleteLocalRunnerService } from '../../src/core/NoteDeleteLocalRunnerService.js';
import { NoteDeleteChartService } from '../../src/core/NoteDeleteChartService.js';
import { MiNoteDeleteReceipt, isSettledNoteDeleteReceipt } from '../../src/models/NoteDeleteReceipt.js';
import { NoteDeleteDeliveryService } from '../../src/core/NoteDeleteDeliveryService.js';
import { MiNoteDeleteDelivery } from '../../src/models/NoteDeleteDelivery.js';
import { MiInstance } from '../../src/models/Instance.js';
import { MiUser } from '../../src/models/User.js';
import { MiModerationLog } from '../../src/models/ModerationLog.js';
import type { NoteDeleteSnapshot } from '../../src/models/NoteDeleteReceipt.js';

// SQL/격리/Redis 증거가 아닌 실패 주입용 저장소다.
export function receiptStore(receipts: MiNoteDeleteReceipt[] = []) {
	const deliveries: MiNoteDeleteDelivery[] = receipts.flatMap(row => row.snapshot.version === 1 ? row.snapshot.delivery.directTargets.map(target => ({
		receiptNoteId: row.noteId, ownerUserId: row.userId, channel: 'direct' as const, ...target,
		relayId: null, payloadRef: 'activity' as const, state: 'pending' as const, generation: 0, attempts: 0,
		claimVersion: 0, claimToken: null, claimUntil: null, nextAttemptAt: new Date(0), lastErrorCode: null, settledAt: null,
	})) : []);
	const state = { failMark: false, failEffectMark: null as string | null, failCompletion: false, failDeliverySettlement: false, moderatorPresent: true, decrements: 0, logs: 0 };
	const query = vi.fn(async (sql: string, [token, noteId, userId, excluded = []]: [string, string | null, string | null, string[]?] = ['', null, null]) => {
		if (sql.trimStart().startsWith('SELECT')) return receipts.filter(r => !isSettledNoteDeleteReceipt(r) && +r.nextAttemptAt <= Date.now() && (!r.claimUntil || +r.claimUntil <= Date.now())).slice(0, 10).map(r => ({ noteId: r.noteId, userId: r.userId }));
		const receipt = receipts.find(r => !excluded.includes(r.noteId) && !isSettledNoteDeleteReceipt(r) && +r.nextAttemptAt <= Date.now() && (!r.claimUntil || +r.claimUntil <= Date.now()) && (!noteId || (r.noteId === noteId && r.userId === userId)));
		if (!receipt) return [[], 0];
		Object.assign(receipt, { claimToken: token, claimVersion: receipt.claimVersion + 1, claimUntil: new Date(Date.now() + 60_000), attempts: receipt.attempts + 1 });
		return [[structuredClone(receipt)], 1];
	});
	const decrement = vi.fn(async () => { state.decrements++; });
	const log = vi.fn(async () => { state.logs++; });
	const repository = {
		findOne: async ({ where }: any) => structuredClone(receipts.find(r => r.noteId === where.noteId && r.userId === where.userId) ?? null),
		findOneOrFail: async ({ where }: any) => {
			const row = receipts.find(r => r.noteId === where.noteId && r.userId === where.userId);
			if (!row) throw new Error('missing receipt');
			return structuredClone(row);
		},
		createQueryBuilder: () => {
			let criteria: MiNoteDeleteReceipt;
			const builder: any = {
				where: (_sql: string, params: MiNoteDeleteReceipt) => { criteria = params; return builder; },
				andWhere: () => builder, setLock: () => builder,
				getOne: async () => {
					const r = receipts.find(r => !isSettledNoteDeleteReceipt(r) && r.noteId === criteria.noteId && r.userId === criteria.userId && r.claimToken === criteria.claimToken && r.claimVersion === criteria.claimVersion && r.claimUntil && +r.claimUntil > Date.now());
					return r ? structuredClone(r) : null;
				},
			};
			return builder;
		},
		update: vi.fn(async ({ noteId }: { noteId: string }, data: Partial<MiNoteDeleteReceipt>) => {
			const previous = receipts.find(r => r.noteId === noteId)!;
			if (state.failDeliverySettlement && data.snapshot?.version === 3) throw new Error('delivery settlement failed');
			if (state.failCompletion && Object.hasOwn(data, 'completedAt')) throw new Error('completion failed');
			if (state.failMark && data.effects) throw new Error('mark failed');
			if (state.failEffectMark && data.effects?.[state.failEffectMark as keyof typeof data.effects] && !previous.effects[state.failEffectMark as keyof typeof previous.effects]) throw new Error('effect mark failed');
			Object.assign(receipts.find(r => r.noteId === noteId)!, structuredClone(data));
		}),
	};
	const manager: any = { getRepository: (target: unknown) => {
		if (target === MiNoteDeleteReceipt) return repository;
		if (target === MiNoteDeleteDelivery) return {
			find: async ({ where }: any) => structuredClone(deliveries.filter(row => row.receiptNoteId === where.receiptNoteId)),
			update: async ({ receiptNoteId, ownerUserId }: any, values: Partial<MiNoteDeleteDelivery>) => {
				for (const row of deliveries.filter(row => row.receiptNoteId === receiptNoteId && row.ownerUserId === ownerUserId && !['pending', 'running'].includes(row.state))) Object.assign(row, structuredClone(values));
				return { affected: deliveries.length };
			},
		};
		if (target === MiInstance) return {
			createQueryBuilder: () => {
				const builder: any = { insert: () => builder, values: () => builder, orIgnore: () => builder, execute: async () => {} };
				return builder;
			}, decrement,
		};
		if (target === MiUser) return { findOne: async () => state.moderatorPresent ? { id: 'mod' } : null };
		if (target === MiModerationLog) return { insert: log };
		throw new Error('unexpected repository');
	} };
	const db: any = { query, transaction: async (work: (manager: any) => Promise<unknown>) => {
		const before = structuredClone(receipts);
		const beforeDeliveries = structuredClone(deliveries);
		const counters = { ...state };
		try { return await work(manager); } catch (error) {
			receipts.splice(0, receipts.length, ...before);
			deliveries.splice(0, deliveries.length, ...beforeDeliveries);
			Object.assign(state, counters);
			throw error;
		}
	} };
	const events = vi.fn();
	const search = vi.fn();
	const adapter = (name: string) => ({
		deletionLockKey: (group: string | null) => `${name}:${group}`,
		lockDeletionGroup: vi.fn(), applyDeletionInTransaction: vi.fn(),
	});
	const charts = { notes: adapter('notes'), perUser: adapter('perUser'), instance: adapter('instance') };
	const chartService = new NoteDeleteChartService(db, charts.notes as any, charts.perUser as any, charts.instance as any);
	const applyBatch = vi.spyOn(chartService, 'applyBatch');
	const delivery = new NoteDeleteDeliveryService(db, {} as any, {} as any, {} as any);
	const createRunner = (services?: { events?: GlobalEventService; search?: SearchService }) => new NoteDeleteLocalRunnerService(db, services?.events ?? { publishNoteStreamForDeletion: (_note: unknown, deletedAt: Date) => events(_note, 'deleted', { deletedAt }) } as any, services?.search ?? { unindexNote: search } as any, { gen: () => 'new-id' } as any, { toPuny: (host: string) => host } as any, chartService, delivery as any);
	return { deliveries, delivery, charts, chartService, applyBatch, receipts, state, db, query, repository, decrement, log, events, search, createRunner };
}

export function receipt(plan: Partial<NonNullable<NoteDeleteSnapshot['localPlan']>> = {}): MiNoteDeleteReceipt & { snapshot: NoteDeleteSnapshot } {
	return {
		noteId: 'note', userId: 'author', deletedAt: new Date('2026-01-01'), quiet: false,
		snapshot: {
			version: 1, actor: { id: 'author', host: null },
			deleter: { id: 'mod' }, author: { username: 'author', host: null },
			note: { id: 'note', userId: 'author', visibility: 'public', userHost: null, hasReply: false, hasRenote: false, hasFile: false },
			stream: { visibleUserIds: [], mentions: [], replyUserId: null },
			auditNote: plan.moderationLog ? {
			id: 'note', userId: 'author', userHost: null, uri: null, text: 'audit', cw: 'audit cw',
			visibility: 'public', localOnly: false, replyId: null, renoteId: null, replyUserId: null,
			replyUserHost: null, renoteUserId: null, renoteUserHost: null, fileIds: [], attachedFileTypes: [],
			hasPoll: false, channelId: null, visibleUserIds: [], mentions: [], mentionedRemoteUsers: '[]',
			tags: [], emojis: [], deliveryTargets: null, updatedAt: null,
			} : null,
			charts: { version: 1, notes: plan.notesChart ?? true, perUser: (plan.perUserNotesChart ?? true) ? 'author' : null, instance: null },
			delivery: { version: 2, reason: 'federated', followers: [], directTargets: plan.activityPub === false ? [] : [{ targetKey: 'target', endpoint: 'https://remote.test/private-inbox', isSharedInbox: false }], relays: [], activity: plan.activityPub === false ? null : { content: 'fixed private payload', digest: 'fixed digest' }, relayUnsigned: null, relaySigned: null },
			localPlan: { noteStream: true, search: true, moderationLog: false, instanceStats: false, notesChart: true, perUserNotesChart: true, instanceChart: false, activityPub: true, ...plan },
		}, effects: {}, attempts: 0, nextAttemptAt: new Date(0), claimUntil: null, claimToken: null, claimVersion: 0, lastErrorCode: null, completedAt: null,
	};
}
