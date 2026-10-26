/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Test } from '@nestjs/testing';
import pg from 'pg';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
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

function makeBuilder() {
	return {
		where: vi.fn().mockReturnThis(),
		andWhere: vi.fn().mockReturnThis(),
		select: vi.fn().mockReturnThis(),
		limit: vi.fn().mockReturnThis(),
		getMany: vi.fn(),
	};
}

async function fixture(users: MiUser[], batches: MiNote[][]) {
	const builders: ReturnType<typeof makeBuilder>[] = [];
	const existing = new Set(batches.flat().map(n => n.id));
	const notesRepository = {
		createQueryBuilder: vi.fn(() => {
			const builder = makeBuilder();
			builder.getMany.mockResolvedValueOnce(batches[builders.length] ?? []);
			builders.push(builder);
			return builder;
		}),
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
	return {
		app,
		service: app.get(AutoDeleteNotesProcessorService),
		get builder() { return builders[0]; },
		builders,
		notesRepository,
		deleteNote,
		logger,
		gen,
		existing,
	};
}

// Runs the owner's candidate filters from the service against session-local tables, leaving the shared test database untouched
async function selectCandidates(owner: MiUser, notes: string[], favorites: { noteId: string; userId: string }[]) {
	const f = await fixture([owner], [[]]);
	try {
		await f.service.process({} as never);
	} finally {
		await f.app.close();
	}
	const filters = [...f.builder.where.mock.calls, ...f.builder.andWhere.mock.calls]
		.filter(([sql]) => !sql.includes(':deleteBeforeId')) as [string, Record<string, unknown>?][];
	const values: unknown[] = [];
	const params = Object.assign({}, ...filters.map(([, p]) => p ?? {}));
	// TypeORM quotes alias property paths and binds named parameters; mirror both for raw execution
	const where = filters.map(([sql]) => sql
		.replace(/\bnote\.(\w+)/g, 'note."$1"')
		.replace(/:(\w+)/g, (_, name: string) => `$${values.push(params[name])}`)).join(' AND ');

	const { db } = loadConfig();
	const client = new pg.Client({ host: db.host, port: db.port, database: db.db, user: db.user, password: db.pass });
	await client.connect();
	try {
		await client.query('CREATE TEMP TABLE note (id varchar PRIMARY KEY, "userId" varchar NOT NULL)');
		await client.query('CREATE TEMP TABLE note_favorite ("noteId" varchar NOT NULL, "userId" varchar NOT NULL)');
		for (const id of notes) await client.query('INSERT INTO note VALUES ($1, $2)', [id, owner.id]);
		for (const { noteId, userId } of favorites) await client.query('INSERT INTO note_favorite VALUES ($1, $2)', [noteId, userId]);
		const { rows } = await client.query<{ id: string }>(`SELECT note.id FROM note WHERE ${where} ORDER BY note.id`, values);
		return rows.map(row => row.id);
	} finally {
		await client.end();
	}
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
			expect(f.builder.andWhere).toHaveBeenCalledWith(
				'NOT EXISTS (SELECT 1 FROM note_favorite WHERE "noteId" = note.id AND "userId" = :userId)',
				{ userId: 'alice' },
			);
			expect(f.builder.limit).toHaveBeenCalledWith(1000);
		} finally {
			await f.app.close();
		}
	});

	test('scopes favorite protection to the note owner instead of any favoriter', async () => {
		const alice = user('alice', 30, true);
		const bob = user('bob', 30, true);
		const f = await fixture([alice, bob], [[], []]);
		try {
			expect(await f.service.process({} as never)).toEqual({ deletedCount: 0, processedUsers: 2 });
			expect(f.builders).toHaveLength(2);
			for (const [index, ownerId] of ['alice', 'bob'].entries()) {
				const favoriteGuard = f.builders[index].andWhere.mock.calls.find(([sql]) => String(sql).includes('note_favorite'));
				expect(favoriteGuard).toEqual([
					'NOT EXISTS (SELECT 1 FROM note_favorite WHERE "noteId" = note.id AND "userId" = :userId)',
					{ userId: ownerId },
				]);
			}
		} finally {
			await f.app.close();
		}
	});

	test('does not let another user\'s favorite exempt the owner\'s note from deletion', async () => {
		const alice = user('alice', 30, true);
		expect(await selectCandidates(alice, ['favorited-by-mallory'], [{ noteId: 'favorited-by-mallory', userId: 'mallory' }]))
			.toEqual(['favorited-by-mallory']);
	});

	test('keeps notes favorited by the owner even when other users also favorited them', async () => {
		const alice = user('alice', 30, true);
		const notes = ['by-owner', 'by-owner-and-mallory', 'by-mallory', 'plain'];
		const favorites = [
			{ noteId: 'by-owner', userId: 'alice' },
			{ noteId: 'by-owner-and-mallory', userId: 'mallory' },
			{ noteId: 'by-owner-and-mallory', userId: 'alice' },
			{ noteId: 'by-mallory', userId: 'mallory' },
		];
		expect(await selectCandidates(alice, notes, favorites)).toEqual(['by-mallory', 'plain']);
	});

	test('ignores every favorite when favorite protection is disabled', async () => {
		const alice = user('alice', 30, false);
		const notes = ['by-owner', 'by-mallory', 'plain'];
		const favorites = [{ noteId: 'by-owner', userId: 'alice' }, { noteId: 'by-mallory', userId: 'mallory' }];
		expect(await selectCandidates(alice, notes, favorites)).toEqual(['by-mallory', 'by-owner', 'plain']);
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
