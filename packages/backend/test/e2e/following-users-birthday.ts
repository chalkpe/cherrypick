/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, initTestDb, signup, successfulApiCall } from '../utils.js';

type User = Awaited<ReturnType<typeof signup>>;

describe('フォロー中のユーザーの誕生日', () => {
	let viewer: User;
	let valid: User;
	let impossibleDay: User;
	let impossibleDate: User;
	let db: Awaited<ReturnType<typeof initTestDb>>;

	const setBirthday = (user: User, birthday: string) => db.query('UPDATE "user_profile" SET "birthday" = $1 WHERE "userId" = $2', [birthday, user.id]);

	beforeAll(async () => {
		viewer = await signup({ username: 'birthdayviewer' });
		valid = await signup({ username: 'birthdayvalid' });
		impossibleDay = await signup({ username: 'birthdayday' });
		impossibleDate = await signup({ username: 'birthdaydate' });
		db = await initTestDb(true);
		// テスト用DBはスキーマ同期だけで作られるため、migrationで入れている関数をここで用意する
		await db.query('CREATE OR REPLACE FUNCTION get_birthday_date(birthday TEXT) RETURNS SMALLINT AS $$ BEGIN RETURN CAST((SUBSTR(birthday, 6, 2) || SUBSTR(birthday, 9, 2)) AS SMALLINT); END; $$ LANGUAGE plpgsql IMMUTABLE;');
		for (const target of [valid, impossibleDay, impossibleDate]) {
			await successfulApiCall({ endpoint: 'following/create', parameters: { userId: target.id }, user: viewer });
		}
		await setBirthday(valid, '2000-08-15');
		await setBirthday(impossibleDay, '2000-06-99');
		await setBirthday(impossibleDate, '2001-02-30');
	});

	afterAll(async () => {
		if (db?.isInitialized) await db.destroy();
	});

	test('日付として成り立たない誕生日のユーザーが混ざっていても、応答は正常で残りのユーザーが出る', async () => {
		const res = await api('users/get-following-users-by-birthday', { birthday: { begin: { month: 1, day: 1 }, end: { month: 12, day: 31 } }, limit: 30 }, viewer);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		const ids = (res.body as any[]).map(x => x.id);
		assert.deepStrictEqual(ids, [valid.id]);
		assert.match((res.body as any[])[0].birthday, /^\d{4}-08-15$/);
	});

	test('日付を指定した取得でも、成り立たない誕生日のユーザーだけが除かれる', async () => {
		const ok = await api('users/get-following-users-by-birthday', { birthday: { month: 8, day: 15 } }, viewer);
		assert.strictEqual(ok.status, 200);
		assert.deepStrictEqual((ok.body as any[]).map(x => x.id), [valid.id]);

		const bad = await api('users/get-following-users-by-birthday', { birthday: { month: 2, day: 30 } }, viewer);
		assert.strictEqual(bad.status, 200, JSON.stringify(bad.body));
		assert.deepStrictEqual(bad.body, []);
	});
});
