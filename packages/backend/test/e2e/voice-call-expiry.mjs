/*
	* SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
	* SPDX-License-Identifier: AGPL-3.0-only
	*/

// Run with node --test against a dedicated server and LiveKit using
// VOICE_TEST_ORIGIN, VOICE_TEST_ADMIN_FILE, and VOICE_TEST_LIVEKIT_FILE.
// The test creates accounts and rooms through the public APIs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { RoomServiceClient } from 'livekit-server-sdk';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const { SignalResponse } = createRequire(require.resolve('livekit-server-sdk'))('@livekit/protocol');
const admin = JSON.parse(await readFile(process.env.VOICE_TEST_ADMIN_FILE, 'utf8'));
const livekit = JSON.parse(await readFile(process.env.VOICE_TEST_LIVEKIT_FILE, 'utf8'));
const origin = process.env.VOICE_TEST_ORIGIN;
const rooms = new RoomServiceClient(livekit.url, livekit.apiKey, livekit.apiSecret);
const suffix = randomBytes(3).toString('hex');
const accounts = [];
const createdRooms = [];
const sockets = [];

async function api(endpoint, data, account = admin) {
	const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, i: account.token }) });
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(`${endpoint}: HTTP ${response.status} ${error.error?.code ?? ''}`);
	}
	return response.status === 204 ? null : response.json();
}

async function connect(token) {
	const endpoint = new URL('/livekit/rtc', origin);
	endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
	endpoint.searchParams.set('access_token', token);
	endpoint.searchParams.set('protocol', '16');
	endpoint.searchParams.set('sdk', 'js');
	endpoint.searchParams.set('version', '2.23.0');
	endpoint.searchParams.set('auto_subscribe', '0');
	const socket = new WebSocket(endpoint);
	sockets.push(socket);
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('signaling timeout'));
		}, 10000);
		let done = false;
		const finish = (accepted, reason) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ accepted, reason });
		};
		socket.once('error', () => finish(false, 'socket error'));
		socket.once('unexpected-response', (_request, response) => {
			response.resume();
			finish(false, `HTTP ${response.statusCode}`);
		});
		socket.on('message', data => {
			const message = SignalResponse.fromBinary(new Uint8Array(data)).message;
			if (message.case === 'join') finish(true, 'join');
			if (message.case === 'leave') finish(false, `leave ${message.value.reason}`);
		});
	});
}

async function scenario(mode) {
	const room = await api('chat/rooms/create', { name: `review-sfu-${mode}-${suffix}` }, accounts[0]);
	createdRooms.push(room.id);
	for (const account of accounts.slice(1)) {
		await api('chat/rooms/invitations/create', { roomId: room.id, userId: account.id }, accounts[0]);
		await api('chat/rooms/join', { roomId: room.id }, account);
	}
	const tokens = [];
	for (const account of accounts) tokens.push((await api('chat/rooms/voice/join', { roomId: room.id }, account)).token);
	const roomName = `chatRoom:${room.id}`;
	const before = (await rooms.listRooms([roomName]))[0];
	if (!before || before.maxParticipants !== 10) throw new Error(`initial room limit unexpected: ${before?.maxParticipants}`);
	console.log(`${mode}: 11 authorized product tokens issued; initial room limit=10`);
	const deadline = Date.now() + 90000;
	while ((await rooms.listRooms([roomName])).length) {
		if (Date.now() > deadline) throw new Error('room did not expire');
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	console.log(`${mode}: room naturally expired; no new join API call`);
	const results = mode === 'simultaneous' ? await Promise.all(tokens.map(connect)) : [];
	if (mode === 'sequential') for (const token of tokens) results.push(await connect(token));
	const current = (await rooms.listRooms([roomName]))[0];
	console.log(`${mode}: accepted=${results.filter(result => result.accepted).length}; eleventh=${results[10].accepted}; room maxParticipants=${current?.maxParticipants}`);
	assert.equal(current?.maxParticipants, 10);
	assert.equal(results.filter(result => result.accepted).length, 10);
	if (mode === 'sequential') assert.equal(results[10].accepted, false);
}

test('expired rooms retain their limit for issued product tokens', { timeout: 240000 }, async () => {
	try {
		for (let index = 0; index < 11; index++) accounts.push(await api('admin/accounts/create', { username: `sfu${suffix}${index}`, password: `review-${suffix}-password` }));
		await scenario('sequential');
		for (const socket of sockets.splice(0)) socket.terminate();
		await scenario('simultaneous');
	} finally {
		for (const socket of sockets) socket.terminate();
		for (const roomId of createdRooms) await api('chat/rooms/delete', { roomId }, accounts[0]).catch(() => {});
	}
});
