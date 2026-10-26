/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { MiNote, MiUser } from '@/models/_.js';
import { AutoDeleteNotesProcessorService } from '@/queue/processors/AutoDeleteNotesProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';

function user(id: string, days: number | null = 30, keepFavorites = true) {
	return new MiUser({ id, host: null, autoDeleteNotesAfterDays: days, autoDeleteKeepFavorites: keepFavorites });
}

function note(id: string, userId: string) {
	return new MiNote({
		id, userId, text: 'Old note', fileIds: ['attachment'], replyId: null, renoteId: null,
		localOnly: false, visibility: 'public', mentionedRemoteUsers: '[]',
	});
}

async function fixture(users: MiUser[], batches: MiNote[][]) {
	const builder = {
		where: vi.fn().mockReturnThis(),
		andWhere: vi.fn().mockReturnThis(),
		select: vi.fn().mockReturnThis(),
		limit: vi.fn().mockReturnThis(),
		getMany: vi.fn(),
	};
	for (const batch of batches) builder.getMany.mockResolvedValueOnce(batch);
	const existing = new Set(batches.flat().map(n => n.id));
	const notesRepository = {
		createQueryBuilder: () => builder,
		existsBy: vi.fn(async ({ id }: { id: string }) => existing.has(id)),
		delete: vi.fn(),
	};
	const deleteNote = vi.fn<NoteDeleteService['delete']>(async (_user, selectedNote) => {
		existing.delete(selectedNote.id);
	});
	const logger = { info: vi.fn(), error: vi.fn(), succ: vi.fn() };
	const gen = vi.fn().mockReturnValue('cutoff');
	const app = await Test.createTestingModule({
		providers: [
			AutoDeleteNotesProcessorService,
			{ provide: DI.usersRepository, useValue: { findBy: async () => users } },
			{ provide: DI.notesRepository, useValue: notesRepository },
			{ provide: IdService, useValue: { gen } },
			{ provide: NoteDeleteService, useValue: { delete: deleteNote } },
			{ provide: QueueLoggerService, useValue: { logger: { createSubLogger: () => logger } } },
		],
	}).compile();
	return { app, service: app.get(AutoDeleteNotesProcessorService), builder, notesRepository, deleteNote, logger, gen, existing };
}

describe('AutoDeleteNotesProcessorService', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('deletes full notes through the normal service with federation enabled', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 31));
		const alice = user('alice');
		const oldNote = note('old-note', alice.id);
		const f = await fixture([alice], [[oldNote]]);
		try {
			expect(await f.service.process({} as never)).toEqual({ deletedCount: 1, processedUsers: 1 });
			expect(f.deleteNote).toHaveBeenCalledExactlyOnceWith(alice, oldNote, false);
			expect(f.notesRepository.delete).not.toHaveBeenCalled();
			expect(f.builder.select).not.toHaveBeenCalled();
			expect(f.gen).toHaveBeenCalledWith(Date.UTC(2026, 0, 1));
			expect(f.builder.where).toHaveBeenCalledWith('note.userId = :userId', { userId: 'alice' });
			expect(f.builder.andWhere).toHaveBeenCalledWith('note.id < :deleteBeforeId', { deleteBeforeId: 'cutoff' });
			expect(f.builder.andWhere).toHaveBeenCalledWith('NOT EXISTS (SELECT 1 FROM note_favorite WHERE "noteId" = note.id)');
			expect(f.builder.limit).toHaveBeenCalledWith(1000);
		} finally {
			await f.app.close();
		}
	});

	test('continues after one deletion fails and counts only successful deletions across users', async () => {
		const alice = user('alice');
		const bob = user('bob', 7, false);
		const failed = note('failed', alice.id);
		const succeeding = note('succeeding', alice.id);
		const otherUser = note('other-user', bob.id);
		const f = await fixture([alice, bob], [[failed, succeeding], [otherUser]]);
		f.deleteNote.mockRejectedValueOnce(new Error('Deletion failed'));
		try {
			expect(await f.service.process({} as never)).toEqual({ deletedCount: 2, processedUsers: 2 });
			expect(f.deleteNote).toHaveBeenCalledTimes(3);
			expect(f.deleteNote).toHaveBeenNthCalledWith(2, alice, succeeding, false);
			expect(f.deleteNote).toHaveBeenNthCalledWith(3, bob, otherUser, false);
			expect(f.existing).toEqual(new Set(['failed']));
			expect(f.logger.error).toHaveBeenCalledWith(expect.stringContaining('failed'));
			expect(f.builder.andWhere.mock.calls.filter(([sql]) => sql.includes('note_favorite'))).toHaveLength(1);
		} finally {
			await f.app.close();
		}
	});

	test('does not replay deletion effects for a candidate that has already disappeared', async () => {
		const alice = user('alice');
		const deletedElsewhere = note('gone', alice.id);
		const remaining = note('remaining', alice.id);
		const f = await fixture([alice], [[deletedElsewhere, remaining]]);
		f.existing.delete(deletedElsewhere.id);
		try {
			expect(await f.service.process({} as never)).toEqual({ deletedCount: 1, processedUsers: 1 });
			expect(f.deleteNote).toHaveBeenCalledExactlyOnceWith(alice, remaining, false);
		} finally {
			await f.app.close();
		}
	});

	test('skips disabled or invalid settings and handles an empty eligible batch', async () => {
		const f = await fixture([user('disabled', null), user('zero', 0), user('negative', -1), user('empty')], [[]]);
		try {
			expect(await f.service.process({} as never)).toEqual({ deletedCount: 0, processedUsers: 1 });
			expect(f.builder.getMany).toHaveBeenCalledTimes(1);
			expect(f.deleteNote).not.toHaveBeenCalled();
		} finally {
			await f.app.close();
		}
	});
});
