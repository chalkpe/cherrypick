/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import { expect, test } from 'vitest';
import { recordServerCoverage } from '../../test-server/coverage.js';

test('the installed coverage provider reads the recorded server coverage from disk', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'backend coverage '));
	try {
		const provider = new V8CoverageProvider();
		provider.coverageFilesDirectory = directory;
		provider.options = { ...provider.options, processingConcurrency: 1 };
		provider.ctx = { getProjectByName: () => ({ name: 'backend' }) } as unknown as typeof provider.ctx;
		const chunks = [{
			scriptId: '1',
			url: 'file:///server.js',
			functions: [{ functionName: 'handler', ranges: [{ startOffset: 0, endOffset: 12, count: 3 }], isBlockCoverage: true }],
			startOffset: 0,
		}];

		await recordServerCoverage(provider, chunks, 'backend');

		const results: unknown[] = [];
		await provider.readCoverageFiles({
			onFileRead: data => results.push(data),
			onFinished: async () => {},
			onDebug: Object.assign(() => {}, { enabled: false }),
		});
		expect(results).toEqual([{ result: chunks }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
