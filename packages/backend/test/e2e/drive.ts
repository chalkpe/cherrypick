/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, test } from 'vitest';
import { api, createAppToken, makeStreamCatcher, post, signup, uploadFile, waitFire } from '../utils.js';
import type * as misskey from 'cherrypick-js';

// このファイルで最初に signup する alice が root (モデレーター権限あり) になる
let alice: misskey.entities.SignupResponse;
let bob: misskey.entities.SignupResponse;

describe('Drive', () => {
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

	test('untilId で前ページ末尾から読み進められる (どの並び順でも重複・欠落なし)', async () => {
		// 同じサイズのファイルを混ぜ、第二キー (id) での並びも確かめる
		await Promise.all([uploadFile(carol), uploadFile(carol), uploadFile(carol), uploadFile(carol, { path: 'anime.gif' })]);

		for (const sort of ['+createdAt', '-createdAt', '+name', '-name', '+size', '-size'] as const) {
			const all = await api('drive/files/unused', { limit: 100, sort }, carol);
			assert.strictEqual(all.status, 200);
			assert.ok(all.body.length >= 4);

			const paged: string[] = [];
			let cursor: { untilId: string; untilSize: number; untilName: string } | undefined;
			for (;;) {
				const page = await api('drive/files/unused', { limit: 2, sort, ...cursor }, carol);
				assert.strictEqual(page.status, 200, JSON.stringify(page.body));
				if (page.body.length === 0) break;
				paged.push(...page.body.map(f => f.id));
				const last = page.body.at(-1)!;
				cursor = { untilId: last.id, untilSize: last.size, untilName: last.name };
			}
			assert.deepStrictEqual(paged, all.body.map(f => f.id), sort);
		}
	});

	test('サイズ順・名前順で並び替えキーを省いた untilId はエラー', async () => {
		const file = (await uploadFile(carol)).body!;
		assert.strictEqual((await api('drive/files/unused', { sort: '+size', untilId: file.id }, carol)).status, 400);
		assert.strictEqual((await api('drive/files/unused', { sort: '+name', untilId: file.id }, carol)).status, 400);
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

	test('モデレーターが他人のチャンネルのバナーに設定したファイルは返らない', async () => {
		const channel = await api('channels/create', { name: 'c2' }, carol);
		assert.strictEqual(channel.status, 200, JSON.stringify(channel.body));
		const file = (await uploadFile(alice)).body!;
		const res = await api('channels/update', { channelId: channel.body.id, bannerId: file.id }, alice);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		assert.ok(!(await unusedIds(alice)).includes(file.id));
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

	test('自分の未使用ファイルをまとめて削除し、削除した ID を返す', async () => {
		const files = (await Promise.all([uploadFile(erin), uploadFile(erin), uploadFile(erin)])).map(r => r.body!);

		const res = await api('drive/files/delete-bulk', { fileIds: files.map(f => f.id) }, erin);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.deepStrictEqual([...res.body.deletedIds].sort(), files.map(f => f.id).sort());
		assert.deepStrictEqual(res.body.failedIds, []);

		// レコード削除まで待ってから返すので、直後に引いても残っていない
		for (const f of files) {
			assert.strictEqual(await exists(erin, f.id), false);
		}
	});

	test('他人のファイルと存在しない ID は無視して残りを削除する', async () => {
		const mine = (await uploadFile(erin)).body!;
		const franks = (await uploadFile(frank)).body!;

		const res = await api('drive/files/delete-bulk', { fileIds: [mine.id, franks.id, '0000000000000000'] }, erin);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.deepStrictEqual(res.body, { deletedIds: [mine.id], failedIds: [] });

		assert.strictEqual(await exists(erin, mine.id), false);
		assert.strictEqual(await exists(frank, franks.id), true);
	});

	test('一覧を取得した後に使われたファイルは削除しない', async () => {
		const attached = (await uploadFile(erin)).body!;
		const free = (await uploadFile(erin)).body!;
		await post(erin, { text: 'attached after listing', fileIds: [attached.id] });

		const res = await api('drive/files/delete-bulk', { fileIds: [attached.id, free.id] }, erin);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.deepStrictEqual(res.body, { deletedIds: [free.id], failedIds: [] });

		assert.strictEqual(await exists(erin, attached.id), true);
		assert.strictEqual(await exists(erin, free.id), false);
	});

	test('空の配列は 400', async () => {
		const res = await api('drive/files/delete-bulk', { fileIds: [] }, erin);
		assert.strictEqual(res.status, 400);
	});
});

describe('Drive folder and file sorting', () => {
	let owner: misskey.entities.SignupResponse;
	let other: misskey.entities.SignupResponse;
	let parentId: string;

	beforeAll(async () => {
		owner = await signup({ username: 'drive_sort_owner' });
		other = await signup({ username: 'drive_sort_other' });
		const parent = await api('drive/folders/create', { name: 'sort-test' }, owner);
		assert.strictEqual(parent.status, 200);
		parentId = parent.body.id;
	}, 1000 * 60 * 2);

	test('folder names are sorted across pages, including duplicate names', async () => {
		for (const name of ['003 한글', '001 English', '002 한글', '001 English', '10 English', '2 English']) {
			const result = await api('drive/folders/create', { name, parentId }, owner);
			assert.strictEqual(result.status, 200);
		}
		const foreign = await api('drive/folders/create', { name: '000 foreign' }, other);
		assert.strictEqual(foreign.status, 200);

		const params = { folderId: parentId, sort: '-name' as const, limit: 100 };
		const all = await api('drive/folders', params, owner);
		assert.strictEqual(all.status, 200);
		assert.deepStrictEqual(all.body.map(folder => folder.name), ['001 English', '001 English', '002 한글', '003 한글', '10 English', '2 English']);

		const paged: string[] = [];
		let cursor: { untilId: string; untilName: string } | undefined;
		for (;;) {
			const page = await api('drive/folders', { ...params, limit: 2, ...cursor }, owner);
			assert.strictEqual(page.status, 200);
			if (page.body.length === 0) break;
			paged.push(...page.body.map(folder => folder.id));
			const last = page.body.at(-1)!;
			cursor = { untilId: last.id, untilName: last.name };
		}
		assert.deepStrictEqual(paged, all.body.map(folder => folder.id));
	});

	test('file names are sorted across pages without omissions or duplicates', async () => {
		for (const name of ['003 English', '001 English', '002 한글', '001 English']) {
			const uploaded = await uploadFile(owner, { name });
			assert.strictEqual(uploaded.status, 200);
			const moved = await api('drive/files/update', { fileId: uploaded.body!.id, folderId: parentId }, owner);
			assert.strictEqual(moved.status, 200);
		}

		const params = { folderId: parentId, sort: '-name' as const, limit: 100 };
		const all = await api('drive/files', params, owner);
		assert.strictEqual(all.status, 200);
		assert.strictEqual(all.body.length, 4);
		const paged: string[] = [];
		let cursor: { untilId: string; untilName: string } | undefined;
		for (;;) {
			const page = await api('drive/files', { ...params, limit: 2, ...cursor }, owner);
			assert.strictEqual(page.status, 200);
			if (page.body.length === 0) break;
			paged.push(...page.body.map(file => file.id));
			const last = page.body.at(-1)!;
			cursor = { untilId: last.id, untilName: last.name };
		}
		assert.deepStrictEqual(paged, all.body.map(file => file.id));
	});

	test('folder date bounds remain independent of name cursors', async () => {
		const parent = await api('drive/folders/create', { name: 'date-cursor' }, owner);
		assert.strictEqual(parent.status, 200);

		const firstFolder = await api('drive/folders/create', { name: 'first', parentId: parent.body.id }, owner);
		const middleFolder = await api('drive/folders/create', { name: 'middle', parentId: parent.body.id }, owner);
		const lastFolder = await api('drive/folders/create', { name: 'last', parentId: parent.body.id }, owner);
		assert.strictEqual(firstFolder.status, 200);
		assert.strictEqual(middleFolder.status, 200);
		assert.strictEqual(lastFolder.status, 200);
		const folderDate = Date.parse(firstFolder.body.createdAt) + 1;
		assert.ok(folderDate <= Date.parse(middleFolder.body.createdAt));
		const folderParams = { folderId: parent.body.id, sort: '-name' as const, untilDate: folderDate, limit: 100 };
		const folders = await api('drive/folders', folderParams, owner);
		const cursorFolders = await api('drive/folders', { ...folderParams, untilId: lastFolder.body.id, untilName: '' }, owner);
		assert.strictEqual(folders.status, 200);
		assert.strictEqual(cursorFolders.status, 200);
		assert.deepStrictEqual(folders.body.map(folder => folder.id), [firstFolder.body.id]);
		assert.deepStrictEqual(cursorFolders.body.map(folder => folder.id), folders.body.map(folder => folder.id));
		const boundedFolders = await api('drive/folders', { ...folderParams, sinceDate: folderDate - 1000, untilId: lastFolder.body.id, untilName: '' }, owner);
		assert.strictEqual(boundedFolders.status, 200);
		assert.deepStrictEqual(boundedFolders.body.map(folder => folder.id), folders.body.map(folder => folder.id));
	});

	test('file date bounds remain independent of name and size cursors', async () => {
		const parent = await api('drive/folders/create', { name: 'file-date-cursor' }, owner);
		assert.strictEqual(parent.status, 200);

		const firstFile = await uploadFile(owner, { name: 'first' });
		const middleFile = await uploadFile(owner, { name: 'middle' });
		const lastFile = await uploadFile(owner, { name: 'last' });
		assert.strictEqual(firstFile.status, 200);
		assert.strictEqual(middleFile.status, 200);
		assert.strictEqual(lastFile.status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: firstFile.body!.id, folderId: parent.body.id }, owner)).status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: middleFile.body!.id, folderId: parent.body.id }, owner)).status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: lastFile.body!.id, folderId: parent.body.id }, owner)).status, 200);
		const fileDate = Date.parse(firstFile.body!.createdAt) + 1;
		assert.ok(fileDate <= Date.parse(middleFile.body!.createdAt));
		for (const sort of ['-name', '-size'] as const) {
			const params = { folderId: parent.body.id, sort, untilDate: fileDate, limit: 100 };
			const files = await api('drive/files', params, owner);
			const cursorFiles = await api('drive/files', { ...params, untilId: lastFile.body!.id, untilName: '', untilSize: 0 }, owner);
			assert.strictEqual(files.status, 200);
			assert.strictEqual(cursorFiles.status, 200);
			assert.deepStrictEqual(files.body.map(file => file.id), [firstFile.body!.id]);
			assert.deepStrictEqual(cursorFiles.body.map(file => file.id), files.body.map(file => file.id), sort);
			const boundedFiles = await api('drive/files', { ...params, sinceDate: fileDate - 1000, untilId: lastFile.body!.id, untilName: '', untilSize: 0 }, owner);
			assert.strictEqual(boundedFiles.status, 200);
			assert.deepStrictEqual(boundedFiles.body.map(file => file.id), files.body.map(file => file.id), sort);
		}
	});

	test.each(['-name', '+name'] as const)('folder %s pagination accepts a supplied name cursor', async (sort) => {
		const parent = await api('drive/folders/create', { name: 'folder-directions' }, owner);
		assert.strictEqual(parent.status, 200);
		for (const name of ['one', 'two', 'one', 'three']) {
			assert.strictEqual((await api('drive/folders/create', { name, parentId: parent.body.id }, owner)).status, 200);
		}
		const params = { folderId: parent.body.id, sort };
		const all = await api('drive/folders', { ...params, limit: 100 }, owner);
		assert.strictEqual(all.status, 200);
		const ids: string[] = [];
		let cursor: { untilId: string; untilName: string } | undefined;
		for (;;) {
			const page = await api('drive/folders', { ...params, limit: 2, ...cursor }, owner);
			assert.strictEqual(page.status, 200);
			if (!page.body.length) break;
			ids.push(...page.body.map(item => item.id));
			assert.ok(ids.length <= all.body.length);
			const last = page.body.at(-1)!;
			cursor = { untilId: last.id, untilName: last.name };
		}
		assert.deepStrictEqual(ids, all.body.map(item => item.id));
	});

	test.each(['delete', 'move'] as const)('folder pagination continues after cursor %s', async (action) => {
		const parent = await api('drive/folders/create', { name: 'folder-cursor-source' }, owner);
		const destination = await api('drive/folders/create', { name: 'folder-cursor-destination' }, owner);
		assert.strictEqual(parent.status, 200);
		assert.strictEqual(destination.status, 200);
		for (const name of ['one', 'two', 'three']) {
			assert.strictEqual((await api('drive/folders/create', { name, parentId: parent.body.id }, owner)).status, 200);
		}
		const params = { folderId: parent.body.id, sort: '-name' as const };
		const all = await api('drive/folders', { ...params, limit: 100 }, owner);
		const first = await api('drive/folders', { ...params, limit: 1 }, owner);
		assert.strictEqual(all.status, 200);
		assert.strictEqual(first.status, 200);
		assert.strictEqual(first.body.length, 1);
		const cursor = first.body[0];
		const changed = action === 'delete'
			? await api('drive/folders/delete', { folderId: cursor.id }, owner)
			: await api('drive/folders/update', { folderId: cursor.id, parentId: destination.body.id }, owner);
		assert.ok(changed.status === 200 || changed.status === 204);
		const rest = await api('drive/folders', { ...params, untilId: cursor.id, untilName: cursor.name }, owner);
		assert.strictEqual(rest.status, 200);
		assert.deepStrictEqual(rest.body.map(item => item.id), all.body.slice(1).map(item => item.id));
	});

	test.each(['delete', 'move'] as const)('file pagination continues after cursor %s', async (action) => {
		for (const sort of ['-name', '-size'] as const) {
			const parent = await api('drive/folders/create', { name: 'file-cursor-source' }, owner);
			const destination = await api('drive/folders/create', { name: 'file-cursor-destination' }, owner);
			assert.strictEqual(parent.status, 200);
			assert.strictEqual(destination.status, 200);
			for (const name of ['one', 'two', 'three']) {
				const uploaded = await uploadFile(owner, { name });
				assert.strictEqual(uploaded.status, 200);
				assert.strictEqual((await api('drive/files/update', { fileId: uploaded.body!.id, folderId: parent.body.id }, owner)).status, 200);
			}
			const params = { folderId: parent.body.id, sort };
			const all = await api('drive/files', { ...params, limit: 100 }, owner);
			const first = await api('drive/files', { ...params, limit: 1 }, owner);
			assert.strictEqual(all.status, 200);
			assert.strictEqual(first.status, 200);
			assert.strictEqual(first.body.length, 1);
			const cursor = first.body[0];
			const changed = action === 'delete'
				? await api('drive/files/delete', { fileId: cursor.id }, owner)
				: await api('drive/files/update', { fileId: cursor.id, folderId: destination.body.id }, owner);
			assert.ok(changed.status === 200 || changed.status === 204);
			const rest = await api('drive/files', { ...params, untilId: cursor.id, untilName: cursor.name, untilSize: cursor.size }, owner);
			assert.strictEqual(rest.status, 200);
			assert.deepStrictEqual(rest.body.map(item => item.id), all.body.slice(1).map(item => item.id), sort);
		}
	});

	test('foreign cursor values cannot return another user’s items', async () => {
		const ownFolder = await api('drive/folders/create', { name: 'own-cursor' }, owner);
		const ownFile = await uploadFile(owner, { name: 'own-cursor' });
		const foreignFolder = await api('drive/folders/create', { name: 'foreign-cursor' }, other);
		const foreignFile = await uploadFile(other, { name: 'foreign-cursor' });
		assert.strictEqual(ownFolder.status, 200);
		assert.strictEqual(ownFile.status, 200);
		assert.strictEqual(foreignFolder.status, 200);
		assert.strictEqual(foreignFile.status, 200);
		const foreignChild = await api('drive/folders/create', { name: 'foreign-child', parentId: foreignFolder.body.id }, other);
		assert.strictEqual(foreignChild.status, 200);
		assert.strictEqual((await api('drive/files/update', { fileId: foreignFile.body!.id, folderId: foreignFolder.body.id }, other)).status, 200);
		const folders = await api('drive/folders', { sort: '-name', untilId: foreignFolder.body.id, untilName: '', limit: 100 }, owner);
		const files = await api('drive/files', { sort: '-size', untilId: foreignFile.body!.id, untilSize: 0, limit: 100 }, owner);
		assert.strictEqual(folders.status, 200);
		assert.strictEqual(files.status, 200);
		assert.ok(folders.body.some(item => item.id === ownFolder.body.id));
		assert.ok(files.body.some(item => item.id === ownFile.body!.id));
		assert.ok(folders.body.every(item => item.id !== foreignFolder.body.id));
		assert.ok(files.body.every(item => item.id !== foreignFile.body!.id));
		const foreignChildren = await api('drive/folders', { folderId: foreignFolder.body.id, sort: '-name' }, owner);
		const foreignFiles = await api('drive/files', { folderId: foreignFolder.body.id, sort: '-name' }, owner);
		assert.strictEqual(foreignChildren.status, 200);
		assert.strictEqual(foreignFiles.status, 200);
		assert.deepStrictEqual(foreignChildren.body, []);
		assert.deepStrictEqual(foreignFiles.body, []);
	});

	test('folder name pagination also accepts an id-only cursor', async () => {
		const parent = await api('drive/folders/create', { name: 'legacy-folder-cursor' }, owner);
		assert.strictEqual(parent.status, 200);
		for (const name of ['003', '001', '002', '001']) {
			assert.strictEqual((await api('drive/folders/create', { name, parentId: parent.body.id }, owner)).status, 200);
		}

		const params = { folderId: parent.body.id, sort: '-name' as const };
		const all = await api('drive/folders', { ...params, limit: 100 }, owner);
		assert.deepStrictEqual(all.body.map(folder => folder.name), ['001', '001', '002', '003']);
		const ids: string[] = [];
		let untilId: string | undefined;
		for (;;) {
			const page = await api('drive/folders', { ...params, limit: 2, untilId }, owner);
			assert.strictEqual(page.status, 200);
			if (page.body.length === 0) break;
			ids.push(...page.body.map(folder => folder.id));
			untilId = page.body.at(-1)!.id;
			assert.ok(ids.length <= all.body.length, 'pagination must not repeat items');
		}
		assert.deepStrictEqual(ids, all.body.map(folder => folder.id));
	});

	test('file name and size pagination also accept an id-only cursor', async () => {
		const parent = await api('drive/folders/create', { name: 'legacy-file-cursor' }, owner);
		assert.strictEqual(parent.status, 200);
		for (const name of ['003', '001', '002', '001']) {
			const file = await uploadFile(owner, { name });
			assert.strictEqual(file.status, 200);
			assert.strictEqual((await api('drive/files/update', { fileId: file.body!.id, folderId: parent.body.id }, owner)).status, 200);
		}

		for (const sort of ['-name', '+name', '-size', '+size'] as const) {
			const params = { folderId: parent.body.id, sort };
			const all = await api('drive/files', { ...params, limit: 100 }, owner);
			const ids: string[] = [];
			let untilId: string | undefined;
			for (;;) {
				const page = await api('drive/files', { ...params, limit: 2, untilId }, owner);
				assert.strictEqual(page.status, 200);
				if (page.body.length === 0) break;
				ids.push(...page.body.map(file => file.id));
				untilId = page.body.at(-1)!.id;
				assert.ok(ids.length <= all.body.length, 'pagination must not repeat items');
			}
			assert.deepStrictEqual(ids, all.body.map(file => file.id), sort);
		}
	});
});

// 실제 HTTP 경로를 사용하는 회귀 시험. 전용 일회용 DB/Redis에서만 실행한다.
describe('Confirmed drive deletion', () => {
	let owner: misskey.entities.SignupResponse;
	let other: misskey.entities.SignupResponse;

	beforeAll(async () => {
		await signup({ username: 'delete_bootstrap' });
		owner = await signup({ username: 'delete_owner' });
		other = await signup({ username: 'delete_other' });
	});

	async function folder(name: string, parentId?: string) {
		const result = await api('drive/folders/create', { name, parentId }, owner);
		assert.strictEqual(result.status, 200, JSON.stringify(result.body));
		return result.body;
	}

	async function file(folderId?: string, user = owner) {
		const uploaded = await uploadFile(user, { path: 'drive-delete.png', name: 'drive-delete.png' });
		assert.strictEqual(uploaded.status, 200, JSON.stringify(uploaded.body));
		const created = uploaded.body!;
		if (folderId) {
			const moved = await api('drive/files/update', { fileId: created.id, folderId }, user);
			assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
		}
		return created;
	}

	async function prepare(input: misskey.Endpoints['drive/delete/prepare']['req']) {
		const response = await api('drive/delete/prepare', input, owner);
		assert.strictEqual(response.status, 200, JSON.stringify(response.body));
		return response.body;
	}

	async function execute(operationId: string) {
		const response = await api('drive/delete/execute', { operationId }, owner);
		assert.strictEqual(response.status, 200, JSON.stringify(response.body));
		for (const ids of [response.body.deletedIds, response.body.missingIds, response.body.deletedFolderIds, response.body.missingFolderIds]) {
			assert.deepStrictEqual(ids, [...ids].sort());
		}
		return response.body;
	}

	test('requires credentials and write:drive, and binds confirmation to its owner', async () => {
		const root = await folder('owned');
		assert.strictEqual((await api('drive/delete/prepare', { folderId: root.id })).status, 401);
		const token = await createAppToken(owner, ['read:drive']);
		const denied = await api('drive/delete/prepare', { folderId: root.id }, { token });
		assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
		assert.strictEqual((await api('drive/delete/prepare', { folderId: root.id }, other)).status, 400);
		const writer = await createAppToken(owner, ['write:drive']);
		const allowed = await api('drive/delete/prepare', { folderId: root.id }, { token: writer });
		assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
		const plan = allowed.body;
		assert.strictEqual((await api('drive/delete/execute', { operationId: plan.operationId }, other)).status, 400);
		assert.strictEqual((await api('drive/delete/status', { operationId: plan.operationId }, other)).status, 400);
		assert.strictEqual((await api('drive/folders/show', { folderId: root.id }, owner)).status, 200);
	});

	test('preparation and cancellation do not delete; an empty folder confirms zero and is removed', async () => {
		const root = await folder('empty');
		const plan = await prepare({ folderId: root.id });
		assert.strictEqual(plan.totalCount, 0);
		assert.strictEqual((await api('drive/folders/show', { folderId: root.id }, owner)).status, 200);

		let result!: misskey.Endpoints['drive/delete/execute']['res'];
		const streamed = await waitFire(owner, 'drive', async () => { result = await execute(plan.operationId); }, msg => msg.type === 'folderDeleted' && msg.body === root.id);

		assert.strictEqual(streamed, true);
		assert.strictEqual(result.deletedCount, 0);
		assert.strictEqual(result.folderDeleted, true);
		assert.strictEqual(result.remainingFoldersCount, 0);
		assert.strictEqual((await api('drive/folders/show', { folderId: root.id }, owner)).status, 400);
	});

	test('deletes used selected files while preserving cleaner protection and owner boundaries', async () => {
		const used = await file();
		const foreign = await file(undefined, other);
		await post(owner, { text: 'attachment', fileIds: [used.id] });
		const cleaned = await api('drive/files/delete-bulk', { fileIds: [used.id, foreign.id] }, owner);
		assert.strictEqual(cleaned.status, 200);
		assert.deepStrictEqual(cleaned.body.deletedIds, []);
		const before = await api('drive', {}, owner);
		const plan = await prepare({ fileIds: [used.id, used.id, foreign.id, '0000000000000000'] });
		assert.strictEqual(plan.totalCount, 3);

		let result!: misskey.Endpoints['drive/delete/execute']['res'];
		const streamed = await waitFire(owner, 'drive', async () => { result = await execute(plan.operationId); }, msg => msg.type === 'fileDeleted' && msg.body === used.id);

		assert.strictEqual(streamed, true);
		assert.strictEqual(result.deletedCount, 1);
		assert.strictEqual(result.missingCount, 2);
		assert.strictEqual((await api('drive/files/show', { fileId: used.id }, owner)).status, 400);
		assert.strictEqual((await api('drive/files/show', { fileId: foreign.id }, other)).status, 200);
		const after = await api('drive', {}, owner);
		assert.strictEqual(before.body.usage - after.body.usage, used.size);
		assert.deepStrictEqual(await execute(plan.operationId), result);
	});

	test('counts unloaded files across every nested folder and deletes children first', async () => {
		const root = await folder('tree');
		const child = await folder('child', root.id);
		const grandchild = await folder('grandchild', child.id);
		await folder('empty-child', root.id);
		await file(root.id);
		await file(child.id);
		await file(grandchild.id);
		const plan = await prepare({ folderId: root.id });
		assert.strictEqual(plan.totalCount, 3);
		// 기존 API는 내용 있는 폴더를 계속 거부한다.
		assert.strictEqual((await api('drive/folders/delete', { folderId: root.id }, owner)).status, 400);

		const result = await execute(plan.operationId);

		assert.strictEqual(result.deletedCount, 3);
		assert.strictEqual(result.deletedFolderIds.length, 4);
		assert.strictEqual(result.folderDeleted, true);
		assert.strictEqual(result.remainingCount, 0);
		assert.strictEqual(result.remainingFoldersCount, 0);
	});

	test('processes more than 100 files without a loaded browser list or an oversized delete request', async () => {
		const root = await folder('many');
		for (let i = 0; i < 103; i++) await file(root.id);
		const incoming = await file();
		const plan = await prepare({ folderId: root.id });
		assert.strictEqual(plan.totalCount, 103);

		const [first, added, moved] = await Promise.all([
			execute(plan.operationId),
			file(root.id),
			api('drive/files/update', { fileId: incoming.id, folderId: root.id }, owner),
		]);
		assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
		const observed = await api('drive/delete/status', { operationId: plan.operationId }, owner);
		assert.strictEqual(observed.status, 200);
		assert.deepStrictEqual(observed.body, first);
		const last = await execute(plan.operationId);

		assert.strictEqual(first.deletedCount, 100);
		assert.strictEqual(first.done, false);
		assert.strictEqual(last.deletedCount, 103);
		assert.strictEqual(last.done, true);
		assert.strictEqual(last.folderDeleted, false);
		assert.strictEqual(last.remainingCount, 2);
		assert.strictEqual((await api('drive/files/show', { fileId: added.id }, owner)).body.folderId, root.id);
		assert.strictEqual((await api('drive/files/show', { fileId: incoming.id }, owner)).body.folderId, root.id);
		const retry = await prepare({ folderId: root.id });
		assert.strictEqual(retry.totalCount, 2);
		assert.strictEqual((await execute(retry.operationId)).folderDeleted, true);
	});

	test('preserves new and moved-in files, deletes only confirmed moved-out IDs, and permits reconfirmation', async () => {
		const root = await folder('changing');
		const child = await folder('moving-child', root.id);
		const original = await file(child.id);
		const movedIn = await file();
		const plan = await prepare({ folderId: root.id });
		const added = await file(root.id);
		await api('drive/files/update', { fileId: movedIn.id, folderId: child.id }, owner);
		await api('drive/files/update', { fileId: original.id, folderId: null }, owner);

		const result = await execute(plan.operationId);

		assert.strictEqual(result.totalCount, 1);
		assert.strictEqual(result.deletedCount, 1);
		assert.strictEqual(result.remainingCount, 2);
		assert.strictEqual(result.folderDeleted, false);
		assert.strictEqual((await api('drive/files/show', { fileId: added.id }, owner)).body.folderId, root.id);
		assert.strictEqual((await api('drive/files/show', { fileId: movedIn.id }, owner)).body.folderId, child.id);
		const retry = await prepare({ folderId: root.id });
		assert.strictEqual(retry.totalCount, 2);
		assert.strictEqual((await execute(retry.operationId)).folderDeleted, true);
	});

	test('handles concurrent execute and an already deleted confirmed file without double counts', async () => {
		const first = await file();
		const second = await file();
		const independent = await file(undefined, other);
		const otherPlan = await api('drive/delete/prepare', { fileIds: [independent.id] }, other);
		assert.strictEqual(otherPlan.status, 200, JSON.stringify(otherPlan.body));
		const plan = await prepare({ fileIds: [first.id, second.id] });
		await api('drive/files/delete', { fileId: first.id }, owner);

		const results = await Promise.all([
			api('drive/delete/execute', { operationId: plan.operationId }, owner),
			api('drive/delete/execute', { operationId: plan.operationId }, owner),
			api('drive/delete/execute', { operationId: otherPlan.body.operationId }, other),
		]);
		assert.strictEqual(results[2].status, 200, JSON.stringify(results[2].body));
		assert.strictEqual(results[2].body.deletedCount, 1);
		assert.ok(results.slice(0, 2).some(result => result.status === 200));
		for (const result of results.slice(0, 2)) assert.ok([200, 400].includes(result.status), JSON.stringify(result.body));
		const final = await execute(plan.operationId);

		assert.strictEqual(final.deletedCount, 1);
		assert.strictEqual(final.missingCount, 1);
		assert.strictEqual(final.failedCount, 0);
	});
});
