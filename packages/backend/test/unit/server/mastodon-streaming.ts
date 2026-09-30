/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonStreamingService } from '@/server/api/mastodon/MastodonStreamingService.js';

async function connect(user: { id: string } | null = null) {
	const sent: { status?: number }[] = [];
	const forwarded: { type: string; body: { id: string } }[] = [];
	const ws = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) });
	const service = new MastodonStreamingService(
		new EventEmitter() as never, {} as never, {} as never, {} as never, {} as never,
		{ getLogger: () => ({ error: () => {} }) } as never,
	);
	const connection = {
		listen: async (_events: EventEmitter, socket: EventEmitter) => {
			socket.on('message', raw => forwarded.push(JSON.parse(raw.toString())));
		},
		dispose: () => {},
	};
	onTestFinished(() => {
		ws.emit('close');
		service.onApplicationShutdown();
	});
	await service['onConnection'](ws as never, connection as never, user as never, new URLSearchParams());
	const send = (message: unknown) => ws.emit('message', Buffer.from(JSON.stringify(message)));
	return { send, sent, forwarded };
}

describe('Mastodon streaming input limits', () => {
	test('bounds anonymous subscriptions and releases capacity on unsubscribe', async () => {
		const { send, sent, forwarded } = await connect();
		for (let i = 0; i < 40; i++) send({ type: 'subscribe', stream: 'hashtag', tag: `tag${i}` });
		expect(forwarded.filter(m => m.type === 'connect')).toHaveLength(32);
		expect(sent.at(-1)?.status).toBe(429);
		send({ type: 'unsubscribe', stream: 'hashtag', tag: 'tag0' });
		send({ type: 'subscribe', stream: 'hashtag', tag: 'replacement' });
		expect(forwarded.filter(m => m.type === 'connect')).toHaveLength(33);
	});

	test('counts both channels of the user stream before accepting it', async () => {
		const { send, sent, forwarded } = await connect({ id: 'user' });
		for (let i = 0; i < 31; i++) send({ type: 'subscribe', stream: 'hashtag', tag: `tag${i}` });
		send({ type: 'subscribe', stream: 'user' });
		expect(forwarded.filter(m => m.type === 'connect')).toHaveLength(31);
		expect(sent.at(-1)?.status).toBe(429);
		send({ type: 'unsubscribe', stream: 'hashtag', tag: 'tag0' });
		send({ type: 'subscribe', stream: 'user' });
		expect(forwarded.filter(m => m.type === 'connect')).toHaveLength(33);
	});

	test('ignores malformed JSON values without throwing from the socket listener', async () => {
		const { send, forwarded } = await connect();
		for (const value of [null, [], 1, true, 'hello']) expect(() => send(value)).not.toThrow();
		send({ type: 'subscribe', stream: 'public:local' });
		expect(forwarded).toHaveLength(1);
	});
});
