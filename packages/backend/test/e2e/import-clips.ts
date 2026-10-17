/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { api, castAsError, origin, post, role, signup, startJobQueue, uploadFile } from '../utils.js';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'cherrypick-js';

type ExportedNoteRef = {
	id: string;
	uri: string | null;
};

describe('import-clips', () => {
	let queue: INestApplicationContext;
	let root: misskey.entities.SignupResponse;
	// alice: canImportClips が許可されている
	let alice: misskey.entities.SignupResponse;
	// bob: canImportClips が許可されていない
	let bob: misskey.entities.SignupResponse;
	// carol: canImportClips 許可 + clipLimit 1
	let carol: misskey.entities.SignupResponse;

	function localUri(note: { id: string }): string {
		return `${origin}/notes/${note.id}`;
	}

	// i/export-clips が出力する形式のクリップを組み立てる
	function exportedClip(name: string, notes: ExportedNoteRef[], description: string | null = null) {
		return {
			id: 'abcdefghij',
			name,
			description,
			lastClippedAt: new Date().toISOString(),
			clipNotes: notes.map((note, i) => ({
				id: `clipnote${i}`,
				createdAt: new Date().toISOString(),
				note: {
					id: note.id,
					text: 'exported',
					createdAt: new Date().toISOString(),
					fileIds: [],
					replyId: null,
					renoteId: null,
					cw: null,
					visibility: 'public',
					visibleUserIds: [],
					localOnly: false,
					reactionAcceptance: null,
					uri: note.uri,
					url: null,
					user: {
						id: 'user',
						name: null,
						username: 'someone',
						host: null,
						uri: null,
					},
				},
			})),
		};
	}

	async function uploadExport(user: misskey.entities.SignupResponse, data: unknown): Promise<misskey.entities.DriveFile> {
		const res = await uploadFile(user, {
			blob: new Blob([JSON.stringify(data)], { type: 'application/json' }),
			name: 'clips.json',
		});
		assert.strictEqual(res.status, 200);
		return res.body!;
	}

	async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 10000): Promise<T> {
		const start = Date.now();
		while (true) {
			const result = await fn();
			if (result != null) return result;
			if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
			await new Promise(r => setTimeout(r, 100));
		}
	}

	async function waitForClipCount(user: misskey.entities.SignupResponse, count: number): Promise<misskey.entities.Clip[]> {
		return await waitFor(async () => {
			const clips = (await api('clips/list', {}, user)).body;
			return clips.length === count ? clips : null;
		});
	}

	async function waitForClipNote(user: misskey.entities.SignupResponse, clipId: string, noteId: string): Promise<misskey.entities.Note[]> {
		return await waitFor(async () => {
			const notes = (await api('clips/notes', { clipId }, user)).body;
			return notes.some(note => note.id === noteId) ? notes : null;
		});
	}

	beforeAll(async () => {
		queue = await startJobQueue();
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		carol = await signup({ username: 'carol' });

		const importerRole = await role(root, {}, {
			canImportClips: { priority: 0, useDefault: false, value: true },
		});
		await api('admin/roles/assign', { userId: alice.id, roleId: importerRole.id }, root);

		const limitedImporterRole = await role(root, {}, {
			canImportClips: { priority: 0, useDefault: false, value: true },
			clipLimit: { priority: 0, useDefault: false, value: 1 },
		});
		await api('admin/roles/assign', { userId: carol.id, roleId: limitedImporterRole.id }, root);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await queue.close();
	});

	beforeEach(async () => {
		for (const user of [alice, carol]) {
			const clips = (await api('clips/list', {}, user)).body;
			for (const clip of clips) {
				const res = await api('clips/delete', { clipId: clip.id }, user);
				if (res.status !== 204) {
					throw new Error('Failed to delete clip');
				}
			}
		}
	});

	test('imports a clip and resolves local notes by their uri', async () => {
		const aliceNote = await post(alice, { text: 'mine' });
		const bobNote = await post(bob, { text: 'public' });

		const file = await uploadExport(alice, [
			exportedClip('imported', [
				{ id: aliceNote.id, uri: localUri(aliceNote) },
				{ id: bobNote.id, uri: localUri(bobNote) },
			], 'desc'),
		]);

		const res = await api('i/import-clips', { fileId: file.id }, alice);
		assert.strictEqual(res.status, 204);

		const [clip] = await waitForClipCount(alice, 1);
		assert.strictEqual(clip.name, 'imported');
		assert.strictEqual(clip.description, 'desc');
		assert.strictEqual(clip.isPublic, false);

		const notes = await waitForClipNote(alice, clip.id, bobNote.id);
		assert.deepStrictEqual(notes.map(note => note.id).sort(), [aliceNote.id, bobNote.id].sort());
	});

	test('resolves notes by id when uri is null (same-server export)', async () => {
		const note = await post(alice, { text: 'no uri' });

		const file = await uploadExport(alice, [
			exportedClip('from same server', [{ id: note.id, uri: null }]),
		]);

		const res = await api('i/import-clips', { fileId: file.id }, alice);
		assert.strictEqual(res.status, 204);

		const [clip] = await waitForClipCount(alice, 1);
		const notes = await waitForClipNote(alice, clip.id, note.id);
		assert.strictEqual(notes.length, 1);
	});

	test('always creates a new clip even when a clip with the same name exists', async () => {
		const existingNote = await post(alice, { text: 'existing' });
		const importedNote = await post(alice, { text: 'imported' });

		const existing = (await api('clips/create', { name: 'dup' }, alice)).body;
		await api('clips/add-note', { clipId: existing.id, noteId: existingNote.id }, alice);

		const file = await uploadExport(alice, [
			exportedClip('dup', [{ id: importedNote.id, uri: localUri(importedNote) }]),
		]);

		const res = await api('i/import-clips', { fileId: file.id }, alice);
		assert.strictEqual(res.status, 204);

		const clips = await waitForClipCount(alice, 2);
		const created = clips.find(clip => clip.id !== existing.id)!;
		assert.strictEqual(created.name, 'dup');

		const createdNotes = await waitForClipNote(alice, created.id, importedNote.id);
		assert.deepStrictEqual(createdNotes.map(note => note.id), [importedNote.id]);

		const existingNotes = (await api('clips/notes', { clipId: existing.id }, alice)).body;
		assert.deepStrictEqual(existingNotes.map(note => note.id), [existingNote.id]);
	});

	test('skips notes the importer is not allowed to see', async () => {
		const hiddenNote = await post(bob, { text: 'followers only', visibility: 'followers' });
		const visibleNote = await post(bob, { text: 'public' });

		const file = await uploadExport(alice, [
			exportedClip('partially visible', [
				{ id: hiddenNote.id, uri: localUri(hiddenNote) },
				{ id: visibleNote.id, uri: localUri(visibleNote) },
			]),
		]);

		const res = await api('i/import-clips', { fileId: file.id }, alice);
		assert.strictEqual(res.status, 204);

		const [clip] = await waitForClipCount(alice, 1);
		const notes = await waitForClipNote(alice, clip.id, visibleNote.id);
		assert.deepStrictEqual(notes.map(note => note.id), [visibleNote.id]);
	});

	test('skips notes whose uri cannot be resolved', async () => {
		const note = await post(alice, { text: 'resolvable' });

		const file = await uploadExport(alice, [
			exportedClip('partially resolvable', [
				{ id: 'aaaaaaaaaaaaaaaa', uri: `${origin}/notes/aaaaaaaaaaaaaaaa` },
				{ id: note.id, uri: localUri(note) },
			]),
		]);

		const res = await api('i/import-clips', { fileId: file.id }, alice);
		assert.strictEqual(res.status, 204);

		const [clip] = await waitForClipCount(alice, 1);
		const notes = await waitForClipNote(alice, clip.id, note.id);
		assert.deepStrictEqual(notes.map(n => n.id), [note.id]);
	});

	test('rejects users without the canImportClips policy', async () => {
		const file = await uploadExport(bob, [exportedClip('nope', [])]);

		const res = await api('i/import-clips', { fileId: file.id }, bob);
		assert.strictEqual(res.status, 403);
		assert.strictEqual(castAsError(res.body as any).error.code, 'ROLE_PERMISSION_DENIED');
	});

	test('rejects a file that is not a clip export', async () => {
		const file = await uploadExport(alice, { foo: 'bar' });

		const res = await api('i/import-clips', { fileId: file.id }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'INVALID_FILE_FORMAT');
	});

	test('rejects a file that does not exist', async () => {
		const res = await api('i/import-clips', { fileId: 'aaaaaaaaaaaaaaaa' }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'NO_SUCH_FILE');
	});

	test('rejects when the import would exceed the clip limit', async () => {
		await api('clips/create', { name: 'only one' }, carol);

		const file = await uploadExport(carol, [exportedClip('one too many', [])]);

		const res = await api('i/import-clips', { fileId: file.id }, carol);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'TOO_MANY_CLIPS');
	});
});
