/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import net from 'node:net';
import { once } from 'node:events';

function command(buffer: Buffer): { end: number; values: string[] } | null {
	const first = buffer.indexOf('\r\n');
	if (first < 0) return null;
	if (buffer[0] !== 42) throw new Error('expected a RESP array');
	const count = Number(buffer.toString('utf8', 1, first));
	let offset = first + 2;
	const values: string[] = [];
	for (let i = 0; i < count; i++) {
		const end = buffer.indexOf('\r\n', offset);
		if (end < 0) return null;
		if (buffer[offset] !== 36) throw new Error('expected a RESP bulk string');
		const size = Number(buffer.toString('utf8', offset + 1, end));
		const start = end + 2;
		if (buffer.length < start + size + 2) return null;
		values.push(buffer.toString('utf8', start, start + size));
		offset = start + size + 2;
	}
	return { end: offset, values };
}

function encode(values: string[]): Buffer {
	return Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values.flatMap(value => {
		const data = Buffer.from(value);
		return [Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n')];
	})]);
}

/** Makes Redis return an error for one matching unread script without executing it. */
export async function chatUnreadSettleFailureGate(host: string, port: number) {
	const sockets = new Set<net.Socket>();
	let readerId: string | null = null;
	let operation: 'settle' | 'clear' = 'settle';
	let failures = 0;
	const server = net.createServer(client => {
		const upstream = net.createConnection({ host, port });
		sockets.add(client);
		sockets.add(upstream);
		let input = Buffer.alloc(0);
		client.on('data', data => {
			input = Buffer.concat([input, Buffer.from(data)]);
			for (;;) {
				const parsed = command(input);
				if (parsed == null) return;
				const raw = input.subarray(0, parsed.end);
				input = input.subarray(parsed.end);
				const matches = readerId != null && parsed.values[0]?.toUpperCase() === 'EVAL'
					&& parsed.values[1]?.startsWith(`-- ${operation} chat unread\n`)
					&& parsed.values[3]?.includes(`:${readerId}:`);
				if (matches) {
					readerId = null;
					failures++;
					parsed.values[1] = "return redis.error_reply('injected unread failure')";
					upstream.write(encode(parsed.values));
				} else {
					upstream.write(raw);
				}
			}
		});
		upstream.on('data', data => client.write(data));
		client.on('close', () => { sockets.delete(client); upstream.destroy(); });
		upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address == null || typeof address === 'string') throw new Error('settle failure gate did not bind a TCP port');
	return {
		port: address.port,
		arm(id: string, nextOperation: 'settle' | 'clear' = 'settle') { readerId = id; operation = nextOperation; },
		get failures() { return failures; },
		async close() {
			for (const socket of sockets) socket.destroy();
			server.close();
			await once(server, 'close');
		},
	};
}
