/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteUpdateService } from '@/core/NoteUpdateService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { MiNote } from '@/models/Note.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import UpdateEndpoint from '@/server/api/endpoints/notes/update.js';

const author = { id: 'author', username: 'author', host: null, isBot: false };

function serviceFixture() {
	const note = new MiNote({
		id: 'note', userId: 'author', visibility: 'public', text: 'keep this', cw: 'keep cw',
		fileIds: [], visibleUserIds: [], mentionedRemoteUsers: '[]', tags: [], emojis: [],
		channelId: null, hasPoll: false, hasEvent: false,
	});
	const meta = {
		prohibitedWords: [] as string[],
		sensitiveWords: [] as string[],
	};
	const utilityService = new UtilityService({ host: 'local.test' } as any, meta as any);
	const stream = { publishNoteStream: vi.fn() };
	const search = { unindexNote: vi.fn(), indexNote: vi.fn() };
	const fanout = { remove: vi.fn().mockResolvedValue(0) };
	const history = { recordHistory: vi.fn() };
	const service = new NoteUpdateService(
		{ transaction: vi.fn() } as any,
		{} as any, {} as any, {} as any,
		stream as any, {} as any, {} as any, {} as any, {} as any,
		search as any, {} as any, history as any, fanout as any, {} as any,
		{} as any, meta as any, utilityService, { delete: vi.fn() } as any,
	);
	return { service, note, meta };
}

describe('NoteUpdateService content policy', () => {
	test('rejects prohibited words in edited content', async () => {
		const f = serviceFixture();
		f.meta.prohibitedWords = ['badword'];
		const updateNote = vi.spyOn(f.service as any, 'updateNote');
		await expect(f.service.update(author, { text: 'a badword here', cw: null }, f.note, true))
			.rejects.toMatchObject({ id: '689ee33f-f97c-479a-ac49-1b9f8140af99' });
		expect(updateNote).not.toHaveBeenCalled();
	});

	test('rejects prohibited words in edited poll choices', async () => {
		const f = serviceFixture();
		f.meta.prohibitedWords = ['badword'];
		await expect(f.service.update(author, {
			text: 'clean',
			cw: null,
			poll: { choices: ['badword', 'other'], multiple: false, expiresAt: null },
		}, f.note, true)).rejects.toMatchObject({ id: '689ee33f-f97c-479a-ac49-1b9f8140af99' });
	});

	test('downgrades public notes containing sensitive words to home', async () => {
		const f = serviceFixture();
		f.meta.sensitiveWords = ['sensitive'];
		const updatedNote = new MiNote({ ...f.note, text: 'has sensitive content', visibility: 'home' });
		const updateNote = vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(updatedNote);
		const result = await f.service.update(author, { text: 'has sensitive content', cw: null }, f.note, true);
		f.service.dispose();
		expect(updateNote).toHaveBeenCalledWith(author, f.note, expect.objectContaining({ visibility: 'home' }), expect.anything(), expect.anything());
		expect(result?.visibility).toBe('home');
	});

	test('keeps the visibility of notes without sensitive words', async () => {
		const f = serviceFixture();
		f.meta.sensitiveWords = ['sensitive'];
		const updatedNote = new MiNote({ ...f.note, text: 'clean content' });
		const updateNote = vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(updatedNote);
		await f.service.update(author, { text: 'clean content', cw: null }, f.note, true);
		f.service.dispose();
		expect(updateNote).toHaveBeenCalledWith(author, f.note, expect.not.objectContaining({ visibility: 'home' }), expect.anything(), expect.anything());
	});

	test.each([
		['path', 'see https://example.com/%62adword'],
		['host', 'see https://bad%77ord.example/'],
	])('rejects prohibited words hidden in a percent-encoded URL %s', async (_, text) => {
		const f = serviceFixture();
		f.meta.prohibitedWords = ['badword'];
		const updateNote = vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(null);
		await expect(f.service.update(author, { text, cw: null }, f.note, true))
			.rejects.toMatchObject({ id: '689ee33f-f97c-479a-ac49-1b9f8140af99' });
		expect(updateNote).not.toHaveBeenCalled();
	});

	test('rejects prohibited words matched by a regular expression', async () => {
		const f = serviceFixture();
		f.meta.prohibitedWords = ['/bad\\d+word/i'];
		const updateNote = vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(null);
		await expect(f.service.update(author, { text: 'a BAD42WORD here', cw: null }, f.note, true))
			.rejects.toMatchObject({ id: '689ee33f-f97c-479a-ac49-1b9f8140af99' });
		expect(updateNote).not.toHaveBeenCalled();
	});

	test('downgrades public notes whose sensitive words are hidden in a percent-encoded URL', async () => {
		const f = serviceFixture();
		f.meta.sensitiveWords = ['sensitive'];
		const updateNote = vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(null);
		await f.service.update(author, { text: 'see https://example.com/%73ensitive', cw: null }, f.note, true);
		expect(updateNote).toHaveBeenCalledWith(author, f.note, expect.objectContaining({ visibility: 'home' }), expect.anything(), expect.anything());
	});

	test('does not downgrade channel notes containing sensitive words', async () => {
		const f = serviceFixture();
		f.meta.sensitiveWords = ['sensitive'];
		f.note.channelId = 'channel';
		const updateNote = vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(null);
		await f.service.update(author, { text: 'has sensitive content', cw: null }, f.note, true);
		expect(updateNote).toHaveBeenCalledWith(author, f.note, expect.not.objectContaining({ visibility: 'home' }), expect.anything(), expect.anything());
	});
});

describe('notes/update content policy errors', () => {
	function endpointFixture() {
		const note = { id: 'note', userId: 'author', visibility: 'public', channelId: null };
		const service = {
			updateVisibility: vi.fn(),
			update: vi.fn().mockRejectedValue(new IdentifiableError('689ee33f-f97c-479a-ac49-1b9f8140af99', 'Note contains prohibited words')),
		};
		const endpoint = new UpdateEndpoint(
			{} as any,
			{ getNote: vi.fn().mockResolvedValue(note) } as any,
			{
				isModerator: vi.fn().mockResolvedValue(false),
				isAdministrator: vi.fn().mockResolvedValue(false),
				getUserPolicies: vi.fn().mockResolvedValue({ canEditNote: true }),
			} as any,
			{ pack: vi.fn().mockResolvedValue(note) } as any,
			service as any,
		);
		return { endpoint, service };
	}

	test('maps prohibited word failures from the editor service to the public error code', async () => {
		const { endpoint } = endpointFixture();
		await expect(endpoint.exec({ noteId: 'note', text: 'badword', cw: null }, { id: 'author' } as any, {} as any, null))
			.rejects.toMatchObject({ code: 'CONTAINS_PROHIBITED_WORDS' });
	});
});
