/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

type Run = {
	type: 'run';
	main: RedisOptions;
	pubsub: RedisOptions;
	channel: string;
	message: string;
	now: number;
};
type Command = Run | { type: 'publish' | 'acknowledge' };
const moduleUrl = new URL('../../src/core/recording-event.ts', import.meta.url);
const scripts = await import(moduleUrl.href) as Record<string, string>;
const waiting = new Map<string, () => void>();
const arrived = new Set<string>();

function waitFor(phase: string): Promise<void> {
	if (arrived.delete(phase)) return Promise.resolve();
	return new Promise(resolve => { waiting.set(phase, resolve); });
}

async function run(command: Run): Promise<void> {
	const main = new Redis(command.main);
	const pubsub = new Redis(command.pubsub);
	try {
		const prepared = await main.eval(scripts.PREPARE_RECORDING_PUBLICATION_SCRIPT, 3, 'seen', 'flags', 'pending',
			'event', 1, command.now, command.now + 3_600_000, 4096);
		process.send?.({ type: 'prepared', result: prepared });
		await waitFor('publish');
		const published = prepared === 0 ? 0 : await pubsub.eval(scripts.PUBLISH_RECORDING_EVENT_SCRIPT, 1, 'published',
			'event', 1, command.now, command.now + 3_600_000, 4096, JSON.stringify([command.message]), command.channel);
		process.send?.({ type: 'published', result: published });
		await waitFor('acknowledge');
		if (prepared !== 0) await main.eval(scripts.ACK_RECORDING_PUBLICATION_SCRIPT, 2, 'flags', 'pending', 'event', 1);
		process.send?.({ type: 'completed' });
	} finally {
		main.disconnect();
		pubsub.disconnect();
	}
}

process.on('message', (command: Command) => {
	if (command.type === 'run') {
		void run(command).catch(error => { process.send?.({ type: 'error', message: String(error) }); });
		return;
	}
	const resolve = waiting.get(command.type);
	if (resolve) { waiting.delete(command.type); resolve(); }
	else arrived.add(command.type);
});
process.send?.({ type: 'ready' });
