/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteUpdateService } from '@/core/NoteUpdateService.js';
import { MiNote } from '@/models/Note.js';
import { MiPoll } from '@/models/Poll.js';

const author = { id: 'author', host: null };

function serviceFixture(oldChoices: string[] = ['one', 'two']) {
	const note = new MiNote({
		id: 'note', userId: 'author', visibility: 'public', text: 'keep this', cw: 'keep cw',
		fileIds: [], visibleUserIds: [], mentionedRemoteUsers: '[]', tags: [], emojis: [],
		channelId: null, hasPoll: true, hasEvent: false,
	});
	const oldPoll = { noteId: note.id, choices: oldChoices, multiple: false, votes: oldChoices.map(() => 0), expiresAt: null };
	const voteRepository = { delete: vi.fn().mockResolvedValue({ affected: 1 }) };
	const manager = {
		update: vi.fn(),
		findOneBy: vi.fn().mockResolvedValue(oldPoll),
		withRepository: vi.fn().mockReturnValue(voteRepository),
		delete: vi.fn(),
		insert: vi.fn(),
	};
	const notesRepository = { findOneBy: vi.fn().mockResolvedValue(note) };
	const pollVotesRepository = { delete: vi.fn() };
	const service = new NoteUpdateService(
		{
			getRepository: vi.fn().mockReturnValue({ findOneBy: vi.fn().mockResolvedValue(oldPoll) }),
			transaction: vi.fn(cb => cb(manager)),
		} as any,
		{} as any, notesRepository as any, {} as any,
		{} as any, {} as any, {} as any, {} as any, {} as any,
		{} as any, {} as any, { recordHistory: vi.fn() } as any, {} as any, {} as any,
		{} as any, {} as any, {} as any, pollVotesRepository as any,
	);
	return { service, note, manager, voteRepository, pollVotesRepository };
}

describe('NoteUpdateService poll vote cleanup', () => {
	test('clears votes when the choices change', async () => {
		const f = serviceFixture();
		await (f.service as any).updateNote(author, f.note, {
			text: 'keep',
			poll: { choices: ['three', 'four'], multiple: false, expiresAt: null },
		}, [], []);
		expect(f.manager.withRepository).toHaveBeenCalledWith(f.pollVotesRepository);
		expect(f.voteRepository.delete).toHaveBeenCalledWith({ noteId: f.note.id });
		expect(f.manager.delete).toHaveBeenCalledWith(MiPoll, { noteId: f.note.id });
	});

	test('clears votes when comma placement changes choice boundaries', async () => {
		const f = serviceFixture(['a,b', 'c']);
		await (f.service as any).updateNote(author, f.note, {
			text: 'keep',
			poll: { choices: ['a', 'b,c'], multiple: false, expiresAt: null },
		}, [], []);
		expect(f.voteRepository.delete).toHaveBeenCalledWith({ noteId: f.note.id });
		expect(f.manager.delete).toHaveBeenCalledWith(MiPoll, { noteId: f.note.id });
	});

	test('clears votes when the poll is removed', async () => {
		const f = serviceFixture();
		await (f.service as any).updateNote(author, f.note, { text: 'keep', poll: null }, [], []);
		expect(f.manager.withRepository).toHaveBeenCalledWith(f.pollVotesRepository);
		expect(f.voteRepository.delete).toHaveBeenCalledWith({ noteId: f.note.id });
		expect(f.manager.delete).toHaveBeenCalledWith(MiPoll, { noteId: f.note.id });
	});

	test('keeps votes when the choices are unchanged', async () => {
		const f = serviceFixture();
		await (f.service as any).updateNote(author, f.note, {
			text: 'keep',
			poll: { choices: ['one', 'two'], multiple: false, expiresAt: null },
		}, [], []);
		expect(f.manager.withRepository).not.toHaveBeenCalled();
		expect(f.voteRepository.delete).not.toHaveBeenCalled();
	});

	test('clears votes when only the multiple flag changes', async () => {
		const f = serviceFixture();
		await (f.service as any).updateNote(author, f.note, {
			text: 'keep',
			poll: { choices: ['one', 'two'], multiple: true, expiresAt: null },
		}, [], []);
		expect(f.voteRepository.delete).toHaveBeenCalledWith({ noteId: f.note.id });
		expect(f.manager.insert).toHaveBeenCalledWith(MiPoll, expect.objectContaining({ multiple: true, votes: [0, 0] }));
	});

	test('keeps votes when only the expiry changes', async () => {
		const f = serviceFixture();
		await (f.service as any).updateNote(author, f.note, {
			text: 'keep',
			poll: { choices: ['one', 'two'], multiple: false, expiresAt: new Date(Date.now() + 60_000) },
		}, [], []);
		expect(f.voteRepository.delete).not.toHaveBeenCalled();
	});

	test('deletes votes through the transaction before replacing the poll', async () => {
		const f = serviceFixture();
		await (f.service as any).updateNote(author, f.note, {
			text: 'keep',
			poll: { choices: ['three', 'four'], multiple: false, expiresAt: null },
		}, [], []);
		expect(f.pollVotesRepository.delete).not.toHaveBeenCalled();
		const voteDeleteOrder = f.voteRepository.delete.mock.invocationCallOrder[0];
		const pollDeleteOrder = f.manager.delete.mock.invocationCallOrder[0];
		const pollInsertOrder = f.manager.insert.mock.invocationCallOrder[0];
		expect(voteDeleteOrder).toBeLessThan(pollDeleteOrder);
		expect(pollDeleteOrder).toBeLessThan(pollInsertOrder);
	});
});
