/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import type { MiRemoteUser } from '@/models/User.js';

function remoteActor(host: string, n: number): MiRemoteUser {
	return { id: `${host}-actor${n}`, host, uri: `https://${host}/users/actor${n}` } as MiRemoteUser;
}

const owner = remoteActor('owner.test', 1);
const roomUriOf = (host: string, id: string) => `https://${host}/chat/rooms/${id}`;

function updateOf(actor: MiRemoteUser, roomUri: string, extra: Record<string, unknown> = {}) {
	return { type: 'Update', actor: actor.uri, object: { id: roomUri, type: 'Group', name: 'room', ...extra } } as never;
}

function fixture() {
	const sets = new Map<string, Set<string>>();
	const lists = new Map<string, string[]>();
	const counters = new Map<string, number>();
	const strings = new Map<string, string>();
	const ttls = new Map<string, number>();
	const redisClient = {
		get: async (key: string) => strings.get(key) ?? null,
		setex: async (key: string, _seconds: number, value: string) => { strings.set(key, value); return 'OK'; },
		scard: async (key: string) => sets.get(key)?.size ?? 0,
		sadd: async (key: string, value: string) => {
			const set = sets.get(key) ?? new Set<string>();
			sets.set(key, set);
			set.add(value);
			return 1;
		},
		expire: async (key: string, seconds: number, mode?: string) => {
			if (!counters.has(key) && !lists.has(key) && !sets.has(key)) return 0;
			if (mode === 'NX' && ttls.has(key)) return 0;
			ttls.set(key, seconds);
			return 1;
		},
		llen: async (key: string) => lists.get(key)?.length ?? 0,
		incr: async (key: string) => { counters.set(key, (counters.get(key) ?? 0) + 1); return counters.get(key)!; },
		decr: async (key: string) => { counters.set(key, (counters.get(key) ?? 0) - 1); return counters.get(key)!; },
		incrby: async (key: string, by: number) => { counters.set(key, (counters.get(key) ?? 0) + by); return counters.get(key)!; },
		decrby: async (key: string, by: number) => { counters.set(key, (counters.get(key) ?? 0) - by); return counters.get(key)!; },
		del: async (key: string) => {
			ttls.delete(key);
			const had = counters.delete(key) || lists.delete(key);
			return Number(had);
		},
		multi: () => {
			const commands: (() => unknown)[] = [];
			const transaction = {
				rpush: (key: string, ...values: string[]) => {
					commands.push(() => {
						const list = lists.get(key) ?? [];
						lists.set(key, list);
						return list.push(...values);
					});
					return transaction;
				},
				expire: (key: string, seconds: number) => { commands.push(() => { ttls.set(key, seconds); return 1; }); return transaction; },
				lrange: (key: string) => { commands.push(() => [...(lists.get(key) ?? [])]); return transaction; },
				del: (key: string) => { commands.push(() => { ttls.delete(key); return Number(lists.delete(key)); }); return transaction; },
				exec: async () => commands.map(command => [null, command()]),
			};
			return transaction;
		},
	};
	const update = vi.fn(async () => 'ok');
	const users = new Map<string, MiRemoteUser>();
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		redisClient,
		usersRepository: { findOneBy: async ({ id }: { id: string }) => users.get(id) ?? null },
		utilityService: { punyHost: (uri: string) => new URL(uri).host },
	});
	// update は bindThis の getter なので、インスタンスに定義し直して差し替える
	Object.defineProperty(inbox, 'update', { value: update });
	const typed = inbox as unknown as {
		storePendingRoomActivity: (actor: MiRemoteUser, activity: unknown) => Promise<boolean>;
		storeDeferredChatDelete: (actor: MiRemoteUser, uri: string, roomId?: string) => Promise<boolean>;
		applyPendingRoomActivities: (roomUri: string) => Promise<boolean>;
	};
	return { inbox: typed, update, users, lists, sets, strings, counters, ttls };
}

describe('보류 중인 그룹 활동의 크기', () => {
	test('정상 크기의 활동은 보관했다가 그룹을 알게 된 뒤 적용한다', async () => {
		const f = fixture();
		f.users.set(owner.id, owner);
		const uri = roomUriOf('owner.test', 'room1');
		const activity = updateOf(owner, uri);

		expect(await f.inbox.storePendingRoomActivity(owner, activity)).toBe(true);
		expect(await f.inbox.applyPendingRoomActivities(uri)).toBe(false);

		expect(f.update).toHaveBeenCalledTimes(1);
		expect(f.update).toHaveBeenCalledWith(owner, activity);
	});

	test('직렬화한 길이가 9,000자쯤인 활동은 보관한다', async () => {
		const f = fixture();
		const uri = roomUriOf('owner.test', 'room1');

		expect(await f.inbox.storePendingRoomActivity(owner, updateOf(owner, uri, { summary: 'x'.repeat(9000) }))).toBe(true);
		expect(f.lists.get(`chat_pending_room_activity_events:${uri}`)).toHaveLength(1);
	});

	test('직렬화한 길이가 16,384자를 넘는 활동은 보관하지 않는다', async () => {
		const f = fixture();
		const uri = roomUriOf('owner.test', 'room1');

		expect(await f.inbox.storePendingRoomActivity(owner, updateOf(owner, uri, { summary: 'x'.repeat(16400) }))).toBe(false);

		expect(f.lists.size).toBe(0);
		expect(f.sets.size).toBe(0);
	});

	test('그룹 URI가 쪽지 ID에 허용하는 길이를 넘으면 보관하지 않는다', async () => {
		const f = fixture();
		const long = `https://owner.test/${'a'.repeat(1100)}/chat/rooms/room1`;
		const manyPoints = `https://owner.test/${'가'.repeat(600)}/chat/rooms/room1`;

		expect(await f.inbox.storePendingRoomActivity(owner, updateOf(owner, long))).toBe(false);
		expect(await f.inbox.storePendingRoomActivity(owner, updateOf(owner, manyPoints))).toBe(false);

		expect(f.lists.size).toBe(0);
	});

	test('한 서버의 여러 행위자가 서버별 상한을 넘겨 쌓을 수 없다', async () => {
		const f = fixture();
		let stored = 0;
		for (let actorNo = 0; actorNo < 12; actorNo++) {
			const actor = remoteActor('busy.test', actorNo);
			for (let roomNo = 0; roomNo < 100; roomNo++) {
				if (await f.inbox.storePendingRoomActivity(actor, updateOf(actor, roomUriOf('busy.test', `r${actorNo}x${roomNo}`)))) stored++;
			}
		}

		expect(stored).toBe(1000);
		// 다른 서버는 영향을 받지 않는다
		const other = remoteActor('quiet.test', 1);
		expect(await f.inbox.storePendingRoomActivity(other, updateOf(other, roomUriOf('quiet.test', 'room1')))).toBe(true);
	});

	test('적용에 실패한 보류분을 되넣은 뒤에도 서버별 집계 키에 만료 시간이 있다', async () => {
		const f = fixture();
		f.users.set(owner.id, owner);
		f.update.mockRejectedValue(new Error('cannot apply'));
		const uri = roomUriOf('owner.test', 'room1');
		const hostKey = 'chat_pending_room_activities_host:owner.test';

		expect(await f.inbox.storePendingRoomActivity(owner, updateOf(owner, uri))).toBe(true);
		expect(f.ttls.get(hostKey)).toBeGreaterThan(0);

		await expect(f.inbox.applyPendingRoomActivities(uri)).rejects.toThrow();

		expect(f.counters.get(hostKey)).toBe(1);
		expect(f.ttls.get(hostKey)).toBeGreaterThan(0);
	});

	test('보류분을 적용하면 서버별 집계도 줄어 다시 보관할 수 있다', async () => {
		const f = fixture();
		const actors = Array.from({ length: 10 }, (_, n) => remoteActor('busy.test', n));
		for (const actor of actors) f.users.set(actor.id, actor);
		for (const [actorNo, actor] of actors.entries()) {
			for (let roomNo = 0; roomNo < 100; roomNo++) {
				expect(await f.inbox.storePendingRoomActivity(actor, updateOf(actor, roomUriOf('busy.test', `r${actorNo}x${roomNo}`)))).toBe(true);
			}
		}
		const extra = remoteActor('busy.test', 99);
		expect(await f.inbox.storePendingRoomActivity(extra, updateOf(extra, roomUriOf('busy.test', 'extra')))).toBe(false);

		await f.inbox.applyPendingRoomActivities(roomUriOf('busy.test', 'r0x0'));

		expect(await f.inbox.storePendingRoomActivity(extra, updateOf(extra, roomUriOf('busy.test', 'extra')))).toBe(true);
	});
});

describe('보류 중인 쪽지 삭제의 크기', () => {
	test('쪽지 ID에 허용하는 길이를 넘는 대상은 보관하지 않는다', async () => {
		const f = fixture();
		const long = `https://owner.test/chat/messages/${'a'.repeat(1100)}`;
		const manyPoints = `https://owner.test/chat/messages/${'가'.repeat(600)}`;

		expect(await f.inbox.storeDeferredChatDelete(owner, long)).toBe(false);
		expect(await f.inbox.storeDeferredChatDelete(owner, manyPoints, 'room1')).toBe(false);
		expect(await f.inbox.storeDeferredChatDelete(owner, 'https://owner.test/chat/messages/ok')).toBe(true);

		expect([...f.strings.keys()]).toHaveLength(1);
	});

	test('한 서버의 여러 행위자가 서버별 상한을 넘겨 쌓을 수 없다', async () => {
		const f = fixture();
		let stored = 0;
		for (let actorNo = 0; actorNo < 7; actorNo++) {
			const actor = remoteActor('busy.test', actorNo);
			for (let n = 0; n < 1000; n++) {
				if (await f.inbox.storeDeferredChatDelete(actor, `https://busy.test/chat/messages/m${actorNo}x${n}`)) stored++;
			}
		}

		expect(stored).toBe(5000);
		const other = remoteActor('quiet.test', 1);
		expect(await f.inbox.storeDeferredChatDelete(other, 'https://quiet.test/chat/messages/m1')).toBe(true);
	});
});
