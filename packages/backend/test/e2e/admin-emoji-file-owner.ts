/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, afterAll, test } from 'vitest';
import { api, initTestDb, port, signup, uploadFile } from '../utils.js';
import type * as Misskey from 'cherrypick-js';

describe('커스텀 이모지 등록·수정의 파일 소유자', () => {
	let root: Misskey.entities.SignupResponse;
	let alice: Misskey.entities.SignupResponse;
	let bob: Misskey.entities.SignupResponse;

	let db: Awaited<ReturnType<typeof initTestDb>>;

	// 이모지 등록은 파일 URL을 내려받아 다시 올리므로, 시험 환경에서 이름을 풀 수 없는 설정상의 호스트를
	// 시험 서버 자신의 주소로 바꿔 둔다
	const upload = async (user: Misskey.entities.SignupResponse, name: string): Promise<Misskey.entities.DriveFile> => {
		const res = await uploadFile(user, { name });
		assert.strictEqual(res.status, 200);
		assert.ok(res.body);
		const url = new URL(res.body.url);
		const reachable = `http://127.0.0.1:${port}${url.pathname}`;
		await db.query('UPDATE "drive_file" SET "url" = $1 WHERE "id" = $2', [reachable, res.body.id]);
		return res.body;
	};

	const fileExists = async (user: Misskey.entities.SignupResponse, fileId: string): Promise<boolean> => {
		const res = await api('drive/files/show', { fileId }, user);
		return res.status === 200;
	};

	beforeAll(async () => {
		db = await initTestDb(true);
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
	});

	afterAll(async () => {
		if (db?.isInitialized) await db.destroy();
	});

	test('다른 사용자가 올린 파일로 관리자가 이모지를 등록할 수 있고 원본 파일은 남는다', async () => {
		const file = await upload(alice, 'owner-add.jpg');

		const res = await api('admin/emoji/add', { name: 'owner_add', fileId: file.id }, root);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		const list = await api('admin/emoji/list', { query: 'owner_add' }, root);
		assert.strictEqual(list.status, 200);
		const emoji = list.body.find(e => e.name === 'owner_add');
		assert.ok(emoji);
		// 서버가 다시 올린 사본이어야 하며, 올린 사람의 파일 URL을 그대로 쓰지 않는다
		assert.notStrictEqual(emoji.url, file.url);

		assert.strictEqual(await fileExists(alice, file.id), true);
	});

	test('이모지의 파일을 다른 사용자 소유 파일로 바꿀 수 있고 원본 파일은 남는다', async () => {
		const first = await upload(root, 'owner-update-1.jpg');
		const added = await api('admin/emoji/add', { name: 'owner_update', fileId: first.id }, root);
		assert.strictEqual(added.status, 200, JSON.stringify(added.body));

		const list = await api('admin/emoji/list', { query: 'owner_update' }, root);
		const emoji = list.body.find(e => e.name === 'owner_update');
		assert.ok(emoji);
		// 본인 소유 파일로 등록했으므로 원본 파일은 지워진다
		assert.strictEqual(await fileExists(root, first.id), false);

		const second = await upload(bob, 'owner-update-2.jpg');
		const res = await api('admin/emoji/update', { id: emoji.id, name: 'owner_update', fileId: second.id }, root);
		assert.strictEqual(res.status, 204, JSON.stringify(res.body));

		const after = await api('admin/emoji/list', { query: 'owner_update' }, root);
		const updated = after.body.find(e => e.id === emoji.id);
		assert.ok(updated);
		assert.notStrictEqual(updated.url, emoji.url);
		assert.strictEqual(await fileExists(bob, second.id), true);
	});
});
