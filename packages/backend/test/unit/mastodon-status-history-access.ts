/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonConverters } from '@/server/api/mastodon/MastodonConverters.js';

function fixture(access: 'ok' | 'restrictedByUser' | 'restrictedByServer' | 'invisible') {
	const note = { id: 'note', userId: 'author', userHost: 'remote.example', renoteId: null, mentionedRemoteUsers: '[]' };
	const noteHistoryRepository = { find: vi.fn().mockResolvedValue([]) };
	const mastodonDataService = {
		getNote: vi.fn().mockResolvedValue(note),
		isContentHidden: vi.fn().mockResolvedValue(false),
	};
	const noteUpdateService = { checkRevisionsAccess: vi.fn().mockResolvedValue(access) };
	const converters = new MastodonConverters(
		{ url: 'https://example.test' } as any,
		noteHistoryRepository as any,
		{} as any,
		{ getUser: vi.fn().mockResolvedValue({ id: 'author', host: 'remote.example' }) } as any,
		{} as any, {} as any, {} as any,
		mastodonDataService as any,
		{} as any, {} as any, {} as any,
		noteUpdateService as any,
	);
	vi.spyOn(converters, 'convertAccount').mockResolvedValue({ id: 'author' } as any);
	return { converters, noteHistoryRepository, noteUpdateService, note };
}

describe('Mastodon status history', () => {
	test.each(['restrictedByUser', 'restrictedByServer', 'invisible'] as const)('returns no history when access is %s', async access => {
		const { converters, noteHistoryRepository, noteUpdateService, note } = fixture(access);
		await expect(converters.getEdits('note', null)).resolves.toEqual([]);
		expect(noteUpdateService.checkRevisionsAccess).toHaveBeenCalledWith(note, null);
		expect(noteHistoryRepository.find).not.toHaveBeenCalled();
	});

	test('reads the history when access is granted', async () => {
		const { converters, noteHistoryRepository, noteUpdateService, note } = fixture('ok');
		await converters.getEdits('note', { id: 'me' } as any);
		expect(noteUpdateService.checkRevisionsAccess).toHaveBeenCalledWith(note, 'me');
		expect(noteHistoryRepository.find).toHaveBeenCalledOnce();
	});
});
