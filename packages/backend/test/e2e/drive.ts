/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, test } from 'vitest';
import { api, makeStreamCatcher, post, signup, uploadFile } from '../utils.js';
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
