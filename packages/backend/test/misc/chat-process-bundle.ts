/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { version as summalyVersion } from '@misskey-dev/summaly';
import { rolldown } from 'rolldown';
import { esmShimPlugin } from '../../lib/esm-shim.js';

/** Builds isolated child processes for the chat tests that start separate servers or queue workers. */
export async function buildChatProcessFixtures(): Promise<{ sender: string; queue: string; dispose: () => Promise<void> }> {
	const directory = await mkdtemp(join(process.cwd(), '.chat-process-fixtures-'));
	try {
		const bundle = await rolldown({
			input: ['./test/misc/chat-send-process-fixture.ts', './test/misc/chat-queue-process-fixture.ts'],
			platform: 'node',
			tsconfig: './test-server/tsconfig.json',
			plugins: [esmShimPlugin()],
			transform: { define: { _SUMMALY_VERSION_: JSON.stringify(summalyVersion) } },
			external: /^(?!@\/|\0)[^.\/](?!:[\/\\])/,
		});
		try {
			await bundle.write({ dir: directory, format: 'esm', keepNames: true, sourcemap: true });
		} finally {
			await bundle.close();
		}
		return {
			sender: join(directory, 'chat-send-process-fixture.js'),
			queue: join(directory, 'chat-queue-process-fixture.js'),
			dispose: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
