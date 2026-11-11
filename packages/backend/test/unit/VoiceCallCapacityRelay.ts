/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Config } from '@/config.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import { VoiceRelayClient } from '@/core/VoiceRelayClient.js';
import { VoiceRelayConsumerService } from '@/core/VoiceRelayConsumerService.js';
import { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { createFixture } from '../misc/chat-voice-fixture.js';

const credentialFile = process.env.VOICE_CALL_RELAY_CREDENTIALS;
type TestCredentials = { relayUrl: string; origin: string; secret: string };

test.skipIf(!credentialFile)('a real relay reserves the configured number of slots for each new call', async () => {
	const credentials = JSON.parse(readFileSync(credentialFile!, 'utf8')) as TestCredentials;
	const config = { url: credentials.origin, db: { host: '127.0.0.1', port: 55494, db: 'test-cherrypick', user: 'postgres', pass: '', extra: {} } } as Config;
	const storage = new VoiceRelayStorage(config);
	const http = { send: (url: string, options: RequestInit) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) } as unknown as HttpRequestService;
	const consumer = new VoiceRelayConsumerService(config, storage, new VoiceRelayClient(config, http, storage));
	const chat = createFixture();
	const providerId = `test-${randomUUID()}`;
	const roomId = `room-${randomUUID()}`;
	const nextRoomId = `room-${randomUUID()}`;
	let saved = false;
	chat.liveKitService.ensureRoom.mockImplementation(async (room, slots) => { await consumer.ensure(room, slots); });
	const mint = async (room: string) => chat.service.issueJoinToken({ id: 'owner', host: null, uri: null } as any, { id: room } as any, false);
	try {
		await consumer.saveProvider({ id: providerId, origin: new URL(credentials.relayUrl).origin, enabled: true, secret: credentials.secret });
		saved = true;
		await consumer.checkProvider(providerId);
		const provider = (await consumer.allProviders()).find(value => value.id === providerId)!;

		await mint(roomId);
		expect((await consumer.get(roomId))?.slots).toBe(10);
		expect((await consumer.capacity(provider)).reservedSlots).toBe(10);

		chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 25 } as typeof chat.meta);
		await mint(roomId);
		expect((await consumer.capacity(provider)).reservedSlots).toBe(10);
		await consumer.end(roomId);

		chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 25 } as typeof chat.meta);
		await mint(nextRoomId);
		expect((await consumer.get(nextRoomId))?.slots).toBe(25);
		expect((await consumer.capacity(provider)).reservedSlots).toBe(25);
	} finally {
		if (saved) {
			await consumer.end(roomId).catch(() => {});
			await consumer.end(nextRoomId).catch(() => {});
			await consumer.removeProvider(providerId).catch(() => {});
		}
		chat.service.onApplicationShutdown();
		await storage.onApplicationShutdown();
	}
}, 90000);
