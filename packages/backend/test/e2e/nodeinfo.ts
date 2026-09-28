/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, test } from 'vitest';
import { relativeFetch } from '../utils.js';

describe('nodeinfo', () => {
	test('nodeinfo 2.1', async () => {
		const res = await relativeFetch('nodeinfo/2.1');
		assert.ok(res.ok);
		assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');

		const nodeInfo = await res.json() as any;
		assert.strictEqual(nodeInfo.software.name, 'cherrypick');
		assert.strictEqual(nodeInfo.software.version, '2026.9.1+choco.3');
		assert.strictEqual(nodeInfo.software.repository, 'https://github.com/chalkpe/cherrypick');
	});

	test('nodeinfo 2.0', async () => {
		const res = await relativeFetch('nodeinfo/2.0');
		assert.ok(res.ok);
		assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');

		const nodeInfo = await res.json() as any;
		assert.strictEqual(nodeInfo.software.name, 'cherrypick');
	});
});
