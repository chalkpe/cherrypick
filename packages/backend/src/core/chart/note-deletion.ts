/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/Note.js';
import type { NoteDeleteChartClassification } from '@/models/NoteDeleteReceipt.js';

export type DeletedChartNote = NoteDeleteChartClassification | Pick<MiNote, 'userHost' | 'replyId' | 'renoteId' | 'fileIds'>;

export function deletionDiff(notes: readonly DeletedChartNote[], prefix: string | ((note: DeletedChartNote) => string)): Record<string, number> {
	const diff: Record<string, number> = {};
	for (const note of notes) {
		const p = typeof prefix === 'function' ? prefix(note) : prefix;
		const hasReply = 'hasReply' in note ? note.hasReply : note.replyId != null;
		const hasRenote = 'hasRenote' in note ? note.hasRenote : note.renoteId != null;
		const hasFile = 'hasFile' in note ? note.hasFile : note.fileIds.length > 0;
		const values = {
			dec: 1,
			'diffs.normal': !hasReply && !hasRenote ? -1 : 0,
			'diffs.reply': hasReply ? -1 : 0,
			'diffs.renote': hasRenote ? -1 : 0,
			'diffs.withFile': hasFile ? -1 : 0,
		};
		for (const [key, value] of Object.entries(values)) diff[p + key] = (diff[p + key] ?? 0) + value;
	}
	return diff;
}
