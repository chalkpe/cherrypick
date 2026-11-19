/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

type PathsFn = (id: string) => string;

test('tinyld is loaded from a CDN URL pinned to the installed version', async () => {
	// vite.config.ts を静的に import すると、frontend の型検査に lib/ のビルド用プラグインまで含まれてしまうので動的に読む
	const configPath = '../../vite.config.js';
	const { getConfig } = await import(configPath) as { getConfig: () => { build?: { rolldownOptions?: { output?: { paths?: PathsFn } } } } };
	const paths = getConfig().build?.rolldownOptions?.output?.paths;
	expect(paths).toBeTypeOf('function');

	const installed = JSON.parse(readFileSync(resolve(__dirname, '../../node_modules/tinyld/package.json'), 'utf-8')) as { version: string };
	expect(installed.version).toMatch(/^\d+\.\d+\.\d+$/);

	const url = paths!('tinyld');
	expect(url).toBe(`https://cdn.jsdelivr.net/npm/tinyld@${installed.version}/dist/tinyld.normal.node.mjs`);
	expect(url).not.toMatch(/@[\^~><=*]/);
});
