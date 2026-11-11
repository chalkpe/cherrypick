/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { expect, test } from 'vitest';
import { LiveKitService } from '@/core/LiveKitService.js';
import { createFixture } from '../misc/chat-voice-fixture.js';

const credentialFile = process.env.VOICE_CALL_LIVEKIT_CREDENTIALS;
const require = createRequire(import.meta.url);
const { SignalRequest, SignalResponse, LeaveRequest, DisconnectReason, LeaveRequest_Action } = createRequire(require.resolve('livekit-server-sdk'))('@livekit/protocol');

type TestCredentials = { url: string; apiKey: string; apiSecret: string };
type SignalResult = { socket: WebSocket; accepted: boolean; reason?: string };

test('issued tokens carry the assigned room limit for automatic room creation', async () => {
	const apiKey = 'test-key';
	const apiSecret = 'test-secret-with-at-least-thirty-two-characters';
	const livekit = new LiveKitService({ url: 'https://local.test', voiceCall: { livekit: { internalUrl: 'http://localhost:7880', apiKey, apiSecret } } } as any);

	const token = await livekit.createJoinToken({ roomId: 'room', identity: 'member', userId: 'member', canScreenShare: false, maxParticipants: 10 });

	const claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
	expect(claims.roomConfig?.maxParticipants).toBe(10);
});

function connect(url: string, token: string): Promise<SignalResult> {
	const endpoint = new URL('/rtc', url);
	endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
	endpoint.searchParams.set('access_token', token);
	endpoint.searchParams.set('protocol', '16');
	endpoint.searchParams.set('sdk', 'js');
	endpoint.searchParams.set('version', '2.23.0');
	endpoint.searchParams.set('auto_subscribe', '0');
	const socket = new WebSocket(endpoint);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.terminate(); reject(new Error('LiveKit signaling did not respond')); }, 10000);
		const finish = (accepted: boolean, reason?: string) => { clearTimeout(timer); resolve({ socket, accepted, reason }); };
		socket.once('error', () => { clearTimeout(timer); reject(new Error('LiveKit signaling failed')); });
		socket.once('unexpected-response', (_request, response) => {
			let body = '';
			response.on('data', chunk => { body += chunk.toString(); });
			response.once('end', () => finish(false, `${response.statusCode} ${body}`));
		});
		socket.on('message', data => {
			const message = SignalResponse.fromBinary(new Uint8Array(data as Buffer)).message;
			if (message.case === 'join') finish(true);
			if (message.case === 'leave') finish(false, String(message.value.reason));
		});
	});
}

test.skipIf(!credentialFile)('real LiveKit enforces the call limit, including the owner, and allows a return after departure', async () => {
	const credentials = JSON.parse(readFileSync(credentialFile!, 'utf8')) as TestCredentials;
	const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: credentials.url, apiKey: credentials.apiKey, apiSecret: credentials.apiSecret } } } as any;
	const livekit = new LiveKitService(config);
	const rooms = new RoomServiceClient(credentials.url, credentials.apiKey, credentials.apiSecret);
	const chat = createFixture();
	const roomId = `capacity-${randomUUID()}`;
	const nextRoomId = `capacity-${randomUUID()}`;
	const sockets: WebSocket[] = [];
	chat.liveKitService.ensureRoom.mockImplementation((room, limit) => livekit.ensureRoom(room, limit));
	chat.liveKitService.createJoinToken.mockImplementation(params => livekit.createJoinToken(params));
	const mint = async (id: string, room = roomId) => chat.service.issueJoinToken({ id, host: null, uri: null } as any, { id: room } as any, false);
	try {
		const owner = await mint('owner');
		expect((await rooms.listRooms([livekit.roomNameOf(roomId)]))[0].maxParticipants).toBe(10);
		const tokens = [owner.token];
		for (let index = 1; index < 11; index++) tokens.push((await mint(`member${index}`)).token);
		for (const token of tokens.slice(0, 10)) {
			const result = await connect(credentials.url, token);
			sockets.push(result.socket);
			expect(result.accepted).toBe(true);
		}
		chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 25 } as typeof chat.meta);
		await mint('member1');
		expect((await rooms.listRooms([livekit.roomNameOf(roomId)]))[0].maxParticipants).toBe(10);
		chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 1 } as typeof chat.meta);
		await mint('member1');
		expect((await rooms.listRooms([livekit.roomNameOf(roomId)]))[0].maxParticipants).toBe(10);
		expect(await rooms.listParticipants(livekit.roomNameOf(roomId))).toHaveLength(10);
		const extra = await connect(credentials.url, tokens[10]);
		sockets.push(extra.socket);
		expect(extra.accepted).toBe(false);
		expect(extra.reason).toBe('500 connection closed by media');

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('LiveKit did not close the departing session')), 10000);
			sockets[0].once('close', () => { clearTimeout(timer); resolve(); });
			sockets[0].send(new SignalRequest({ message: { case: 'leave', value: new LeaveRequest({ reason: DisconnectReason.CLIENT_INITIATED, action: LeaveRequest_Action.DISCONNECT }) } }).toBinary());
		});
		const returned = await connect(credentials.url, (await mint('owner')).token);
		sockets.push(returned.socket);
		expect(returned.accepted).toBe(true);

		chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 25 } as typeof chat.meta);
		await mint('owner', nextRoomId);
		expect((await rooms.listRooms([livekit.roomNameOf(nextRoomId)]))[0].maxParticipants).toBe(25);
	} finally {
		for (const socket of sockets) socket.terminate();
		await Promise.allSettled([livekit.deleteRoom(roomId), livekit.deleteRoom(nextRoomId)]);
		chat.service.onApplicationShutdown();
	}
}, 90000);
