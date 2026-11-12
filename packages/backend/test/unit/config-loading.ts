/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('configuration loading', () => {
	let directory: string;
	let filename: string;
	let source: string;

	beforeEach(() => {
		vi.resetModules();
		directory = mkdtempSync(join(tmpdir(), 'cherrypick-config-'));
		filename = join(directory, 'custom.yml');
		source = readFileSync(new URL('../../../../.github/cherrypick/test.yml', import.meta.url), 'utf8');
		writeFileSync(filename, source);
		vi.stubEnv('CHERRYPICK_CONFIG_YML', filename);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	test('reads the CherryPick configuration file directly without a compiled JSON copy', async () => {
		const config = await import('@/config.js');

		expect(config.path).toBe(filename);
		expect(config.loadConfig().url).toBe('http://cherrypick.local');
	});

	test.each([0, -1, '.nan', '.inf', '"two"'])('rejects invalid job concurrency %s before startup', async value => {
		writeFileSync(filename, `${source}\ndeliverJobConcurrency: ${value}\n`);
		const config = await import('@/config.js');

		expect(() => config.loadConfig()).toThrow('deliverJobConcurrency=');
	});

	test('uses test.yml in test mode when no custom path is set', async () => {
		vi.stubEnv('CHERRYPICK_CONFIG_YML', '');
		vi.stubEnv('NODE_ENV', 'test');
		const config = await import('@/config.js');

		expect(config.path).toMatch(/[/\\]\.config[/\\]test\.yml$/);
	});
});
