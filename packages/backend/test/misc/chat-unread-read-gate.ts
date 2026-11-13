/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import net from 'node:net';
import { once } from 'node:events';

/** Parse one RESP command without consuming a partial network frame. */
function command(buffer: Buffer): { end: number; values: string[] } | null {
	const line = (offset: number) => buffer.indexOf('\r\n', offset);
	const first = line(0);
	if (first < 0) return null;
	if (buffer[0] !== 42) throw new Error('expected a RESP array');
	const count = Number(buffer.toString('utf8', 1, first));
	let offset = first + 2;
	const values: string[] = [];
	for (let i = 0; i < count; i++) {
		const end = line(offset);
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

/** Holds one reader's real Redis read command before forwarding it to the server. */
export async function chatUnreadReadGate(host: string, port: number) {
	const sockets = new Set<net.Socket>();
	let readerId: string | null = null;
	let releaseHeld: (() => void) | null = null;
	const server = net.createServer(client => {
		const upstream = net.createConnection({ host, port });
		sockets.add(client);
		sockets.add(upstream);
		let input = Buffer.alloc(0);
		let blocked = false;
		const pump = () => {
			while (!blocked) {
				const parsed = command(input);
				if (parsed == null) return;
				const raw = input.subarray(0, parsed.end);
				input = input.subarray(parsed.end);
				const matches = readerId != null && parsed.values[0]?.toUpperCase() === 'EVAL'
					&& parsed.values[1]?.startsWith('-- read chat unread\n')
					&& parsed.values[3]?.includes(`:${readerId}:`);
				if (matches) {
					readerId = null;
					blocked = true;
					client.pause();
					releaseHeld = () => {
						releaseHeld = null;
						blocked = false;
						upstream.write(raw);
						pump();
						client.resume();
					};
					return;
				}
				upstream.write(raw);
			}
		};
		client.on('data', data => { input = Buffer.concat([input, Buffer.from(data)]); pump(); });
		upstream.on('data', data => client.write(data));
		client.on('close', () => { sockets.delete(client); upstream.destroy(); });
		upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address == null || typeof address === 'string') throw new Error('read gate did not bind a TCP port');
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
