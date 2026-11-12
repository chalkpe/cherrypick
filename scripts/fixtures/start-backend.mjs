/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { basename } from 'node:path';

const step = {
	'bridge_from_misskey.js': 'bridge',
	'cli.js': 'migration',
	'check_connect.js': 'check',
	'entry.js': 'entry',
}[basename(process.argv[1])];

const event = {
	step,
	pid: process.pid,
	cwd: process.cwd(),
	argv: process.argv.slice(2),
	execArgv: process.execArgv,
	preloaded: process.env.START_FIXTURE_PRELOADED === '1',
	config: process.env.CHERRYPICK_CONFIG_YML,
	bridgeEnabled: process.env.CHERRYPICK_MIGRATION_FROM_MISSKEY,
};

if (step === 'entry' || process.env.START_FIXTURE_WAIT_STEP === step) {
	const keepAlive = setInterval(() => {}, 60_000);
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.on(signal, () => {
			clearInterval(keepAlive);
			console.log(JSON.stringify({ stopped: step, signal }));
			process.exit(0);
		});
	}
}

console.log(JSON.stringify(event));
if (process.env.START_FIXTURE_FAIL_STEP === step) process.exit(23);
