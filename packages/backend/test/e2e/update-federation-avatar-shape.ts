/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { beforeAll, describe, test } from 'vitest';
import { api, failedApiCall, role, signup, successfulApiCall } from '../utils.js';

type User = Awaited<ReturnType<typeof signup>>;

describe('連合アバターの形の設定', () => {
	let root: User;
	let allowed: User;
	let restricted: User;

	const shapeOf = async (user: User) => (await successfulApiCall({ endpoint: 'i', parameters: {}, user })).setFederationAvatarShape ?? false;

	beforeAll(async () => {
		root = await signup({ username: 'shaperoot' });
		allowed = await signup({ username: 'shapeallowed' });
		restricted = await signup({ username: 'shaperestricted' });
		const noShape = await role(root, { name: 'no federation avatar shape' }, {
			canSetFederationAvatarShape: { priority: 0, useDefault: false, value: false },
		});
		await api('admin/roles/assign', { userId: restricted.id, roleId: noShape.id }, root);
	});

	test('設定の権限のないユーザーが有効にする要求は拒否される', async () => {
		await failedApiCall({ endpoint: 'i/update', parameters: { setFederationAvatarShape: true }, user: restricted }, {
			status: 400,
			code: 'RESTRICTED_BY_ROLE',
			id: '8feff0ba-5ab5-585b-31f4-4df816663fad',
		});
		assert.strictEqual(await shapeOf(restricted), false);
	});

	test('設定の権限のないユーザーが無効にする要求は受け付ける', async () => {
		await successfulApiCall({ endpoint: 'i/update', parameters: { setFederationAvatarShape: false }, user: restricted });
		assert.strictEqual(await shapeOf(restricted), false);
	});

	test('権限のあるユーザーは有効にして保存できる', async () => {
		await successfulApiCall({ endpoint: 'i/update', parameters: { setFederationAvatarShape: true }, user: allowed });
		assert.strictEqual(await shapeOf(allowed), true);
		await successfulApiCall({ endpoint: 'i/update', parameters: { setFederationAvatarShape: false }, user: allowed });
		assert.strictEqual(await shapeOf(allowed), false);
	});

	test('設定の権限のないユーザーでも、他の項目の更新は受け付ける', async () => {
		const me = await successfulApiCall({ endpoint: 'i/update', parameters: { isSquareAvatars: true }, user: restricted });
		assert.strictEqual(me.isSquareAvatars, true);
	});
});
