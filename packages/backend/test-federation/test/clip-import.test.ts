import { describe, test, beforeAll, beforeEach, vi } from 'vitest';
import { ok, strictEqual } from 'node:assert';
import * as Misskey from 'cherrypick-js';
import { createAccount, createRole, fetchAdmin, type LoginUser, WAIT_FOR_FEDERATION, WAIT_FOR_SLOW_FEDERATION } from './utils.js';

type Host = 'a.test' | 'b.test';

type ExportedNoteRef = {
	id: string;
	uri: string | null;
};

describe('Clip import', () => {
	/** a.test のユーザー */
	let alice: LoginUser;
	/** b.test のユーザー。canImportClips を持つ */
	let bob: LoginUser;
	/** b.test のユーザー。bob とフォロー関係なし */
	let carol: LoginUser;

	function noteUri(host: Host, note: { id: string }): string {
		return `https://${host}/notes/${note.id}`;
	}

	/** i/export-clips が書き出す形式のクリップ */
	function exportedClip(name: string, notes: ExportedNoteRef[]) {
		return {
			id: 'abcdefghij',
			name,
			description: null,
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

	async function uploadExport(host: Host, user: LoginUser, clips: unknown): Promise<Misskey.entities.DriveFile> {
		const body = new FormData();
		body.append('i', user.i);
		body.append('force', 'true');
		body.append('file', new Blob([JSON.stringify(clips)], { type: 'application/json' }));
		body.append('name', 'clips.json');
		return await fetch(`https://${host}/api/drive/files/create`, { method: 'POST', body })
			.then(async res => await res.json());
	}

	/**
	 * インポートを要求し、クリップが作られて `isDone` を満たすノートが入るまで待つ。
	 * ジョブはノートをファイルの順に処理するので、最後のノートが入った時点で前のノートの処理は終わっている。
	 */
	async function importAndWait(user: LoginUser, file: Misskey.entities.DriveFile, isDone: (note: Misskey.entities.Note) => boolean): Promise<Misskey.entities.Note[]> {
		await user.client.request('i/import-clips', { fileId: file.id });

		const clip = await vi.waitFor(async () => {
			const clips = await user.client.request('clips/list', {});
			strictEqual(clips.length, 1);
			return clips[0];
		}, WAIT_FOR_FEDERATION);

		return await vi.waitFor(async () => {
			const notes = await user.client.request('clips/notes', { clipId: clip.id });
			ok(notes.some(isDone));
			return notes;
		}, WAIT_FOR_SLOW_FEDERATION);
	}

	beforeAll(async () => {
		[alice, bob, carol] = await Promise.all([
			createAccount('a.test'),
			createAccount('b.test'),
			createAccount('b.test'),
		]);

		// i/import-clips は 1 時間に 1 回しか呼べないので、テスト用ロールでレート制限を無効化する
		const importerRole = await createRole('b.test', {
			name: 'Clip importer',
			target: 'manual',
			// policies の型は自動生成で never になるので、実際の形に合わせてキャストする
			policies: {
				canImportClips: { useDefault: false, priority: 0, value: true },
				rateLimitFactor: { useDefault: false, priority: 0, value: 0 },
			} as unknown as Misskey.entities.AdminRolesCreateRequest['policies'],
		});
		const admin = await fetchAdmin('b.test');
		await admin.client.request('admin/roles/assign', { roleId: importerRole.id, userId: bob.id });
	});

	beforeEach(async () => {
		const clips = await bob.client.request('clips/list', {});
		for (const clip of clips) {
			await bob.client.request('clips/delete', { clipId: clip.id });
		}
	});

	test('リモートサーバーのノートとローカルのノートを uri で解決してインポートできる', async () => {
		const aliceNote = (await alice.client.request('notes/create', { text: 'from a.test' })).createdNote;
		const bobNote = (await bob.client.request('notes/create', { text: 'from b.test' })).createdNote;

		const file = await uploadExport('b.test', bob, [
			exportedClip('federated', [
				{ id: aliceNote.id, uri: noteUri('a.test', aliceNote) },
				{ id: bobNote.id, uri: noteUri('b.test', bobNote) },
			]),
		]);

		const notes = await importAndWait(bob, file, note => note.id === bobNote.id);
		strictEqual(notes.length, 2);

		const remote = notes.find(note => note.uri === noteUri('a.test', aliceNote));
		ok(remote != null, 'remote note was not imported');
		strictEqual(remote.text, 'from a.test');
		strictEqual(remote.user.host, 'a.test');
	});

	test('リモートサーバーのフォロワー限定ノートはインポートされない', async () => {
		const hiddenNote = (await alice.client.request('notes/create', { text: 'followers only', visibility: 'followers' })).createdNote;
		const visibleNote = (await alice.client.request('notes/create', { text: 'public' })).createdNote;

		const file = await uploadExport('b.test', bob, [
			exportedClip('remote visibility', [
				{ id: hiddenNote.id, uri: noteUri('a.test', hiddenNote) },
				{ id: visibleNote.id, uri: noteUri('a.test', visibleNote) },
			]),
		]);

		const notes = await importAndWait(bob, file, note => note.uri === noteUri('a.test', visibleNote));
		strictEqual(notes.length, 1);
	});

	test('ローカルの見られないフォロワー限定ノートはインポートされない', async () => {
		const hiddenNote = (await carol.client.request('notes/create', { text: 'followers only', visibility: 'followers' })).createdNote;
		const visibleNote = (await carol.client.request('notes/create', { text: 'public' })).createdNote;

		const file = await uploadExport('b.test', bob, [
			exportedClip('local visibility', [
				{ id: hiddenNote.id, uri: noteUri('b.test', hiddenNote) },
				{ id: visibleNote.id, uri: noteUri('b.test', visibleNote) },
			]),
		]);

		const notes = await importAndWait(bob, file, note => note.id === visibleNote.id);
		strictEqual(notes.length, 1);
	});

	test('a.test でエクスポートしたクリップ (ローカルノートにも uri が付く) を b.test でインポートできる', async () => {
		const aliceNote = (await alice.client.request('notes/create', { text: 'exported from a.test' })).createdNote;
		const clip = await alice.client.request('clips/create', { name: 'to be exported' });
		await alice.client.request('clips/add-note', { clipId: clip.id, noteId: aliceNote.id });

		await alice.client.request('i/export-clips', {});
		const exportedFile = await vi.waitFor(async () => {
			const files = await alice.client.request('drive/files', { type: 'application/json' });
			const file = files.find(file => file.name.startsWith('clips-'));
			ok(file != null);
			return file;
		}, WAIT_FOR_SLOW_FEDERATION);

		const exported = await fetch(exportedFile.url).then(async res => await res.json());
		strictEqual(exported[0].name, 'to be exported');
		strictEqual(exported[0].clipNotes[0].note.uri, noteUri('a.test', aliceNote));

		const file = await uploadExport('b.test', bob, exported);
		const notes = await importAndWait(bob, file, note => note.uri === noteUri('a.test', aliceNote));
		strictEqual(notes.length, 1);
		strictEqual(notes[0].text, 'exported from a.test');
	});

	test('uri の無い他サーバーのローカルノート (順正 Misskey のエクスポート形式) は解決できない', async () => {
		const aliceNote = (await alice.client.request('notes/create', { text: 'no uri' })).createdNote;
		const bobNote = (await bob.client.request('notes/create', { text: 'local' })).createdNote;

		const file = await uploadExport('b.test', bob, [
			exportedClip('vanilla export', [
				// 順正 Misskey はローカルノートの uri を null で書き出すので、b.test からは a.test のノートだと分からない
				{ id: aliceNote.id, uri: null },
				{ id: bobNote.id, uri: noteUri('b.test', bobNote) },
			]),
		]);

		const notes = await importAndWait(bob, file, note => note.id === bobNote.id);
		strictEqual(notes.length, 1);
	});
});
