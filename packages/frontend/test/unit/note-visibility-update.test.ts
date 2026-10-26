/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { useNoteCapture } from '@/composables/use-note-capture.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	emit: vi.fn(),
	listeners: new Map<string, (event: unknown) => void>(),
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/events.js', () => ({ globalEvents: { emit: mocks.emit } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer' } }));
vi.mock('@/store.js', () => ({ store: { s: { realtimeMode: true } } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { pollingInterval: 3 } } }));
vi.mock('@@/js/interval.js', () => ({ createVisibilityAwareInterval: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: () => ({
	send: vi.fn(),
	on: (name: string, listener: (event: unknown) => void) => mocks.listeners.set(name, listener),
	off: (name: string) => mocks.listeners.delete(name),
}) }));

beforeEach(() => {
	mocks.api.mockReset();
	mocks.emit.mockReset();
	mocks.listeners.clear();
});
afterEach(cleanup);

function mountNote() {
	const note = {
		id: 'note', createdAt: new Date().toISOString(), text: 'previously visible', cw: 'cw',
		files: [{ id: 'file' }], fileIds: ['file'], poll: { choices: [] }, event: { title: 'event' },
		reactions: {}, reactionEmojis: {}, reactionCount: 0,
	} as unknown as Misskey.entities.Note;
	render(defineComponent({
		setup() {
			useNoteCapture({ note, parentNote: null });
			return () => h('div');
		},
	}));
	return note;
}

async function invalidate() {
	mocks.listeners.get('noteUpdated')!({ id: 'note', type: 'updated', body: { updatedAt: new Date().toISOString() } });
	await Promise.resolve();
	await Promise.resolve();
}

test('refetches the note after an update instead of trusting streamed content', async () => {
	const note = mountNote();
	mocks.api.mockResolvedValue({ ...note, text: 'edited', visibility: 'followers' });
	await invalidate();
	expect(mocks.api).toHaveBeenCalledWith('notes/show', { noteId: 'note' });
	expect(note.text).toBe('edited');
	expect(note.visibility).toBe('followers');
});

test('clears content and removes the displayed note when access was revoked', async () => {
	const note = mountNote();
	mocks.api.mockRejectedValue({ code: 'NO_SUCH_NOTE' });
	await invalidate();
	expect(note.text).toBeNull();
	expect(note.cw).toBeNull();
	expect(note.files).toEqual([]);
	expect(note.poll).toBeUndefined();
	expect(note.event).toBeUndefined();
	expect(mocks.emit).toHaveBeenCalledWith('noteDeleted', 'note');
});

test('an older refetch cannot restore content after a newer access denial', async () => {
	const note = mountNote();
	let resolveOld!: (value: unknown) => void;
	mocks.api.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
	await invalidate();
	mocks.api.mockRejectedValueOnce({ code: 'NO_SUCH_NOTE' });
	await invalidate();
	resolveOld({ text: 'stale content' });
	await Promise.resolve();
	expect(note.text).toBeNull();
});
