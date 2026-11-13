/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import net from 'node:net';
import { once } from 'node:events';

type Value = string | null | Value[];

/** Parse a complete RESP2 frame, leaving incomplete frames buffered. */
function frame(buffer: Buffer, offset = 0): { end: number; value: Value } | null {
	const lineEnd = buffer.indexOf('\r\n', offset);
	if (lineEnd < 0) return null;
	const kind = String.fromCharCode(buffer[offset]);
	const text = buffer.toString('utf8', offset + 1, lineEnd);
	let end = lineEnd + 2;
	if (kind === '$') {
		const size = Number(text);
		if (size < 0) return { end, value: null };
		if (buffer.length < end + size + 2) return null;
		return { end: end + size + 2, value: buffer.toString('utf8', end, end + size) };
	}
	if (kind === '*') {
		const count = Number(text);
		if (count < 0) return { end, value: null };
		const values: Value[] = [];
		for (let i = 0; i < count; i++) {
			const child = frame(buffer, end);
			if (child == null) return null;
			values.push(child.value);
			end = child.end;
		}
		return { end, value: values };
	}
	if (kind === '+' || kind === '-' || kind === ':') return { end, value: text };
	throw new Error(`unexpected RESP frame ${kind}`);
}

/** Holds one real Redis mark reply, after Redis has executed the command. */
export async function chatUnreadMarkGate(host: string, port: number) {
	const sockets = new Set<net.Socket>();
	let readerId: string | null = null;
	let releaseHeld: (() => void) | null = null;
	const server = net.createServer(client => {
		const upstream = net.createConnection({ host, port });
		sockets.add(client);
		sockets.add(upstream);
		let commands = Buffer.alloc(0);
		let replies = Buffer.alloc(0);
		let blocked = false;
		const waiting: boolean[] = [];
		const pumpReplies = () => {
			while (!blocked) {
				const parsed = frame(replies);
				if (parsed == null) return;
				const raw = replies.subarray(0, parsed.end);
				replies = replies.subarray(parsed.end);
				if (waiting.shift()) {
					blocked = true;
					upstream.pause();
					releaseHeld = () => {
						releaseHeld = null;
						blocked = false;
						client.write(raw);
						pumpReplies();
						upstream.resume();
					};
					return;
				}
				client.write(raw);
			}
		};
		client.on('data', data => {
			commands = Buffer.concat([commands, Buffer.from(data)]);
			for (;;) {
				const parsed = frame(commands);
				if (parsed == null) return;
				const values = Array.isArray(parsed.value) ? parsed.value : [];
				const match = readerId != null && typeof values[0] === 'string' && values[0].toUpperCase() === 'EVAL'
					&& typeof values[1] === 'string' && values[1].startsWith('-- mark chat unread\n')
					&& typeof values[3] === 'string' && values[3].includes(`:${readerId}:`);
				if (match) readerId = null;
				waiting.push(match);
				upstream.write(commands.subarray(0, parsed.end));
				commands = commands.subarray(parsed.end);
			}
		});
		upstream.on('data', data => { replies = Buffer.concat([replies, Buffer.from(data)]); pumpReplies(); });
		client.on('close', () => { sockets.delete(client); upstream.destroy(); });
		upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address == null || typeof address === 'string') throw new Error('mark gate did not bind a TCP port');
	return {
		port: address.port,
		arm(id: string) { readerId = id; },
		get held() { return releaseHeld != null; },
		release() { releaseHeld?.(); },
		async close() {
			for (const socket of sockets) socket.destroy();
			server.close();
			await once(server, 'close');
		},
	};
}
