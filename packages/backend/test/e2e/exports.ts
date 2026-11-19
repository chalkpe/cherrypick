/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { api, origin, port, post, signup, startJobQueue, uploadFile } from '../utils.js';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'cherrypick-js';

describe('export-clips', () => {
	let queue: INestApplicationContext;
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	// XXX: Any better way to get the result?
	async function pollFirstDriveFile(): Promise<any> {
		while (true) {
			const files = (await api('drive/files', {}, alice)).body;
			if (!files.length) {
				await new Promise(r => setTimeout(r, 100));
				continue;
			}
			if (files.length > 1) {
				throw new Error('Too many files?');
			}
			const file = (await api('drive/files/show', { fileId: files[0].id }, alice)).body;
			const res = await fetch(new URL(new URL(file.url).pathname, `http://127.0.0.1:${port}`));
			return await res.json();
		}
	}

	beforeAll(async () => {
		queue = await startJobQueue();
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await queue.close();
	});

	beforeEach(async () => {
		// Clean all clips and files of alice
		const clips = (await api('clips/list', {}, alice)).body;
		for (const clip of clips) {
			const res = await api('clips/delete', { clipId: clip.id }, alice);
			if (res.status !== 204) {
				throw new Error('Failed to delete clip');
			}
		}
		const files = (await api('drive/files', {}, alice)).body;
		for (const file of files) {
			const res = await api('drive/files/delete', { fileId: file.id }, alice);
			if (res.status !== 204) {
				throw new Error('Failed to delete file');
			}
		}
	});

	test('basic export', async () => {
		const res1 = await api('clips/create', {
			name: 'foo',
			description: 'bar',
		}, alice);
		assert.strictEqual(res1.status, 200);

		const res2 = await api('i/export-clips', {}, alice);
		assert.strictEqual(res2.status, 204);

		const exported = await pollFirstDriveFile();
		assert.strictEqual(exported[0].name, 'foo');
		assert.strictEqual(exported[0].description, 'bar');
		assert.strictEqual(exported[0].clipNotes.length, 0);
	});

	test('export with notes', async () => {
		const res = await api('clips/create', {
			name: 'foo',
			description: 'bar',
		}, alice);
		assert.strictEqual(res.status, 200);
		const clip = res.body;

		const note1 = await post(alice, {
			text: 'baz1',
		});

		const note2 = await post(alice, {
			text: 'baz2',
			poll: {
				choices: ['sakura', 'izumi', 'ako'],
			},
		});

		for (const note of [note1, note2]) {
			const res2 = await api('clips/add-note', {
				clipId: clip.id,
				noteId: note.id,
			}, alice);
			assert.strictEqual(res2.status, 204);
		}

		const res3 = await api('i/export-clips', {}, alice);
		assert.strictEqual(res3.status, 204);

		const exported = await pollFirstDriveFile();
		assert.strictEqual(exported[0].name, 'foo');
		assert.strictEqual(exported[0].description, 'bar');
		assert.strictEqual(exported[0].clipNotes.length, 2);
		assert.strictEqual(exported[0].clipNotes[0].note.text, 'baz1');
		assert.strictEqual(exported[0].clipNotes[1].note.text, 'baz2');
		assert.deepStrictEqual(exported[0].clipNotes[1].note.poll.choices[0], 'sakura');
	});

	test('local notes are exported with their ActivityPub uri', async () => {
		const res = await api('clips/create', {
			name: 'foo',
			description: 'bar',
		}, alice);
		assert.strictEqual(res.status, 200);
		const clip = res.body;

		const note = await post(alice, {
			text: 'baz',
		});

		const res2 = await api('clips/add-note', {
			clipId: clip.id,
			noteId: note.id,
		}, alice);
		assert.strictEqual(res2.status, 204);

		const res3 = await api('i/export-clips', {}, alice);
		assert.strictEqual(res3.status, 204);

		const exported = await pollFirstDriveFile();
		assert.strictEqual(exported[0].clipNotes.length, 1);
		assert.strictEqual(exported[0].clipNotes[0].note.uri, `${origin}/notes/${note.id}`);
	});

	test('multiple clips', async () => {
		const res1 = await api('clips/create', {
			name: 'kawaii',
			description: 'kawaii',
		}, alice);
		assert.strictEqual(res1.status, 200);
		const clip1 = res1.body;

		const res2 = await api('clips/create', {
			name: 'yuri',
			description: 'yuri',
		}, alice);
		assert.strictEqual(res2.status, 200);
		const clip2 = res2.body;

		const note1 = await post(alice, {
			text: 'baz1',
		});

		const note2 = await post(alice, {
			text: 'baz2',
		});

		{
			const res = await api('clips/add-note', {
				clipId: clip1.id,
				noteId: note1.id,
			}, alice);
			assert.strictEqual(res.status, 204);
		}

		{
			const res = await api('clips/add-note', {
				clipId: clip2.id,
				noteId: note2.id,
			}, alice);
			assert.strictEqual(res.status, 204);
		}

		{
			const res = await api('i/export-clips', {}, alice);
			assert.strictEqual(res.status, 204);
		}

		const exported = await pollFirstDriveFile();
		assert.strictEqual(exported[0].name, 'kawaii');
		assert.strictEqual(exported[0].clipNotes.length, 1);
		assert.strictEqual(exported[0].clipNotes[0].note.text, 'baz1');
		assert.strictEqual(exported[1].name, 'yuri');
		assert.strictEqual(exported[1].clipNotes.length, 1);
		assert.strictEqual(exported[1].clipNotes[0].note.text, 'baz2');
	});

	test('excludes previously clipped followers-only notes after unfollowing', async () => {
		const res = await api('clips/create', {
			name: 'kawaii',
			description: 'kawaii',
		}, alice);
		assert.strictEqual(res.status, 200);
		const clip = res.body;

		const note = await post(bob, {
			text: 'baz',
			visibility: 'followers',
		});

		assert.strictEqual((await api('following/create', { userId: bob.id }, alice)).status, 200);
		const res2 = await api('clips/add-note', {
			clipId: clip.id,
			noteId: note.id,
		}, alice);
		assert.strictEqual(res2.status, 204);
		assert.strictEqual((await api('following/delete', { userId: bob.id }, alice)).status, 200);

		const res3 = await api('i/export-clips', {}, alice);
		assert.strictEqual(res3.status, 204);

		const exported = await pollFirstDriveFile();
		assert.strictEqual(exported[0].clipNotes.length, 0);
	});

	test('uses the current age-based visibility rules when exporting notes', async () => {
		const writer = await signup({ username: 'clip_writer' });
		const { body: clip } = await api('clips/create', { name: 'reading list' }, alice);
		const publicNote = await post(writer, { text: 'public before the setting changed' });
		const ownNote = await post(alice, { text: 'my own note' });

		try {
			for (const note of [publicNote, ownNote]) {
				assert.strictEqual((await api('clips/add-note', { clipId: clip.id, noteId: note.id }, alice)).status, 204);
			}
			assert.strictEqual((await api('i/update', { makeNotesFollowersOnlyBefore: 1 + Math.ceil(Date.now() / 1000) }, writer)).status, 200);
			assert.strictEqual((await api('i/update', { makeNotesHiddenBefore: 1 + Math.ceil(Date.now() / 1000) }, alice)).status, 200);

			assert.strictEqual((await api('i/export-clips', {}, alice)).status, 204);

			const exported = await pollFirstDriveFile();
			assert.deepStrictEqual(exported[0].clipNotes.map((entry: { note: { id: string } }) => entry.note.id), [ownNote.id]);
		} finally {
			await api('clips/delete', { clipId: clip.id }, alice);
			await api('i/update', { makeNotesHiddenBefore: null }, alice);
		}
	});

	test('checks the current follow when adding, listing, and exporting age-restricted notes', async () => {
		const writer = await signup({ username: 'clip_followed_writer' });
		const { body: clip } = await api('clips/create', { name: 'followed notes' }, alice);
		const attachment = await uploadFile(writer);
		assert.strictEqual(attachment.status, 200);
		assert.ok(attachment.body);
		const fileId = attachment.body.id;
		const cw = 'Saved note warning';
		const saved = await post(writer, { text: 'Saved first', cw, fileIds: [fileId], localOnly: true });
		const unsaved = await post(writer, { text: 'Saved later', localOnly: true });

		try {
			assert.strictEqual((await api('following/create', { userId: writer.id }, alice)).status, 200);
			assert.strictEqual((await api('i/update', { makeNotesFollowersOnlyBefore: 0 }, writer)).status, 200);
			assert.strictEqual((await api('clips/add-note', { clipId: clip.id, noteId: saved.id }, alice)).status, 204);
			const whileFollowing = await api('clips/notes', { clipId: clip.id }, alice);
			assert.strictEqual(whileFollowing.status, 200);
			assert.strictEqual(whileFollowing.body[0].text, saved.text);
			assert.strictEqual(whileFollowing.body[0].cw, cw);
			assert.deepStrictEqual(whileFollowing.body[0].fileIds, [fileId]);
			assert.deepStrictEqual(whileFollowing.body[0].files?.map(file => file.id), [fileId]);

			assert.strictEqual((await api('following/delete', { userId: writer.id }, alice)).status, 200);
			assert.strictEqual((await api('clips/add-note', { clipId: clip.id, noteId: unsaved.id }, alice)).status, 400);
			const afterUnfollowing = await api('clips/notes', { clipId: clip.id }, alice);
			assert.strictEqual(afterUnfollowing.status, 200);
			assert.deepStrictEqual(afterUnfollowing.body.map(note => note.id), [saved.id]);
			const [hidden] = afterUnfollowing.body;
			assert.strictEqual(hidden.isHidden, true);
			assert.strictEqual(hidden.text, null);
			assert.strictEqual(hidden.cw, null);
			assert.deepStrictEqual(hidden.fileIds, []);
			assert.deepStrictEqual(hidden.files, []);
			assert.strictEqual((await api('i/export-clips', {}, alice)).status, 204);
			assert.deepStrictEqual((await pollFirstDriveFile())[0].clipNotes, []);
		} finally {
			await api('clips/delete', { clipId: clip.id }, alice);
		}
	});

	test('Clipping other user\'s note (followers only notes are included when following)', async () => {
		// Alice follows Bob
		await api('following/create', { userId: bob.id }, alice);

		const res = await api('clips/create', {
			name: 'kawaii',
			description: 'kawaii',
		}, alice);
		assert.strictEqual(res.status, 200);
		const clip = res.body;

		const note = await post(bob, {
			text: 'baz',
			visibility: 'followers',
		});

		const res2 = await api('clips/add-note', {
			clipId: clip.id,
			noteId: note.id,
		}, alice);
		assert.strictEqual(res2.status, 204);

		const res3 = await api('i/export-clips', {}, alice);
		assert.strictEqual(res3.status, 204);

		const exported = await pollFirstDriveFile();
		assert.strictEqual(exported[0].name, 'kawaii');
		assert.strictEqual(exported[0].clipNotes.length, 1);
		assert.strictEqual(exported[0].clipNotes[0].note.text, 'baz');
		assert.strictEqual(exported[0].clipNotes[0].note.user.username, 'bob');
	});
});
