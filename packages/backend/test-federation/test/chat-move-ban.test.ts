/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { strictEqual } from 'node:assert';
import { rm, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, test, vi } from 'vitest';
import { createAccount, fetchAdmin, resolveRemoteUser, waitForFollowRelation, WAIT_FOR_SLOW_FEDERATION, type LoginUser } from './utils.js';
import type * as Misskey from 'cherrypick-js';

type Host = 'a.test' | 'b.test';

/** 그룹 호스트(a.test)에서 본 계정. 원격 계정은 a.test가 알게 된 ID를 쓴다. */
type Account = { user: LoginUser; host: Host };

type Room = { id: string; url: string };

/** 실패한 inbox 작업의 첫 재시도는 1분쯤 뒤다. 그 재시도까지 기다릴 때의 상한. */
const WAIT_FOR_INBOX_RETRY = { timeout: 150_000, interval: 1000 };

const MOVE_TEST_TIMEOUT = 300_000;

/** 일반 그룹과 채널형 그룹을 하나씩 만들어 같은 정책을 함께 확인한다. */
async function createRooms(owner: LoginUser): Promise<Room[]> {
	const rooms: Room[] = [];
	for (const channels of [false, true]) {
		const room = await owner.client.request('chat/rooms/create', { name: crypto.randomUUID() });
		if (channels) await owner.client.request('chat/rooms/convert-to-channels', { roomId: room.id });
		const { url } = await owner.client.request('chat/rooms/invite-link/create', { roomId: room.id });
		rooms.push({ id: room.id, url });
	}
	return rooms;
}

async function join(user: LoginUser, room: Room): Promise<Misskey.entities.ChatInviteLinkJoinStatusResponse> {
	await user.client.request('chat/invite-link/join', { url: room.url });
	return await vi.waitFor(async () => {
		const status = await user.client.request('chat/invite-link/join-status', { url: room.url });
		if (status.status === 'none' || status.status === 'pending') throw new Error('join is pending');
		return status;
	}, WAIT_FOR_SLOW_FEDERATION);
}

async function joinAll(user: LoginUser, rooms: Room[]): Promise<void> {
	for (const room of rooms) strictEqual((await join(user, room)).status, 'joined');
}

/** 그룹 호스트에서 이 계정을 가리키는 ID. 원격 계정을 처음 보면 a.test가 계정을 만든다. */
async function idOnHost(owner: LoginUser, account: Account): Promise<string> {
	if (account.host === 'a.test') return account.user.id;
	return (await resolveRemoteUser('b.test', account.user.id, owner)).id;
}

async function kickAll(owner: LoginUser, rooms: Room[], userId: string): Promise<void> {
	for (const room of rooms) await owner.client.request('chat/rooms/kick', { roomId: room.id, userId });
}

async function isBanned(owner: LoginUser, room: Room, userId: string): Promise<boolean> {
	const bans = await owner.client.request('chat/rooms/bans/list', { roomId: room.id, limit: 100 });
	return bans.some(ban => ban.userId === userId);
}

async function banCount(owner: LoginUser, room: Room, userId: string): Promise<number> {
	const bans = await owner.client.request('chat/rooms/bans/list', { roomId: room.id, limit: 100 });
	return bans.filter(ban => ban.userId === userId).length;
}

async function waitUntilBannedEverywhere(owner: LoginUser, rooms: Room[], userId: string, who: string, options = WAIT_FOR_SLOW_FEDERATION): Promise<void> {
	await vi.waitFor(async () => {
		for (const [index, room] of rooms.entries()) strictEqual(await isBanned(owner, room, userId), true, `${who} is not banned in ${index === 0 ? 'the group' : 'the channel group'}`);
	}, options);
}

async function isMember(owner: LoginUser, room: Room, userId: string): Promise<boolean> {
	const members = await owner.client.request('chat/rooms/members', { roomId: room.id, limit: 100 });
	return members.some(member => member.userId === userId);
}

async function follow(follower: LoginUser, followed: LoginUser): Promise<void> {
	const remote = await resolveRemoteUser('b.test', followed.id, follower);
	await follower.client.request('following/create', { userId: remote.id });
	await waitForFollowRelation(follower, followed, 1, WAIT_FOR_SLOW_FEDERATION);
}

/** 새 계정이 옛 계정을 별칭으로 둔다. 이전을 받아들이려면 먼저 해야 한다. */
async function alias(to: Account, from: Account): Promise<void> {
	await to.user.client.request('i/update', { alsoKnownAs: [`@${from.user.username}@${from.host}`] });
}

/** 각 서버의 사용자 API로 옛 계정을 새 계정으로 이전한다. */
async function move(from: Account, to: Account): Promise<void> {
	await alias(to, from);
	await from.user.client.request('i/move', { moveToAccount: `@${to.user.username}@${to.host}` });
}

type InboxActivity = { type?: string; actor?: string };

function activityOf(job: Misskey.entities.QueueJob): InboxActivity | undefined {
	return (job.data as { activity?: InboxActivity }).activity;
}

/** 이 계정이 보낸 이전 알림(Update와 Move)의 inbox 작업. */
async function inboxJobs(admin: LoginUser, actor: LoginUser, state: ('active' | 'wait' | 'delayed' | 'completed' | 'failed')[]) {
	const jobs = await admin.client.request('admin/queue/jobs', { queue: 'inbox', state, search: actor.id });
	return jobs.filter(job => {
		const activity = activityOf(job);
		return activity?.actor?.endsWith(`/users/${actor.id}`) === true && ['Update', 'Move'].includes(activity.type ?? '');
	});
}

function describeJobs(jobs: Misskey.entities.QueueJob[]) {
	return jobs.map(job => ({ type: activityOf(job)?.type, attempts: job.attempts, finished: job.finishedOn != null, returnValue: job.returnValue, failedReason: job.failedReason }));
}

/** 보낸 서버가 이 계정의 이전 알림(Update와 Move)을 a.test에 넘겼다. a.test가 받아 둔 것이지 처리한 것은 아니다. */
async function waitUntilMoveDelivered(sender: LoginUser, actor: LoginUser): Promise<void> {
	await vi.waitFor(async () => {
		const jobs = await sender.client.request('admin/queue/jobs', { queue: 'deliver', state: ['completed'], search: actor.id });
		const types = jobs.map(job => (JSON.parse((job.data as { content?: string }).content ?? '{}') as { type?: string }).type);
		strictEqual(types.includes('Update') && types.includes('Move'), true);
	}, WAIT_FOR_SLOW_FEDERATION);
}

async function waitUntilMoveProcessed(hostAdmin: LoginUser, actor: LoginUser, options = WAIT_FOR_SLOW_FEDERATION): Promise<void> {
	await vi.waitFor(async () => {
		const pending = await inboxJobs(hostAdmin, actor, ['active', 'wait', 'delayed']);
		const done = await inboxJobs(hostAdmin, actor, ['completed']);
		strictEqual(pending.length, 0);
		strictEqual(done.some(job => activityOf(job)?.type === 'Move'), true);
	}, options);
}

/** 그룹 호스트의 inbox 처리를 잠시 멈춘다. 받은 활동은 큐에 쌓였다가 다시 시작하면 처리된다. */
async function whileInboxPaused(hostAdmin: LoginUser, work: () => Promise<void>): Promise<void> {
	await hostAdmin.client.request('admin/queue/pause', { queue: 'inbox' });
	try {
		await work();
	} finally {
		await hostAdmin.client.request('admin/queue/resume', { queue: 'inbox' });
	}
}

/** 이전 후 새 계정의 그룹 상태: 금지 목록에 있고, 이미 멤버였다면 그대로 남고, 나갔다가 다시 들어오면 거절된다. */
async function expectCarriedToMember(owner: LoginUser, rooms: Room[], account: LoginUser, idOnHostServer: string): Promise<void> {
	for (const room of rooms) strictEqual(await isMember(owner, room, idOnHostServer), true);

	const [room] = rooms;
	const membership = await account.client.request('chat/invite-link/join-status', { url: room.url });
	await account.client.request('chat/rooms/leave', { roomId: membership.roomId! });
	await vi.waitFor(async () => strictEqual(await isMember(owner, room, idOnHostServer), false), WAIT_FOR_SLOW_FEDERATION);
	const refused = await join(account, room);

	strictEqual(refused.status, 'refused');
	strictEqual(refused.reason, 'banned');
}

describe('a chat room ban follows verified account moves', () => {
	test('in the order the moves happened', async () => {
		const owner = await createAccount('a.test');
		const follower = await createAccount('a.test');
		const first: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const middle: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const last: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const rooms = await createRooms(owner);
		await joinAll(first.user, rooms);
		await joinAll(last.user, rooms);
		const firstId = await idOnHost(owner, first);
		const lastId = await idOnHost(owner, last);
		await kickAll(owner, rooms, firstId);
		await follow(follower, first.user);

		await move(first, middle);
		const middleId = await idOnHost(owner, middle);
		await waitUntilBannedEverywhere(owner, rooms, middleId, 'the middle account');
		await vi.waitFor(async () => {
			const following = await follower.client.request('users/following', { userId: follower.id });
			strictEqual(following.some(row => row.followeeId === middleId), true);
		}, WAIT_FOR_SLOW_FEDERATION);
		await move(middle, last);
		await waitUntilBannedEverywhere(owner, rooms, lastId, 'the last account');

		await expectCarriedToMember(owner, rooms, last.user, lastId);
		const [room] = rooms;
		await owner.client.request('chat/rooms/bans/delete', { roomId: room.id, userId: lastId });
		await owner.client.request('federation/update-remote-user', { userId: firstId });
		await owner.client.request('federation/update-remote-user', { userId: middleId });
		strictEqual(await isBanned(owner, room, lastId), false);
		strictEqual((await join(last.user, room)).status, 'joined');
	}, MOVE_TEST_TIMEOUT);

	test('when the next move of the new account was processed first', async () => {
		const owner = await createAccount('a.test');
		const hostAdmin = await fetchAdmin('a.test');
		const follower = await createAccount('a.test');
		const first: Account = { user: await createAccount('b.test'), host: 'b.test' };
		// 중간 계정은 그룹 호스트의 계정이라 자기 이전을 곧바로 처리한다.
		const middle: Account = { user: await createAccount('a.test'), host: 'a.test' };
		const last: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const rooms = await createRooms(owner);
		await joinAll(first.user, rooms);
		await joinAll(last.user, rooms);
		const firstId = await idOnHost(owner, first);
		const lastId = await idOnHost(owner, last);
		await kickAll(owner, rooms, firstId);
		await follow(follower, first.user);

		await whileInboxPaused(hostAdmin, async () => {
			await move(first, middle);
			await waitUntilMoveDelivered(await fetchAdmin('b.test'), first.user);
			await move(middle, last);
		});
		await waitUntilMoveProcessed(hostAdmin, first.user);

		await waitUntilBannedEverywhere(owner, rooms, middle.user.id, 'the middle account');
		await waitUntilBannedEverywhere(owner, rooms, lastId, 'the last account');
		await expectCarriedToMember(owner, rooms, last.user, lastId);
		for (const room of rooms) strictEqual(await isBanned(owner, room, firstId), true);
	}, MOVE_TEST_TIMEOUT);

	test('when the host processes both moves at the same time', async () => {
		const owner = await createAccount('a.test');
		const hostAdmin = await fetchAdmin('a.test');
		const senderAdmin = await fetchAdmin('b.test');
		const follower = await createAccount('a.test');
		const middleFollower = await createAccount('a.test');
		const first: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const middle: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const last: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const rooms = await createRooms(owner);
		await joinAll(first.user, rooms);
		await joinAll(last.user, rooms);
		const firstId = await idOnHost(owner, first);
		const lastId = await idOnHost(owner, last);
		await kickAll(owner, rooms, firstId);
		await follow(follower, first.user);
		await follow(middleFollower, middle.user);

		await whileInboxPaused(hostAdmin, async () => {
			await move(first, middle);
			await waitUntilMoveDelivered(senderAdmin, first.user);
			await move(middle, last);
			await waitUntilMoveDelivered(senderAdmin, middle.user);
		});
		await waitUntilMoveProcessed(hostAdmin, first.user);
		await waitUntilMoveProcessed(hostAdmin, middle.user);

		const middleId = await idOnHost(owner, middle);
		await waitUntilBannedEverywhere(owner, rooms, middleId, 'the middle account');
		await waitUntilBannedEverywhere(owner, rooms, lastId, 'the last account');
		await expectCarriedToMember(owner, rooms, last.user, lastId);
	}, MOVE_TEST_TIMEOUT);

	test('through a middle account the host first sees after it moved on', async () => {
		const owner = await createAccount('a.test');
		const hostAdmin = await fetchAdmin('a.test');
		const senderAdmin = await fetchAdmin('b.test');
		const follower = await createAccount('a.test');
		const first: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const middle: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const last: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const rooms = await createRooms(owner);
		await joinAll(first.user, rooms);
		await joinAll(last.user, rooms);
		const firstId = await idOnHost(owner, first);
		const lastId = await idOnHost(owner, last);
		await kickAll(owner, rooms, firstId);
		await follow(follower, first.user);

		await whileInboxPaused(hostAdmin, async () => {
			await move(first, middle);
			await waitUntilMoveDelivered(senderAdmin, first.user);
			await move(middle, last);
		});
		const known = await owner.client.request('federation/users', { host: 'b.test', limit: 100 });
		strictEqual(known.some(user => user.username === middle.user.username), false);
		await waitUntilMoveProcessed(hostAdmin, first.user);

		const middleId = await idOnHost(owner, middle);
		await waitUntilBannedEverywhere(owner, rooms, middleId, 'the middle account');
		await waitUntilBannedEverywhere(owner, rooms, lastId, 'the last account');
		await expectCarriedToMember(owner, rooms, last.user, lastId);

		// 사면은 그 그룹의 금지만 지우고, 같은 이전을 다시 처리해도 되살아나지 않는다.
		const [pardoned, kept] = rooms;
		await owner.client.request('chat/rooms/bans/delete', { roomId: pardoned.id, userId: lastId });
		for (const userId of [firstId, middleId, firstId, middleId]) {
			await owner.client.request('federation/update-remote-user', { userId });
		}
		strictEqual(await isBanned(owner, pardoned, lastId), false);
		strictEqual(await isBanned(owner, kept, lastId), true);
		strictEqual(await isBanned(owner, pardoned, firstId), true);
		strictEqual(await isBanned(owner, pardoned, middleId), true);
		strictEqual(await isMember(owner, pardoned, lastId), false);
		strictEqual((await join(last.user, pardoned)).status, 'joined');
		await owner.client.request('chat/rooms/kick', { roomId: pardoned.id, userId: lastId });
		strictEqual(await isBanned(owner, pardoned, lastId), true);
	}, MOVE_TEST_TIMEOUT);
});

/**
 * 그룹 호스트(a.test)의 inbox가 잠시 503으로 응답하게 하는 파일. 있을 때만 돈다.
 * 보내는 서버는 실패한 배송을 큐에서 다시 보내므로, 앞선 이전의 알림이 뒤쪽 이전보다 늦게 도착한다.
 */
const hostInboxBlock = process.env.CHERRYPICK_FED_A_INBOX_BLOCK;

describe.runIf(hostInboxBlock)('a chat room ban follows a move that arrived late', () => {
	/** 보낸 서버가 이 계정의 이전 알림을 a.test에 넘기지 못해 다시 보내려고 기다린다. */
	async function waitUntilMoveDeferred(sender: LoginUser, actor: LoginUser): Promise<void> {
		await vi.waitFor(async () => {
			const jobs = await sender.client.request('admin/queue/jobs', { queue: 'deliver', state: ['delayed'], search: actor.id });
			const types = jobs.map(job => (JSON.parse((job.data as { content?: string }).content ?? '{}') as { type?: string }).type);
			strictEqual(types.includes('Update') && types.includes('Move'), true);
		}, WAIT_FOR_SLOW_FEDERATION);
	}

	test('after the next move of the new account arrived and was processed', async () => {
		const owner = await createAccount('a.test');
		const hostAdmin = await fetchAdmin('a.test');
		const senderAdmin = await fetchAdmin('b.test');
		const follower = await createAccount('a.test');
		const middleFollower = await createAccount('a.test');
		const first: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const middle: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const last: Account = { user: await createAccount('b.test'), host: 'b.test' };
		const rooms = await createRooms(owner);
		await joinAll(first.user, rooms);
		await joinAll(last.user, rooms);
		const firstId = await idOnHost(owner, first);
		const lastId = await idOnHost(owner, last);
		await kickAll(owner, rooms, firstId);
		await follow(follower, first.user);
		await follow(middleFollower, middle.user);
		await alias(middle, first);
		await alias(last, middle);

		await writeFile(hostInboxBlock!, '');
		try {
			await first.user.client.request('i/move', { moveToAccount: `@${middle.user.username}@b.test` });
			await waitUntilMoveDeferred(senderAdmin, first.user);
		} finally {
			await rm(hostInboxBlock!, { force: true });
		}
		await middle.user.client.request('i/move', { moveToAccount: `@${last.user.username}@b.test` });
		await waitUntilMoveProcessed(hostAdmin, middle.user);
		strictEqual((await inboxJobs(hostAdmin, first.user, ['active', 'wait', 'delayed', 'completed'])).length, 0);
		await waitUntilMoveProcessed(hostAdmin, first.user, WAIT_FOR_INBOX_RETRY);

		const middleId = await idOnHost(owner, middle);
		await waitUntilBannedEverywhere(owner, rooms, middleId, 'the middle account');
		await waitUntilBannedEverywhere(owner, rooms, lastId, 'the last account');
		await expectCarriedToMember(owner, rooms, last.user, lastId);
	}, MOVE_TEST_TIMEOUT);
});

/**
 * 금지 승계 단계에만 일시 장애를 넣는다. a.test의 DB 주소가 있을 때만 돈다.
 * 장애는 이 시험이 만든 새 계정의 금지 행 쓰기에만 걸고 시험이 끝나면 지운다.
 */
const hostDatabase = process.env.CHERRYPICK_FED_A_DB_URL;

describe.runIf(hostDatabase)('a chat room ban carry that failed once', () => {
	type Trigger = 'inbox retry' | 'profile update' | 'remote user refresh';

	async function injectBanWriteFault(db: pg.Client, name: string, userId: string): Promise<void> {
		strictEqual(/^[a-z0-9]+$/.test(userId), true);
		await db.query(`CREATE SEQUENCE "${name}"`);
		await db.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId" = '${userId}' THEN PERFORM nextval('${name}'); RAISE EXCEPTION 'injected ban write failure' USING ERRCODE = '40001'; END IF; RETURN NEW; END; $$`);
		await db.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON "chat_room_ban" FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
	}

	async function removeBanWriteFault(db: pg.Client, name: string): Promise<void> {
		await db.query(`DROP TRIGGER IF EXISTS "${name}" ON "chat_room_ban"`);
		await db.query(`DROP FUNCTION IF EXISTS "${name}"()`);
		await db.query(`DROP SEQUENCE IF EXISTS "${name}"`);
	}

	async function faultFired(db: pg.Client, name: string): Promise<boolean> {
		const result = await db.query<{ is_called: boolean }>(`SELECT "is_called" FROM "${name}"`);
		return result.rows[0].is_called;
	}

	async function followingCount(user: LoginUser): Promise<number> {
		return (await user.client.request('i', {})).followingCount;
	}

	test.each<Trigger>(['inbox retry', 'profile update', 'remote user refresh'])('is completed by the next %s without repeating other relations', async trigger => {
		const db = new pg.Client({ connectionString: hostDatabase });
		await db.connect();
		const fault = `chat_move_ban_fault_${crypto.randomUUID().replaceAll('-', '')}`;
		try {
			const owner = await createAccount('a.test');
			const hostAdmin = await fetchAdmin('a.test');
			const follower = await createAccount('a.test');
			const first: Account = { user: await createAccount('b.test'), host: 'b.test' };
			const next: Account = { user: await createAccount('b.test'), host: 'b.test' };
			const rooms = await createRooms(owner);
			await joinAll(first.user, rooms);
			const firstId = await idOnHost(owner, first);
			const nextId = await idOnHost(owner, next);
			await kickAll(owner, rooms, firstId);
			await follow(follower, first.user);
			await injectBanWriteFault(db, fault, nextId);

			await move(first, next);
			await vi.waitFor(async () => strictEqual(await faultFired(db, fault), true), WAIT_FOR_SLOW_FEDERATION);
			await vi.waitFor(async () => {
				const following = await follower.client.request('users/following', { userId: follower.id });
				strictEqual(following.filter(row => row.followeeId === nextId).length, 1);
			}, WAIT_FOR_SLOW_FEDERATION);
			await vi.waitFor(async () => strictEqual((await inboxJobs(hostAdmin, first.user, ['active', 'wait'])).length, 0), WAIT_FOR_SLOW_FEDERATION);
			const failedJobs = await inboxJobs(hostAdmin, first.user, ['completed', 'delayed', 'failed']);
			console.log('move-ban fault observation', JSON.stringify({ trigger, jobs: describeJobs(failedJobs) }));
			for (const room of rooms) {
				strictEqual(await isBanned(owner, room, firstId), true);
				strictEqual(await isBanned(owner, room, nextId), false);
			}
			const countBefore = await followingCount(follower);
			await removeBanWriteFault(db, fault);

			if (trigger === 'profile update') {
				const name = crypto.randomUUID().slice(0, 8);
				await first.user.client.request('i/update', { name });
				await vi.waitFor(async () => strictEqual((await owner.client.request('users/show', { userId: firstId })).name, name), WAIT_FOR_SLOW_FEDERATION);
			} else if (trigger === 'remote user refresh') {
				await owner.client.request('federation/update-remote-user', { userId: firstId });
			}
			await waitUntilBannedEverywhere(owner, rooms, nextId, 'the new account', trigger === 'inbox retry' ? WAIT_FOR_INBOX_RETRY : WAIT_FOR_SLOW_FEDERATION);
			const carriedJobs = await inboxJobs(hostAdmin, first.user, ['completed', 'delayed', 'failed']);
			console.log('move-ban recovery observation', JSON.stringify({ trigger, jobs: describeJobs(carriedJobs) }));

			for (const room of rooms) {
				strictEqual(await banCount(owner, room, nextId), 1);
				strictEqual(await isBanned(owner, room, firstId), true);
			}
			const following = await follower.client.request('users/following', { userId: follower.id });
			strictEqual(following.filter(row => row.followeeId === nextId).length, 1);
			strictEqual(await followingCount(follower), countBefore);

			const [pardoned, kept] = rooms;
			await owner.client.request('chat/rooms/bans/delete', { roomId: pardoned.id, userId: nextId });
			await vi.waitFor(async () => strictEqual((await inboxJobs(hostAdmin, first.user, ['active', 'wait', 'delayed'])).length, 0), WAIT_FOR_INBOX_RETRY);
			await owner.client.request('federation/update-remote-user', { userId: firstId });
			strictEqual(await isBanned(owner, pardoned, nextId), false);
			strictEqual(await isBanned(owner, kept, nextId), true);
			strictEqual((await join(next.user, pardoned)).status, 'joined');
			strictEqual((await join(next.user, kept)).reason, 'banned');
			strictEqual(await followingCount(follower), countBefore);
		} finally {
			await removeBanWriteFault(db, fault);
			await db.end();
		}
	}, MOVE_TEST_TIMEOUT);
});
