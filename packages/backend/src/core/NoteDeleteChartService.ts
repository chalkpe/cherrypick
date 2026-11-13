/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiNoteDeleteReceipt, isSettledNoteDeleteReceipt, isDeliverySettledNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import type { RecoverableNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import NotesChart from '@/core/chart/charts/notes.js';
import PerUserNotesChart from '@/core/chart/charts/per-user-notes.js';
import InstanceChart from '@/core/chart/charts/instance.js';

export class UnsupportedDeletionChartReceiptsError extends Error {
	constructor(public readonly items: readonly { noteId: string; userId: string }[]) {
		super('Unsupported deletion chart receipt');
	}
}

@Injectable()
export class NoteDeleteChartService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		private notesChart: NotesChart,
		private perUserNotesChart: PerUserNotesChart,
		private instanceChart: InstanceChart,
	) {}

	// 실행기는 작은 묶음으로 호출한다. 같은 chart/group은 한 count로 처리한다.
	// 소유자 경계를 유지하며 영수증 없음과 DB 오류는 호출자에게 전파한다.
	public async applyBatch(items: readonly { noteId: string; userId: string }[]): Promise<void> {
		if (items.length > 32) throw new Error('Deletion chart batch exceeds 32 receipts');
		if (items.length === 0) return;
		const unsupported: { noteId: string; userId: string }[] = [];
		const ordered = [...items].sort((a, b) => a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
		await this.db.transaction(async manager => {
			const repository = manager.getRepository(MiNoteDeleteReceipt);
			const pending: RecoverableNoteDeleteReceipt[] = [];
			const seen = new Map<string, string>();
			for (const item of ordered) {
				if (seen.has(item.noteId)) {
					if (seen.get(item.noteId) !== item.userId) throw new Error('Conflicting deletion receipt owner');
					continue;
				}
				seen.set(item.noteId, item.userId);
				const receipt = await repository.findOneOrFail({ where: item, lock: { mode: 'pessimistic_write' } });
				if (isSettledNoteDeleteReceipt(receipt) || receipt.effects.charts) continue;
				if (receipt.snapshot.version !== 1 && (receipt.snapshot.version !== 3 || !isDeliverySettledNoteDeleteReceipt(receipt))) { unsupported.push(item); continue; }
				const targets = receipt.snapshot.charts;
				if (targets?.version !== 1 || typeof targets.notes !== 'boolean'
					|| (targets.perUser !== null && (typeof targets.perUser !== 'string' || !targets.perUser.trim()))
					|| (targets.instance !== null && (typeof targets.instance !== 'string' || !targets.instance.trim()))
					|| receipt.effects.notesChart || receipt.effects.perUserNotesChart || receipt.effects.instanceChart) {
					unsupported.push(item);
					continue;
				}
				pending.push(receipt as RecoverableNoteDeleteReceipt);
			}

			const groups = new Map<string, { chart: NotesChart | PerUserNotesChart | InstanceChart; group: string | null; receipts: RecoverableNoteDeleteReceipt[] }>();
			const add = (chart: NotesChart | PerUserNotesChart | InstanceChart, group: string | null, receipt: RecoverableNoteDeleteReceipt) => {
				const key = chart.deletionLockKey(group);
				const entry = groups.get(key) ?? { chart, group, receipts: [] };
				entry.receipts.push(receipt);
				groups.set(key, entry);
			};
			for (const receipt of pending) {
				const targets = receipt.snapshot.charts;
				if (targets.notes) add(this.notesChart, null, receipt);
				if (targets.perUser !== null) add(this.perUserNotesChart, targets.perUser, receipt);
				if (targets.instance !== null) add(this.instanceChart, targets.instance, receipt);
			}
			const sorted = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry);
			// 영수증을 먼저 잠근 뒤 정렬한 chart/group을 전부 잠근다.
			for (const entry of sorted) await entry.chart.lockDeletionGroup(manager, entry.group);
			const bucketAt = new Date();
			for (const entry of sorted) {
				const notes = entry.receipts.map(receipt => receipt.snapshot.note);
				if (entry.chart === this.notesChart) await this.notesChart.applyDeletionInTransaction(manager, notes, null, bucketAt);
				else if (entry.chart === this.perUserNotesChart) await this.perUserNotesChart.applyDeletionInTransaction(manager, notes, entry.group!, bucketAt);
				else await this.instanceChart.applyDeletionInTransaction(manager, notes, entry.group!, bucketAt);
			}
			for (const receipt of pending) {
				const at = bucketAt.toISOString();
				const targets = receipt.snapshot.charts;
				const effect = (applied: boolean, reason: 'settings' | 'local' = 'settings') => ({
					completedAt: at, bucketAt: at,
					outcome: applied ? 'applied' as const : 'excluded' as const,
					...(!applied ? { reason: receipt.quiet ? 'quiet' as const : reason } : {}),
				});
				await repository.update({ noteId: receipt.noteId, userId: receipt.userId }, { effects: {
					...receipt.effects,
					notesChart: effect(targets.notes),
					perUserNotesChart: effect(targets.perUser !== null),
					instanceChart: effect(targets.instance !== null, receipt.snapshot.actor.host === null ? 'local' : 'settings'),
					charts: { completedAt: at, bucketAt: at, outcome: 'applied' },
				} });
			}
		});
		// 검증 오류 행은 그대로 보존하고 정상 행의 트랜잭션만 확정한다.
		// DB 오류는 이 지점에 오지 않으며 분할 재호출하지 않는다.
		if (unsupported.length > 0) throw new UnsupportedDeletionChartReceiptsError(unsupported);
	}
}
