/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import type * as Misskey from 'cherrypick-js';
import { Paginator } from '@/utility/paginator.js';
import { misskeyApi } from '@/utility/misskey-api.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));

function notes(ids: string[]): Misskey.entities.Note[] {
	return ids.map(id => ({ id, createdAt: '2026-11-01T00:00:00.000Z' }) as Misskey.entities.Note);
}

test.each([false, true])('preserves out-of-order streamed notes across reload (shallow: %s)', async (useShallowRef) => {
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['100', '090', '080']));
	const paginator = new Paginator('notes/timeline', { insertByIdOrder: true, useShallowRef });
	await paginator.init();

	let respond!: (value: Misskey.entities.Note[]) => void;
	vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
	const reloading = paginator.reload();
	for (const note of notes(['120', '119', '095', '070'])) paginator.prepend(note);
	respond(notes(['100', '090', '080']));
	await reloading;

	// 070 is outside the response's loaded range; 119 and 095 must survive.
	expect(paginator.items.value.map(note => note.id)).toEqual(['120', '119', '100', '095', '090', '080']);
});

test('merges queued notes released during reload without duplicates', async () => {
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['100', '090', '080']));
	const paginator = new Paginator('notes/timeline', { insertByIdOrder: true, useShallowRef: true });
	await paginator.init();

	let respond!: (value: Misskey.entities.Note[]) => void;
	vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
	const reloading = paginator.reload();
	paginator.prepend(notes(['120'])[0]);
	for (const note of notes(['119', '095', '070'])) paginator.enqueue(note);
	paginator.releaseQueue();
	respond(notes(['120', '119', '100', '090', '080']));
	await reloading;

	expect(paginator.items.value.map(note => note.id)).toEqual(['120', '119', '100', '095', '090', '080']);
	expect(paginator.queuedAheadItemsCount.value).toBe(0);
});
