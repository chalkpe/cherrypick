/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, test, vi } from 'vitest';
import * as Misskey from 'cherrypick-js';
import { Redis } from 'ioredis';
import { createAccount, resolveRemoteUser, WAIT_FOR_FEDERATION } from './utils.js';

/**
 * 가져오는 도중 받는 서버를 다시 시작해도 이어서 끝까지 받는지 본다. 서버를 다시 시작하는 것은 시험 밖의 실행 절차가 한다.
 * CHERRYPICK_FED_INTERRUPT_STEP=start로 가져오기를 시작하고, b.test를 다시 시작한 뒤 =verify로 확인한다.
 * 두 단계 사이의 값은 tester가 닿는 redis.test에 둔다.
 */
const step = process.env.CHERRYPICK_FED_INTERRUPT_STEP;
const STATE_KEY = 'test-federation:chat-room-history-interrupt';
const COUNT = 2000;

type State = { roomId: string; mirrorId: string; bobToken: string; seenBeforeRestart: number };

function redis(): Redis {
	return new Redis({ host: 'redis.test', port: 6379 });
}

describe.runIf(step === 'start')('Chat room history, before the member server restarts', () => {
	test('starts fetching a history longer than one run', async () => {
		const [alice, bob] = await Promise.all([createAccount('a.test'), createAccount('b.test')]);
		const room = await alice.client.request('chat/rooms/create', { name: `interrupt ${crypto.randomUUID()}` });
		for (let i = 0; i < COUNT; i++) await alice.client.request('chat/messages/create-to-room', { toRoomId: room.id, text: `long ${i}` });
		const remote = await resolveRemoteUser('b.test', bob.id, alice);
		await alice.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: remote.id });
		const mirrorId = await vi.waitFor(async () => {
			const invitation = (await bob.client.request('chat/rooms/invitations/inbox', {})).find(candidate => candidate.room.name === room.name);
			if (invitation == null) throw new Error('the invitation has not arrived yet');
			return invitation.roomId;
		}, WAIT_FOR_FEDERATION);
		await bob.client.request('chat/rooms/join', { roomId: mirrorId });

		const seen = await vi.waitFor(async () => {
			const messages = await bob.client.request('chat/messages/room-timeline', { roomId: mirrorId, limit: 100 });
			if (messages.length < 20) throw new Error('the first page has not arrived yet');
			return messages.length;
		}, { timeout: 120000, interval: 200 });
		const shown = await bob.client.request('chat/rooms/show', { roomId: mirrorId });
		strictEqual(shown.historyImportStatus, 'running');

		const client = redis();
		try {
			await client.set(STATE_KEY, JSON.stringify({ roomId: room.id, mirrorId, bobToken: bob.i, seenBeforeRestart: seen } satisfies State), 'EX', 3600);
		} finally {
			client.disconnect();
		}
	});
});

describe.runIf(step === 'verify')('Chat room history, after the member server restarted', () => {
	test('resumes and finishes without repeating or losing a message', async () => {
		const client = redis();
		const state = JSON.parse(await client.get(STATE_KEY) ?? 'null') as State;
		client.disconnect();
		const bob = new Misskey.api.APIClient({ origin: 'https://b.test', credential: state.bobToken });

		await vi.waitFor(async () => {
			const shown = await bob.request('chat/rooms/show', { roomId: state.mirrorId });
			strictEqual(shown.historyImportStatus, 'completed');
		}, { timeout: 900000, interval: 2000 });

		const all: Misskey.entities.ChatMessageLiteForRoom[] = [];
		let untilId: string | undefined;
		for (;;) {
			const page = await bob.request('chat/messages/room-timeline', { roomId: state.mirrorId, limit: 100, untilId });
			all.push(...page);
			if (page.length < 100) break;
			untilId = page.at(-1)!.id;
		}
		strictEqual(state.seenBeforeRestart < COUNT, true);
		strictEqual(all.length, COUNT);
		strictEqual(new Set(all.map(message => message.text)).size, COUNT);
		deepStrictEqual(all.map(message => message.text).reverse(), Array.from({ length: COUNT }, (_, i) => `long ${i}`));
	});
});
