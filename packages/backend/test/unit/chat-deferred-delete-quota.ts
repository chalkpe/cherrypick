/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import type { MiRemoteUser } from '@/models/_.js';

const actor = { id: 'actor1', uri: 'https://author.test/users/actor1' } as MiRemoteUser;
const otherActor = { id: 'actor2', uri: 'https://author.test/users/actor2' } as MiRemoteUser;
const firstUri = 'https://author.test/chat/messages/first';
const secondUri = 'https://author.test/chat/messages/second';

function fixture() {
	const sets = new Map<string, Set<string>>();
	const full = new Set<string>();
	const expirations = new Map<string, { seconds: number; mode: string }>();
	const values = new Map<string, { seconds: number; value: string }>();
	const redisClient = {
		scard: async (key: string) => full.has(key) ? 1000 : (sets.get(key)?.size ?? 0),
		sadd: async (key: string, value: string) => {
			const set = sets.get(key) ?? new Set<string>();
			sets.set(key, set);
			set.add(value);
			return 1;
		},
		expire: async (key: string, seconds: number, mode: string) => {
			if (!expirations.has(key)) expirations.set(key, { seconds, mode });
			return 1;
		},
		setex: async (key: string, seconds: number, value: string) => { values.set(key, { seconds, value }); return 'OK'; },
	};
	const inbox = Object.assign(Object.create(ApInboxService.prototype), { redisClient }) as {
		storeDeferredChatDelete: (actor: MiRemoteUser, uri: string, roomId?: string) => Promise<boolean>;
	};
	return { inbox, sets, full, expirations, values };
}

describe('deferred chat delete quotas', () => {
	test('a full relay budget cannot reject the author’s direct delete', async () => {
		const f = fixture();
		expect(await f.inbox.storeDeferredChatDelete(actor, firstUri, 'room1')).toBe(true);
		f.full.add([...f.sets.keys()][0]);

		expect(await f.inbox.storeDeferredChatDelete(actor, secondUri, 'room1')).toBe(false);
		expect(await f.inbox.storeDeferredChatDelete(actor, secondUri)).toBe(true);
		expect(f.values.get(`chat_delete_upon_arrival:${secondUri}:https%3A%2F%2Fauthor.test%2Fusers%2Factor1`)).toEqual({ seconds: 21600, value: actor.uri });
	});

	test('a full direct budget cannot reject a relay', async () => {
		const f = fixture();
		expect(await f.inbox.storeDeferredChatDelete(actor, firstUri)).toBe(true);
		f.full.add([...f.sets.keys()][0]);

		expect(await f.inbox.storeDeferredChatDelete(actor, secondUri)).toBe(false);
		expect(await f.inbox.storeDeferredChatDelete(actor, secondUri, 'room1')).toBe(true);
		expect(f.values.get(`chat_delete_upon_arrival:${secondUri}:https%3A%2F%2Fauthor.test%2Fusers%2Factor1:room:room1`)).toEqual({ seconds: 21600, value: actor.uri });
	});

	test('the relay budget remains bounded across rooms and isolated by actor', async () => {
		const f = fixture();
		expect(await f.inbox.storeDeferredChatDelete(actor, firstUri, 'room1')).toBe(true);
		f.full.add([...f.sets.keys()][0]);

		expect(await f.inbox.storeDeferredChatDelete(actor, secondUri, 'room2')).toBe(false);
		expect(await f.inbox.storeDeferredChatDelete(otherActor, secondUri, 'room2')).toBe(true);
	});

	test('both indexes use fixed six-hour expiration and preserve distinct room markers', async () => {
		const f = fixture();
		expect(await f.inbox.storeDeferredChatDelete(actor, firstUri)).toBe(true);
		expect(await f.inbox.storeDeferredChatDelete(actor, firstUri, 'room1')).toBe(true);
		expect(await f.inbox.storeDeferredChatDelete(actor, firstUri, 'room2')).toBe(true);

		expect([...f.sets.values()].map(set => set.size).sort()).toEqual([1, 2]);
		expect([...f.expirations.values()]).toEqual([{ seconds: 21600, mode: 'NX' }, { seconds: 21600, mode: 'NX' }]);
		expect([...f.values.keys()].sort()).toEqual([
			`chat_delete_upon_arrival:${firstUri}:https%3A%2F%2Fauthor.test%2Fusers%2Factor1`,
			`chat_delete_upon_arrival:${firstUri}:https%3A%2F%2Fauthor.test%2Fusers%2Factor1:room:room1`,
			`chat_delete_upon_arrival:${firstUri}:https%3A%2F%2Fauthor.test%2Fusers%2Factor1:room:room2`,
		]);
	});
});
