/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { assert, test } from 'vitest';
import { transform } from 'lightningcss';
import { getConfig } from '../../vite.config.js';

// Vite が esbuild 形式の target ('ios18.2' など) を lightningcss の targets に直すのと同じ変換
function toLightningcssTargets(targets: string[]): Record<string, number> {
	const names: Record<string, string> = { chrome: 'chrome', edge: 'edge', firefox: 'firefox', ios: 'ios_saf', opera: 'opera', safari: 'safari' };
	const result: Record<string, number> = {};
	for (const target of targets) {
		const match = /^([a-z]+)(\d+)(?:\.(\d+))?/.exec(target);
		if (match == null || names[match[1]] == null) continue;
		result[names[match[1]]] = (Number(match[2]) << 16) | (Number(match[3] ?? 0) << 8);
	}
	return result;
}

// iOS Safari は接頭辞付きの -webkit-text-size-adjust しか解釈しない。
// CSS の target に iOS が無いと lightningcss が不要な接頭辞として削り、iOS で横向きにしたときに本文が自動拡大される。
test('production CSS keeps -webkit-text-size-adjust for iOS Safari', () => {
	const config = getConfig();
	const cssTarget = ([] as string[]).concat(config.build?.cssTarget ?? config.build?.target ?? []);
	const { code } = transform({
		filename: 'style.css',
		code: Buffer.from('html { text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }'),
		minify: true,
		targets: toLightningcssTargets(cssTarget),
	});
	assert.include(code.toString(), '-webkit-text-size-adjust:100%', `cssTarget=${JSON.stringify(cssTarget)}`);
});
