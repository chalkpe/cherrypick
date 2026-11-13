/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { initExtraThreadPool, jobQueue } from '@/boot/common.js';
import { loadConfig } from '@/config.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { genAidx } from '@/misc/id/aidx.js';
import { MiChatRoomInvitation } from '@/models/ChatRoomInvitation.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiUserPublickey } from '@/models/UserPublickey.js';
import { api, castAsError, host, initTestDb, origin, port, signup } from '../utils.js';
import type * as misskey from 'cherrypick-js';

const REMOTE_HOST = 'ban-remote.test';

type RemoteActor = { id: string; uri: string; keyId: string; privateKeyPem: string };
type User = misskey.entities.SignupResponse;

function code(res: { body: unknown }): string | undefined {
	return castAsError(res.body as Record<string, unknown>).error?.code;
}

describe('그룹 재참여 금지와 사면', () => {
	let jq: INestApplicationContext;
	let db: DataSource;
	let root: User;
	let owner: User;

	async function createUser(name: string): Promise<User> {
		return await signup({ username: `${name}${randomUUID().slice(0, 8).replaceAll('-', '')}` });
	}

	async function createRoom(channels: boolean): Promise<string> {
		const res = await api('chat/rooms/create', { name: `group ${randomUUID().slice(0, 8)}` }, owner);
		assert.strictEqual(res.status, 200);
		if (channels) assert.strictEqual((await api('chat/rooms/convert-to-channels', { roomId: res.body.id }, owner)).status, 200);
		return res.body.id;
	}

	async function invite(roomId: string, userId: string) {
		return await api('chat/rooms/invitations/create', { roomId, userId }, owner);
	}

	async function join(roomId: string, user: User) {
		assert.strictEqual((await invite(roomId, user.id)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId }, user)).status, 204);
	}

	async function memberIds(roomId: string): Promise<string[]> {
		const res = await api('chat/rooms/members', { roomId, limit: 100 }, owner);
		assert.strictEqual(res.status, 200);
		return res.body.map(membership => membership.userId);
	}

	async function bannedIds(roomId: string): Promise<string[]> {
		const res = await api('chat/rooms/bans/list', { roomId, limit: 100 }, owner);
		assert.strictEqual(res.status, 200);
		return res.body.map(ban => ban.userId);
	}

	/** 내보내기 전에 보낸 초대의 fixture. 멤버에게는 API로 초대를 만들 수 없어 DB에 직접 넣는다. */
	async function insertInvitation(roomId: string, userId: string): Promise<void> {
		await db.getRepository(MiChatRoomInvitation).insert({ id: genAidx(Date.now()), roomId, userId });
	}

	async function createRemoteActor(name: string): Promise<RemoteActor> {
		const { publicKey, privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const id = genAidx(Date.now());
		const username = `${name}${id}`;
		const uri = `https://${REMOTE_HOST}/users/${username}`;
		await db.getRepository(MiUser).insert({
			id, username, usernameLower: username.toLowerCase(), host: REMOTE_HOST, uri,
			inbox: `${uri}/inbox`, sharedInbox: `https://${REMOTE_HOST}/inbox`, lastFetchedAt: new Date(),
		});
		await db.getRepository(MiUserProfile).insert({ userId: id });
		await db.getRepository(MiUserPublickey).insert({ userId: id, keyId: `${uri}#main-key`, keyPem: publicKey });
		return { id, uri, keyId: `${uri}#main-key`, privateKeyPem: privateKey };
	}

	/** 원격 계정의 키로 서명해 실제 inbox에 보내고 활동 ID를 돌려준다. */
	async function postToInbox(actor: RemoteActor, activity: Record<string, unknown>): Promise<string> {
		const id = `https://${REMOTE_HOST}/activities/${randomUUID()}`;
		const body = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id, actor: actor.uri, published: new Date().toISOString(), ...activity });
		const signed = await ApRequestCreator.createSignedPost({ key: { keyId: actor.keyId, privateKeyPem: actor.privateKeyPem }, url: `${origin}/inbox`, body, additionalHeaders: {} });
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest({ host: '127.0.0.1', port, path: '/inbox', method: 'POST', headers: { ...signed.request.headers, host } }, res => {
				res.resume();
				res.on('end', () => resolve(res.statusCode ?? 0));
			});
			req.on('error', reject);
			req.end(body);
		});
		assert.strictEqual(status, 202);
		return id;
	}

	/** inbox 작업이 끝난 뒤 그 활동을 처리한 결과. */
	async function inboxResult(activityId: string): Promise<string> {
		const key = activityId.split('/').at(-1)!;
		return await vi.waitFor(async () => {
			const res = await api('admin/queue/jobs', { queue: 'inbox', state: ['completed', 'failed'], search: key }, root);
			assert.strictEqual(res.status, 200);
			const job = res.body.find(candidate => JSON.stringify(candidate.data).includes(key));
			if (job == null) throw new Error(`the inbox has not finished ${activityId}`);
			return String(job.returnValue ?? job.failedReason);
		}, { timeout: 20_000, interval: 100 });
	}

	function acceptInvite(actor: RemoteActor, roomId: string) {
		return postToInbox(actor, {
			type: 'Accept',
			object: { type: 'Invite', actor: `${origin}/users/${owner.id}`, object: { type: 'Group', id: `${origin}/chat/rooms/${roomId}`, name: 'group' }, target: actor.uri },
		});
	}

	beforeAll(async () => {
		// 운영 부팅처럼 작업 큐보다 먼저 서명 라이브러리를 준비한다. 이 시험 프로세스도 원격 계정으로 inbox 요청에 서명한다.
		initExtraThreadPool(loadConfig());
		jq = await jobQueue();
		db = await initTestDb(true);
		root = await signup({ username: 'root' });
		// 다른 연합 e2e처럼 연합을 연다. 기본값 none에서는 inbox가 요청을 처리하지 않고 403으로 거절한다.
		assert.strictEqual((await api('admin/update-meta', { federation: 'all' }, root)).status, 204);
		owner = await createUser('owner');
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await jq.close();
		await db.destroy();
	});

	describe.each([
		['일반 그룹', false],
		['채널형 그룹', true],
	])('%s', (_label, channels) => {
		test('개별 초대는 앞서 대기한 보관 요청과 같은 그룹 잠금을 지킨다', async () => {
			const roomId = await createRoom(channels);
			const member = await createUser('member');
			const holder = db.createQueryRunner();
			const pending: Promise<unknown>[] = [];
			let archive: ReturnType<typeof api> | undefined;
			let invitation: ReturnType<typeof invite> | undefined;
			let invitationCompleted = false;

			await holder.connect();
			await holder.startTransaction();
			try {
				await holder.manager.findOneOrFail(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
				const waitForRequests = async (count: number) => vi.waitFor(async () => {
					const [{ waiting }] = await db.query('SELECT count(*)::int AS "waiting" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\'') as { waiting: number }[];
					assert.strictEqual(invitationCompleted, false, '초대가 그룹 잠금을 기다리지 않고 완료됨');
					assert.ok(waiting >= count, `${waiting}/${count} requests waiting`);
				}, { timeout: 10_000, interval: 20 });

				archive = api('chat/rooms/update', { roomId, isArchived: true }, owner);
				pending.push(archive);
				await waitForRequests(1);
				invitation = invite(roomId, member.id).then(response => {
					invitationCompleted = true;
					return response;
				});
				pending.push(invitation);
				await waitForRequests(2);
			} finally {
				await holder.rollbackTransaction();
				await holder.release();
				await Promise.allSettled(pending);
			}

			assert.ok(archive);
			assert.ok(invitation);
			assert.strictEqual((await archive).status, 200);
			assert.strictEqual(code(await invitation), 'ROOM_IS_ARCHIVED');
			const outbox = await api('chat/rooms/invitations/outbox', { roomId, limit: 100 }, owner);
			assert.deepStrictEqual(outbox.body, []);
		});

		test('그룹장이 내보낸 사람은 다시 초대받을 수 없고 거절에 그 사유가 있다', async () => {
			const roomId = await createRoom(channels);
			const member = await createUser('member');
			await join(roomId, member);

			assert.strictEqual((await api('chat/rooms/kick', { roomId, userId: member.id }, owner)).status, 204);

			assert.deepStrictEqual(await memberIds(roomId), []);
			assert.deepStrictEqual(await bannedIds(roomId), [member.id]);
			const again = await invite(roomId, member.id);
			assert.strictEqual(again.status, 400);
			assert.strictEqual(code(again), 'USER_IS_BANNED');
		});

		test('내보내기 전에 받은 초대로도 들어올 수 없고 사유를 알려 준다', async () => {
			const roomId = await createRoom(channels);
			const member = await createUser('member');
			await join(roomId, member);
			await api('chat/rooms/kick', { roomId, userId: member.id }, owner);
			await insertInvitation(roomId, member.id);

			const res = await api('chat/rooms/join', { roomId }, member);

			assert.strictEqual(res.status, 400);
			assert.strictEqual(code(res), 'BANNED_FROM_ROOM');
			assert.deepStrictEqual(await memberIds(roomId), []);
		});

		test('내보낸 사람 목록과 사면은 그룹장만 쓸 수 있다', async () => {
			const roomId = await createRoom(channels);
			const member = await createUser('member');
			const removed = await createUser('removed');
			const outsider = await createUser('outsider');
			await join(roomId, member);
			await join(roomId, removed);
			await api('chat/rooms/kick', { roomId, userId: removed.id }, owner);

			for (const user of [member, removed, outsider]) {
				const list = await api('chat/rooms/bans/list', { roomId }, user);
				assert.strictEqual(list.status, 400);
				assert.strictEqual(code(list), 'NO_SUCH_ROOM');
				const pardon = await api('chat/rooms/bans/delete', { roomId, userId: removed.id }, user);
				assert.strictEqual(pardon.status, 400);
				assert.strictEqual(code(pardon), 'NO_SUCH_ROOM');
			}
			assert.strictEqual((await api('chat/rooms/bans/list', { roomId })).status, 401);
			assert.deepStrictEqual(await bannedIds(roomId), [removed.id]);
		});

		test('사면은 금지만 풀고 멤버십·초대·알림을 만들지 않으며 그 뒤 다시 참여할 수 있다', async () => {
			const roomId = await createRoom(channels);
			const member = await createUser('member');
			await join(roomId, member);
			await api('chat/rooms/kick', { roomId, userId: member.id }, owner);
			const before = {
				notifications: (await api('i/notifications', { limit: 100 }, member)).body.map(notification => notification.id),
				invitations: (await api('chat/rooms/invitations/inbox', { limit: 100 }, member)).body.length,
				outbox: (await api('chat/rooms/invitations/outbox', { roomId, limit: 100 }, owner)).body.length,
				joining: (await api('chat/rooms/joining', { limit: 100 }, member)).body.length,
			};

			assert.strictEqual((await api('chat/rooms/bans/delete', { roomId, userId: member.id }, owner)).status, 204);

			assert.deepStrictEqual({
				notifications: (await api('i/notifications', { limit: 100 }, member)).body.map(notification => notification.id),
				invitations: (await api('chat/rooms/invitations/inbox', { limit: 100 }, member)).body.length,
				outbox: (await api('chat/rooms/invitations/outbox', { roomId, limit: 100 }, owner)).body.length,
				joining: (await api('chat/rooms/joining', { limit: 100 }, member)).body.length,
			}, before);
			assert.deepStrictEqual(await memberIds(roomId), []);
			assert.deepStrictEqual(await bannedIds(roomId), []);
			const twice = await api('chat/rooms/bans/delete', { roomId, userId: member.id }, owner);
			assert.strictEqual(code(twice), 'NO_SUCH_BAN');

			await join(roomId, member);
			assert.deepStrictEqual(await memberIds(roomId), [member.id]);
		});

		test('스스로 나간 사람은 금지되지 않아 다시 초대받아 참여할 수 있다', async () => {
			const roomId = await createRoom(channels);
			const member = await createUser('member');
			await join(roomId, member);

			assert.strictEqual((await api('chat/rooms/leave', { roomId }, member)).status, 204);

			assert.deepStrictEqual(await bannedIds(roomId), []);
			await join(roomId, member);
			assert.deepStrictEqual(await memberIds(roomId), [member.id]);
		});
	});

	describe('다른 서버 계정 (서명된 inbox 요청)', () => {
		test('내보낸 계정이 이전 초대에 보낸 Accept는 멤버를 만들지 않고 초대를 소비한다', async () => {
			const roomId = await createRoom(false);
			const remote = await createRemoteActor('remote');
			assert.strictEqual((await invite(roomId, remote.id)).status, 200);
			assert.match(await inboxResult(await acceptInvite(remote, roomId)), /^ok/);
			assert.deepStrictEqual(await memberIds(roomId), [remote.id]);

			assert.strictEqual((await api('chat/rooms/kick', { roomId, userId: remote.id }, owner)).status, 204);
			await insertInvitation(roomId, remote.id);
			const result = await inboxResult(await acceptInvite(remote, roomId));

			assert.strictEqual(result, 'skip: banned from the room');
			assert.deepStrictEqual(await memberIds(roomId), []);
			assert.deepStrictEqual((await api('chat/rooms/invitations/outbox', { roomId, limit: 100 }, owner)).body.map(invitation => invitation.userId), []);
			assert.strictEqual(code(await invite(roomId, remote.id)), 'USER_IS_BANNED');
		});

		test('위조된 Remove와 스스로 나가는 Remove는 금지를 만들지 않는다', async () => {
			const roomId = await createRoom(true);
			const [first, second] = [await createRemoteActor('first'), await createRemoteActor('second')];
			for (const remote of [first, second]) {
				assert.strictEqual((await invite(roomId, remote.id)).status, 200);
				assert.match(await inboxResult(await acceptInvite(remote, roomId)), /^ok/);
			}

			const forged = await inboxResult(await postToInbox(second, { type: 'Remove', object: first.uri, target: `${origin}/chat/rooms/${roomId}` }));
			assert.strictEqual(forged, 'skip: only the room owner can remove another member');
			assert.deepStrictEqual((await memberIds(roomId)).sort(), [first.id, second.id].sort());

			assert.match(await inboxResult(await postToInbox(first, { type: 'Remove', object: first.uri, target: `${origin}/chat/rooms/${roomId}` })), /^ok/);
			assert.deepStrictEqual(await memberIds(roomId), [second.id]);
			assert.deepStrictEqual(await bannedIds(roomId), []);
			assert.strictEqual((await invite(roomId, first.id)).status, 200);
		});

		test('계정 정지에 따른 자동 퇴장은 금지를 남기지 않는다', async () => {
			const roomId = await createRoom(false);
			const remote = await createRemoteActor('suspended');
			assert.strictEqual((await invite(roomId, remote.id)).status, 200);
			assert.match(await inboxResult(await acceptInvite(remote, roomId)), /^ok/);

			assert.strictEqual((await api('admin/suspend-user', { userId: remote.id }, root)).status, 204);
			await vi.waitFor(async () => assert.deepStrictEqual(await memberIds(roomId), []), { timeout: 10_000, interval: 100 });
			assert.deepStrictEqual(await bannedIds(roomId), []);

			assert.strictEqual((await api('admin/unsuspend-user', { userId: remote.id }, root)).status, 204);
			assert.strictEqual((await invite(roomId, remote.id)).status, 200);
		});
	});

	describe('계정 이전', () => {
		async function move(from: User, to: User): Promise<void> {
			assert.strictEqual((await api('i/update', { alsoKnownAs: [`@${from.username}@${host}`] }, to)).status, 200);
			assert.strictEqual((await api('i/move', { moveToAccount: `@${to.username}@${host}` }, from)).status, 200);
		}

		test('금지 승계 저장 실패를 성공한 이전으로 숨기지 않고 복구 뒤 금지를 유지한다', async () => {
			const roomId = await createRoom(false);
			const oldAccount = await createUser('old');
			const newAccount = await createUser('new');
			await join(roomId, oldAccount);
			assert.strictEqual((await api('chat/rooms/kick', { roomId, userId: oldAccount.id }, owner)).status, 204);
			assert.strictEqual((await api('i/update', { alsoKnownAs: [`@${oldAccount.username}@${host}`] }, newAccount)).status, 200);

			// 일회용 DB의 명시적인 저장 장애다. sequence로 실제 승계 INSERT 도달을 확인한다.
			const name = `ban_copy_fault_${randomUUID().replaceAll('-', '')}`;
			assert.match(newAccount.id, /^[a-zA-Z0-9]+$/);
			await db.query(`CREATE SEQUENCE "${name}"`);
			await db.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId" = '${newAccount.id}' THEN PERFORM nextval('${name}'); RAISE EXCEPTION 'ban copy failure probe' USING ERRCODE = '40001'; END IF; RETURN NEW; END; $$`);
			await db.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON chat_room_ban FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
			let moved = false;
			try {
				const result = await api('i/move', { moveToAccount: `@${newAccount.username}@${host}` }, oldAccount);
				const [{ is_called: attempted }] = await db.query(`SELECT is_called FROM "${name}"`) as { is_called: boolean }[];
				assert.strictEqual(attempted, true, '금지 승계 저장 분기에 도달하지 못함');
				moved = result.status === 200;
				if (moved) {
					const invitation = await invite(roomId, newAccount.id);
					assert.deepStrictEqual({ status: invitation.status, code: code(invitation) }, { status: 400, code: 'USER_IS_BANNED' });
				} else {
					assert.ok(result.status >= 400);
				}
			} finally {
				await db.query(`DROP TRIGGER "${name}" ON chat_room_ban`);
				await db.query(`DROP FUNCTION "${name}"()`);
				await db.query(`DROP SEQUENCE "${name}"`);
			}

			if (!moved) await move(oldAccount, newAccount);
			await vi.waitFor(async () => assert.deepStrictEqual((await bannedIds(roomId)).sort(), [oldAccount.id, newAccount.id].sort()), { timeout: 10_000, interval: 100 });
		});

		test('검증된 이전은 새 계정에 금지를 잇고 옛 계정의 금지도 남긴다', async () => {
			const roomId = await createRoom(true);
			const oldAccount = await createUser('old');
			const newAccount = await createUser('new');
			const claimant = await createUser('claimant');
			await join(roomId, oldAccount);
			await api('chat/rooms/kick', { roomId, userId: oldAccount.id }, owner);
			// 옛 계정이 실제로 이전한 대상만 같은 사람이다. 옛 계정을 별칭으로 적기만 한 계정은 아니다.
			assert.strictEqual((await api('i/update', { alsoKnownAs: [`@${oldAccount.username}@${host}`] }, claimant)).status, 200);

			await move(oldAccount, newAccount);

			await vi.waitFor(async () => assert.deepStrictEqual((await bannedIds(roomId)).sort(), [oldAccount.id, newAccount.id].sort()), { timeout: 10_000, interval: 100 });
			assert.strictEqual(code(await invite(roomId, newAccount.id)), 'USER_IS_BANNED');
			assert.strictEqual((await invite(roomId, claimant.id)).status, 200);
		});

		test('이미 멤버인 새 계정은 그대로 두고 다시 들어오는 것만 막는다', async () => {
			const roomId = await createRoom(false);
			const oldAccount = await createUser('old');
			const newAccount = await createUser('new');
			await join(roomId, oldAccount);
			await api('chat/rooms/kick', { roomId, userId: oldAccount.id }, owner);
			await join(roomId, newAccount);

			await move(oldAccount, newAccount);

			await vi.waitFor(async () => assert.ok((await bannedIds(roomId)).includes(newAccount.id)), { timeout: 10_000, interval: 100 });
			assert.deepStrictEqual(await memberIds(roomId), [newAccount.id]);
			assert.strictEqual((await api('chat/rooms/leave', { roomId }, newAccount)).status, 204);
			assert.strictEqual(code(await invite(roomId, newAccount.id)), 'USER_IS_BANNED');
		});
	});
});
