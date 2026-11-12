/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function startFixture(t, args = [], env = {}, nodeArgs = []) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'cherrypick-start-')));
	const backend = join(root, 'packages/backend');
	await mkdir(join(root, 'scripts'), { recursive: true });
	await mkdir(join(backend, 'scripts'), { recursive: true });
	await mkdir(join(backend, 'built'), { recursive: true });
	await mkdir(join(backend, 'node_modules/typeorm'), { recursive: true });
	await writeFile(join(backend, 'package.json'), '{"type":"module"}');
	await writeFile(join(backend, 'node_modules/typeorm/package.json'), '{"type":"module"}');
	await copyFile(new URL('./start.mjs', import.meta.url), join(root, 'scripts/start.mjs'));
	await copyFile(new URL('./fixtures/start-preload.mjs', import.meta.url), join(root, 'preload module.mjs'));
	for (const path of ['scripts/bridge_from_misskey.js', 'scripts/check_connect.js', 'node_modules/typeorm/cli.js', 'built/entry.js']) {
		await copyFile(new URL('./fixtures/start-backend.mjs', import.meta.url), join(backend, path));
	}

	const child = spawn(process.execPath, [...nodeArgs, 'scripts/start.mjs', ...args], {
		cwd: root,
		env: { ...process.env, NODE_OPTIONS: '', ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const closed = once(child, 'close');
	const events = [];
	let pending = '';
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
	child.stdout.setEncoding('utf8').on('data', text => {
		pending += text;
		let newline;
		while ((newline = pending.indexOf('\n')) !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			events.push(JSON.parse(line));
			child.emit('fixture-event');
		}
	});
	t.after(async () => {
		if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
		await closed;
		await rm(root, { recursive: true, force: true });
	});

	async function waitForStep(step) {
		while (!events.some(event => event.step === step)) {
			assert.equal(child.exitCode, null, stderr);
			await Promise.race([
				once(child, 'fixture-event', { signal: t.signal }),
				closed.then(() => { throw new Error(`Exited before ${step}: ${stderr}`); }),
			]);
		}
	}

	return { child, closed, events, backend, waitForStep };
}

test('starts after the connection check and preserves runtime options and CherryPick environment', { timeout: 10_000 }, async t => {
	const fixture = await startFixture(t, [], {
		NODE_OPTIONS: '--import "./preload module.mjs"',
		CHERRYPICK_CONFIG_YML: 'custom.yml',
	}, ['--max-old-space-size=128']);
	await fixture.waitForStep('entry');

	assert.deepEqual(fixture.events.map(event => event.step), ['check', 'entry']);
	for (const event of fixture.events) {
		assert.equal(event.cwd, fixture.backend);
		assert.equal(event.preloaded, true);
		assert.equal(event.config, 'custom.yml');
	}
	const entry = fixture.events.at(-1);
	assert.ok(entry.execArgv.includes('--max-old-space-size=128'));
	if (process.platform !== 'win32') assert.equal(entry.pid, fixture.child.pid);
});

test('runs the CherryPick bridge before TypeORM and starts only after migration', { timeout: 10_000 }, async t => {
	const fixture = await startFixture(t, ['--migrate'], { CHERRYPICK_MIGRATION_FROM_MISSKEY: '1' });
	await fixture.waitForStep('entry');

	assert.deepEqual(fixture.events.map(event => event.step), ['bridge', 'migration', 'check', 'entry']);
	assert.equal(fixture.events[0].bridgeEnabled, '1');
	assert.deepEqual(fixture.events[1].argv, ['migration:run', '-d', 'ormconfig.js']);
});

for (const step of ['bridge', 'migration', 'check']) {
	test(`stops when ${step} fails`, { timeout: 10_000 }, async t => {
		const fixture = await startFixture(t, ['--migrate'], { START_FIXTURE_FAIL_STEP: step });
		const [code] = await fixture.closed;

		assert.equal(code, 23);
		assert.equal(fixture.events.at(-1).step, step);
		assert.ok(!fixture.events.some(event => event.step === 'entry'));
	});
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	test(`forwards ${signal} during preprocessing and prevents startup`, { timeout: 10_000, skip: process.platform === 'win32' }, async t => {
		const fixture = await startFixture(t, ['--migrate'], { START_FIXTURE_WAIT_STEP: 'bridge' });
		await fixture.waitForStep('bridge');

		fixture.child.kill(signal);
		await fixture.closed;

		assert.deepEqual(fixture.events.filter(event => event.step).map(event => event.step), ['bridge']);
		assert.ok(fixture.events.some(event => event.stopped === 'bridge' && event.signal === signal));
	});
}

test('terminates the application with SIGTERM', { timeout: 10_000 }, async t => {
	const fixture = await startFixture(t);
	await fixture.waitForStep('entry');

	fixture.child.kill('SIGTERM');
	await fixture.closed;

	assert.ok(fixture.events.some(event => event.stopped === 'entry' && event.signal === 'SIGTERM'));
});
