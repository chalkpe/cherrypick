/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonStreamingService } from '@/server/api/mastodon/MastodonStreamingService.js';
import MainStreamConnection from '@/server/api/stream/Connection.js';
import type { WebSocket } from 'ws';

async function connect(user: { id: string } | null = null) {
	const sent: { status?: number }[] = [];
	const forwarded: { type: string; body: { id: string } }[] = [];
	const ws = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		send: (raw: string) => sent.push(JSON.parse(raw)),
		terminate: () => { ws.readyState = 3; },
	});
	let bridgeSocket: WebSocket;
	const service = new MastodonStreamingService(
		new EventEmitter() as never, {} as never, {} as never, {} as never, {} as never,
		{ getLogger: () => ({ error: () => {} }) } as never,
	);
	const connection = {
		listen: async (_events: EventEmitter, socket: EventEmitter) => {
			bridgeSocket = socket as WebSocket;
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
	return { send, sent, forwarded, ws, bridgeSocket: bridgeSocket! };
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

describe('Mastodon streaming backpressure', () => {
	test('disconnects a slow client before sending a Mastodon response', async () => {
		const { send, sent, ws } = await connect();
		ws.bufferedAmount = 8 * 1024 * 1024;
		send({ type: 'subscribe', stream: 'unknown' });
		expect(ws.readyState).toBe(3);
		expect(sent).toEqual([]);
	});

	test.each([
		{ name: 'a slow client', bufferedAmount: 8 * 1024 * 1024, payload: 'message' },
		{ name: 'an oversized event', bufferedAmount: 0, payload: 'x'.repeat(8 * 1024 * 1024) },
	])('disconnects $name through the Misskey connection', async ({ bufferedAmount, payload }) => {
		const { sent, ws, bridgeSocket } = await connect();
		const connection = new MainStreamConnection(
			{} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
			{ user: null, token: null },
		);
		await connection.listen(new EventEmitter(), bridgeSocket);
		onTestFinished(() => connection.dispose());
		ws.bufferedAmount = bufferedAmount;
		connection.sendMessageToWs('test', { text: payload });
		expect(ws.readyState).toBe(3);
		expect(sent).toEqual([]);
	});
});
