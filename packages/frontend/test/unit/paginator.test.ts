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

test.each([
	{ useShallowRef: false, queued: false },
	{ useShallowRef: true, queued: false },
	{ useShallowRef: false, queued: true },
	{ useShallowRef: true, queued: true },
])('preserves delayed notes while fetching older notes ($useShallowRef, $queued)', async ({ useShallowRef, queued }) => {
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['100', '090', '080']));
	const paginator = new Paginator('notes/timeline', { insertByIdOrder: true, useShallowRef });
	await paginator.init();

	let respond!: (value: Misskey.entities.Note[]) => void;
	vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
	const loadingOlder = paginator.fetchOlder();
	for (const note of notes(['075', '065', '040'])) {
		if (queued) paginator.enqueue(note);
		else paginator.prepend(note);
	}
	if (queued) paginator.releaseQueue();

	// Do not advance the pagination cursor until the response fills the older range.
	expect(paginator.items.value.map(note => note.id)).toEqual(['100', '090', '080']);
	respond(notes(['070', '065', '060', '050']));
	await loadingOlder;

	// Keep 075, deduplicate 065, and leave 040 for the next page.
	expect(paginator.items.value.map(note => note.id)).toEqual(['100', '090', '080', '075', '070', '065', '060', '050']);
	expect(paginator.queuedAheadItemsCount.value).toBe(0);
});

test('keeps delayed notes when an older page is empty', async () => {
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['100', '090', '080']));
	const paginator = new Paginator('notes/timeline', { insertByIdOrder: true, useShallowRef: true });
	await paginator.init();

	let respond!: (value: Misskey.entities.Note[]) => void;
	vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
	const loadingOlder = paginator.fetchOlder();
	paginator.prepend(notes(['075'])[0]);
	respond([]);
	await loadingOlder;

	expect(paginator.items.value.map(note => note.id)).toEqual(['100', '090', '080', '075']);
	expect(paginator.canFetchOlder.value).toBe(false);
});

test('preserves delayed notes across a failed older-page request and retry', async () => {
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['100', '090', '080']));
	const paginator = new Paginator('notes/timeline', { insertByIdOrder: true, useShallowRef: true });
	await paginator.init();

	let reject!: (reason: Error) => void;
	vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
	const loadingOlder = paginator.fetchOlder();
	paginator.prepend(notes(['075'])[0]);
	reject(new Error('Network error'));
	await loadingOlder;

	expect(paginator.items.value.map(note => note.id)).toEqual(['100', '090', '080']);
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['070', '060', '050']));
	await paginator.fetchOlder();

	expect(paginator.items.value.map(note => note.id)).toEqual(['100', '090', '080', '075', '070', '060', '050']);
});

test('does not restore a delayed note deleted while an older page is loading', async () => {
	vi.mocked(misskeyApi).mockResolvedValueOnce(notes(['100', '090', '080']));
	const paginator = new Paginator('notes/timeline', { insertByIdOrder: true, useShallowRef: true });
	await paginator.init();

	let respond!: (value: Misskey.entities.Note[]) => void;
	vi.mocked(misskeyApi).mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
	const loadingOlder = paginator.fetchOlder();
	for (const note of notes(['075', '065'])) paginator.prepend(note);
	paginator.removeItem('075');
	respond(notes(['070', '060', '050']));
	await loadingOlder;

	expect(paginator.items.value.map(note => note.id)).toEqual(['100', '090', '080', '070', '065', '060', '050']);
});
