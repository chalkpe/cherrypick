/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, test } from 'vitest';
import { api, makeStreamCatcher, post, signup, uploadFile } from '../utils.js';
import type * as misskey from 'cherrypick-js';

describe('Drive', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
	}, 1000 * 60 * 2);

	test('ファイルURLからアップロードできる', async () => {
		// utils.js uploadUrl の処理だがAPIレスポンスも見るためここで同様の処理を書いている

		const marker = Math.random().toString();

		const url = 'https://raw.githubusercontent.com/kokonect-link/cherrypick/develop/packages/backend/test/resources/192.jpg';

		const catcher = makeStreamCatcher(
			alice,
			'main',
			(msg) => msg.type === 'urlUploadFinished' && msg.body.marker === marker,
			(msg) => msg.body.file,
			10 * 1000);

		const res = await api('drive/files/upload-from-url', {
			url,
			marker,
			force: true,
		}, alice);

		const file = await catcher;

		assert.strictEqual(res.status, 204);
		assert.strictEqual(file.name, '192.jpg');
		assert.strictEqual(file.type, 'image/jpeg');
	});

	test('ローカルからアップロードできる', async () => {
		// APIレスポンスを直接使用するので utils.js uploadFile が通過することで成功とする

		const res = await uploadFile(alice, { path: '192.jpg', name: 'テスト画像' });

		assert.strictEqual(res.body?.name, 'テスト画像.jpg');
		assert.strictEqual(res.body.type, 'image/jpeg');
	});

	test('添付ノート一覧を取得できる', async () => {
		const ids = (await Promise.all([uploadFile(alice), uploadFile(alice), uploadFile(alice)])).map(elm => elm.body!.id);

		const note0 = await post(alice, { fileIds: [ids[0]] });
		const note1 = await post(alice, { fileIds: [ids[0], ids[1]] });

		const attached0 = await api('drive/files/attached-notes', { fileId: ids[0] }, alice);
		assert.strictEqual(attached0.status, 200, JSON.stringify(attached0.body));
		assert.strictEqual(attached0.body.length, 2);
		assert.strictEqual(attached0.body[0].id, note1.id);
		assert.strictEqual(attached0.body[1].id, note0.id);

		const attached1 = await api('drive/files/attached-notes', { fileId: ids[1] }, alice);
		assert.strictEqual(attached1.body.length, 1);
		assert.strictEqual(attached1.body[0].id, note1.id);

		const attached2 = await api('drive/files/attached-notes', { fileId: ids[2] }, alice);
		assert.strictEqual(attached2.body.length, 0);
	});

	test('添付ノート一覧は他の人から見えない', async () => {
		const file = await uploadFile(alice);

		await post(alice, { fileIds: [file.body!.id] });

		const res = await api('drive/files/attached-notes', { fileId: file.body!.id }, bob);
		assert.strictEqual(res.status, 400);
		assert.strictEqual('error' in res.body, true);
	});
});

describe('Drive unused files', () => {
	let carol: misskey.entities.SignupResponse;
	let dave: misskey.entities.SignupResponse;
	let eve: misskey.entities.SignupResponse;

	beforeAll(async () => {
		carol = await signup({ username: 'unused_carol' });
		dave = await signup({ username: 'unused_dave' });
		eve = await signup({ username: 'unused_eve' });
	}, 1000 * 60 * 2);

	async function unusedIds(user: misskey.entities.SignupResponse): Promise<string[]> {
		const res = await api('drive/files/unused', { limit: 100 }, user);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		return res.body.map(f => f.id);
	}

	test('ノートに添付されていないファイルだけが返る', async () => {
		const attached = (await uploadFile(carol)).body!;
		const free = (await uploadFile(carol)).body!;
		await post(carol, { text: 'with file', fileIds: [attached.id] });

		const ids = await unusedIds(carol);
		assert.ok(ids.includes(free.id));
		assert.ok(!ids.includes(attached.id));
	});

	test('フォルダ内のファイルも返る', async () => {
		const folder = await api('drive/folders/create', { name: 'unused-folder' }, carol);
		assert.strictEqual(folder.status, 200);
		const inFolder = (await uploadFile(carol)).body!;
		const moved = await api('drive/files/update', { fileId: inFolder.id, folderId: folder.body.id }, carol);
		assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));

		const ids = await unusedIds(carol);
		assert.ok(ids.includes(inFolder.id));
	});

	test('他人のファイルは返らない', async () => {
		const davesFile = (await uploadFile(dave)).body!;

		const ids = await unusedIds(carol);
		assert.ok(!ids.includes(davesFile.id));
		assert.ok((await unusedIds(dave)).includes(davesFile.id));
	});

	test('limit で件数が制限される', async () => {
		await Promise.all([uploadFile(carol), uploadFile(carol), uploadFile(carol)]);
		const res = await api('drive/files/unused', { limit: 2 }, carol);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.length, 2);
	});

	test('下書きに添付されたファイルは返らない', async () => {
		const file = (await uploadFile(carol)).body!;
		const res = await api('notes/drafts/create', { text: 'draft', fileIds: [file.id] }, carol);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		assert.ok(!(await unusedIds(carol)).includes(file.id));
	});

	test('ノートの編集履歴に残ったファイルは返らない', async () => {
		const before = (await uploadFile(carol)).body!;
		const after = (await uploadFile(carol)).body!;
		const note = await post(carol, { text: 'edit me', fileIds: [before.id] });
		const res = await api('notes/update', { noteId: note.id, text: 'edited', cw: null, fileIds: [after.id] }, carol);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		const ids = await unusedIds(carol);
		assert.ok(!ids.includes(before.id), 'history keeps the old attachment');
		assert.ok(!ids.includes(after.id), 'note keeps the new attachment');
	});

	test('チャットに添付したファイルは返らない (ファイル無しのメッセージがあっても他の未使用ファイルは返る)', async () => {
		await api('i/update', { chatScope: 'everyone' }, dave);
		await api('i/update', { chatScope: 'everyone' }, eve);
		const file = (await uploadFile(carol)).body!;
		const free = (await uploadFile(carol)).body!;
		const withFile = await api('chat/messages/create-to-user', { toUserId: dave.id, text: 'hi', fileId: file.id }, carol);
		assert.strictEqual(withFile.status, 200, JSON.stringify(withFile.body));
		// 同じ相手へ連投すると ChatService の承認行 insert (await なし) が重複キーで unhandled rejection になるため、別の相手へ送る
		const withoutFile = await api('chat/messages/create-to-user', { toUserId: eve.id, text: 'no file' }, carol);
		assert.strictEqual(withoutFile.status, 200, JSON.stringify(withoutFile.body));

		const ids = await unusedIds(carol);
		assert.ok(!ids.includes(file.id));
		assert.ok(ids.includes(free.id));

		// ChatService は送信 3 秒後に未読チェックのタイマーを起動する。テストサーバー終了後に発火すると Redis 切断でプロセスが落ちるため、発火を待つ
		await new Promise(resolve => setTimeout(resolve, 3500));
	}, 1000 * 15);

	test('ギャラリーに使ったファイルは返らない', async () => {
		const file = (await uploadFile(carol)).body!;
		const res = await api('gallery/posts/create', { title: 'g', fileIds: [file.id] }, carol);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		assert.ok(!(await unusedIds(carol)).includes(file.id));
	});

	test('ページのアイキャッチと本文(入れ子ブロック)の画像は返らない', async () => {
		const eyeCatching = (await uploadFile(carol)).body!;
		const topLevel = (await uploadFile(carol)).body!;
		const nested = (await uploadFile(carol)).body!;
		const res = await api('pages/create', {
			title: 'p',
			name: 'unused-page-' + Math.random().toString(36).slice(2),
			content: [
				{ id: 'a', type: 'image', fileId: topLevel.id },
				{ id: 'b', type: 'section', title: 's', children: [
					{ id: 'c', type: 'image', fileId: nested.id },
				] },
			],
			variables: [],
			script: '',
			eyeCatchingImageId: eyeCatching.id,
		}, carol);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		const ids = await unusedIds(carol);
		assert.ok(!ids.includes(eyeCatching.id), 'eye catching image');
		assert.ok(!ids.includes(topLevel.id), 'top-level image block');
		assert.ok(!ids.includes(nested.id), 'nested image block');
	});

	test('チャンネルのバナーは返らない', async () => {
		const file = (await uploadFile(carol)).body!;
		const res = await api('channels/create', { name: 'c', bannerId: file.id }, carol);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		assert.ok(!(await unusedIds(carol)).includes(file.id));
	});

	test('アバターとバナーは返らない', async () => {
		const avatar = (await uploadFile(carol)).body!;
		const banner = (await uploadFile(carol)).body!;
		const res = await api('i/update', { avatarId: avatar.id, bannerId: banner.id }, carol);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		const ids = await unusedIds(carol);
		assert.ok(!ids.includes(avatar.id));
		assert.ok(!ids.includes(banner.id));
	});
});

describe('Drive bulk delete', () => {
	let erin: misskey.entities.SignupResponse;
	let frank: misskey.entities.SignupResponse;

	beforeAll(async () => {
		erin = await signup({ username: 'bulk_erin' });
		frank = await signup({ username: 'bulk_frank' });
	}, 1000 * 60 * 2);

	async function exists(user: misskey.entities.SignupResponse, fileId: string): Promise<boolean> {
		const res = await api('drive/files/show', { fileId }, user);
		return res.status === 200;
	}

	// DriveService.deleteFile はレコード削除 (deletePostProcess) を await せずに返すため、消えるまで少し待つ
	async function waitUntilDeleted(user: misskey.entities.SignupResponse, fileId: string): Promise<boolean> {
		for (let i = 0; i < 20; i++) {
			if (!(await exists(user, fileId))) return true;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return false;
	}

	test('自分のファイルをまとめて削除できる', async () => {
		const files = (await Promise.all([uploadFile(erin), uploadFile(erin), uploadFile(erin)])).map(r => r.body!);

		const res = await api('drive/files/delete-bulk', { fileIds: files.map(f => f.id) }, erin);
		assert.strictEqual(res.status, 204, JSON.stringify(res.body));

		for (const f of files) {
			assert.strictEqual(await waitUntilDeleted(erin, f.id), true);
		}
	});

	test('他人のファイルと存在しない ID は無視して残りを削除する', async () => {
		const mine = (await uploadFile(erin)).body!;
		const franks = (await uploadFile(frank)).body!;

		const res = await api('drive/files/delete-bulk', { fileIds: [mine.id, franks.id, '0000000000000000'] }, erin);
		assert.strictEqual(res.status, 204, JSON.stringify(res.body));

		assert.strictEqual(await waitUntilDeleted(erin, mine.id), true);
		assert.strictEqual(await exists(frank, franks.id), true);
	});

	test('空の配列は 400', async () => {
		const res = await api('drive/files/delete-bulk', { fileIds: [] }, erin);
		assert.strictEqual(res.status, 400);
	});
});
