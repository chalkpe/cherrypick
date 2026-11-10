/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { RoomServiceClient } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { expect, test } from 'vitest';

const serverUrl = process.env.VOICE_CALL_TEST_SERVER;
const adminFile = process.env.VOICE_CALL_TEST_ADMIN;
const livekitFile = process.env.VOICE_CALL_LIVEKIT_CREDENTIALS;
const require = createRequire(import.meta.url);
const { SignalRequest, SignalResponse, LeaveRequest, DisconnectReason, LeaveRequest_Action } = createRequire(require.resolve('livekit-server-sdk'))('@livekit/protocol');
type Account = { id: string; token: string };
type Credentials = { url: string; apiKey: string; apiSecret: string };

async function api<T>(endpoint: string, body: Record<string, unknown>, token?: string): Promise<T> {
	const response = await fetch(new URL(`/api/${endpoint}`, serverUrl), {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(token ? { i: token } : {}) }), signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new Error(`${endpoint} failed with HTTP ${response.status}`);
	return response.status === 204 ? undefined as T : await response.json() as T;
}

function connect(baseUrl: string, token: string): Promise<{ socket: WebSocket; accepted: boolean }> {
	const endpoint = new URL(`${baseUrl}/rtc`);
	endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
	for (const [key, value] of Object.entries({ access_token: token, protocol: '16', sdk: 'js', version: '2.23.0', auto_subscribe: '0' })) endpoint.searchParams.set(key, value);
	const socket = new WebSocket(endpoint);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('Call signaling timed out')); }, 10000);
		const finish = (accepted: boolean) => { clearTimeout(timer); resolve({ socket, accepted }); };
		socket.once('error', () => { clearTimeout(timer); reject(new Error('Call signaling failed')); });
		socket.once('unexpected-response', (_request, response) => { response.resume(); finish(false); });
		socket.on('message', data => {
			const message = SignalResponse.fromBinary(new Uint8Array(data as Buffer)).message;
			if (message.case === 'join') finish(true);
			if (message.case === 'leave') finish(false);
		});
	});
}

test.skipIf(!serverUrl || !adminFile || !livekitFile)('real call APIs enforce the owner-inclusive limit and apply changes to new calls', async () => {
	const admin = JSON.parse(readFileSync(adminFile!, 'utf8')) as Account;
	const credentials = JSON.parse(readFileSync(livekitFile!, 'utf8')) as Credentials;
	const rooms = new RoomServiceClient(credentials.url, credentials.apiKey, credentials.apiSecret);
	const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
	const members: Account[] = [admin];
	const sockets: WebSocket[] = [];
	const roomIds: string[] = [];
	let limitChanged = false;
	try {
		const current = await api<{ voiceCallMaxParticipants?: number }>('admin/meta', {}, admin.token);
		if (current.voiceCallMaxParticipants !== undefined) {
			await api('admin/update-meta', { voiceCallMaxParticipants: 10 }, admin.token);
			limitChanged = true;
		}
		for (let index = 0; index < 10; index++) {
			members.push(await api<Account>('admin/accounts/create', { username: `v${suffix}${index}`, password: 'test-password-12345' }, admin.token));
		}
		for (const member of members) await api('i/update', { chatScope: 'everyone' }, member.token);
		const room = await api<{ id: string }>('chat/rooms/create', { name: 'test room' }, admin.token);
		roomIds.push(room.id);
		for (const member of members.slice(1)) {
			await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, admin.token);
			await api('chat/rooms/join', { roomId: room.id }, member.token);
		}
		await api('chat/rooms/voice/connection-info', { roomId: room.id }, admin.token);
		expect((await rooms.listRooms([`chatRoom:${room.id}`]))[0].maxParticipants).toBe(10);
		const connections: { url: string; token: string }[] = [];
		for (const member of members) connections.push(await api('chat/rooms/voice/join', { roomId: room.id }, member.token));
		for (const connection of connections.slice(0, 10)) {
			const result = await connect(connection.url, connection.token);
			sockets.push(result.socket);
			expect(result.accepted).toBe(true);
		}
		expect(await rooms.listParticipants(`chatRoom:${room.id}`)).toHaveLength(10);
		const extra = await connect(connections[10].url, connections[10].token);
		sockets.push(extra.socket);
		expect(extra.accepted).toBe(false);

		await api('admin/update-meta', { voiceCallMaxParticipants: 25 }, admin.token);
		await api('chat/rooms/voice/connection-info', { roomId: room.id }, admin.token);
		expect((await rooms.listRooms([`chatRoom:${room.id}`]))[0].maxParticipants).toBe(10);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Departing session did not close')), 10000);
			sockets[0].once('close', () => { clearTimeout(timer); resolve(); });
			sockets[0].send(new SignalRequest({ message: { case: 'leave', value: new LeaveRequest({ reason: DisconnectReason.CLIENT_INITIATED, action: LeaveRequest_Action.DISCONNECT }) } }).toBinary());
		});
		const returning = await api<{ url: string; token: string }>('chat/rooms/voice/join', { roomId: room.id }, admin.token);
		const again = await connect(returning.url, returning.token);
		sockets.push(again.socket);
		expect(again.accepted).toBe(true);

		const next = await api<{ id: string }>('chat/rooms/create', { name: 'another test room' }, admin.token);
		roomIds.push(next.id);
		await api('chat/rooms/voice/connection-info', { roomId: next.id }, admin.token);
		expect((await rooms.listRooms([`chatRoom:${next.id}`]))[0].maxParticipants).toBe(25);
	} finally {
		for (const socket of sockets) socket.terminate();
		await Promise.allSettled(roomIds.map(id => rooms.deleteRoom(`chatRoom:${id}`)));
		if (limitChanged) await api('admin/update-meta', { voiceCallMaxParticipants: 10 }, admin.token);
	}
}, 180000);
