/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type * as Redis from 'ioredis';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import type { IInvite, IObject } from '@/core/activitypub/type.js';
import { IdService } from '@/core/IdService.js';
import { renderChatJoinReject } from '@/core/chat-invite-link.js';
import { MiChatRoom, MiChatRoomInvitation, MiChatRoomMembership, MiUser } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { api, connectStream, initTestDb, origin, signup } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

/** DB·Redis와 제품 inbox 처리·HTTP·stream을 사용한다. 원격 서명 전송은 federation 시험에서 별도로 검증한다. */
describe('초대 요청과 현재 멤버십의 상태', () => {
	let db: Awaited<ReturnType<typeof initTestDb>>;
	let app: TestingModule;
	const keys: string[] = [];

	beforeAll(async () => {
		// 파일마다 새 DB이며 연합 기본값은 none이다. 다른 서버 그룹의 초대·참여를 다루므로 시험 앱을 만들기 전에 연합을 연다
		const root = await signup({ username: 'root' });
		expect((await api('admin/update-meta', { federation: 'all' }, root)).status).toBe(204);
		db = await initTestDb(true);
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(DI.db).useValue(db)
			.compile();
		await app.init();
	});

	afterAll(async () => {
		if (app != null) {
			const redis = app.get<Redis.Redis>(DI.redis);
			if (keys.length > 0) await redis.del(...keys);
			await waitForChatNotificationTurn();
			await app.close();
		}
		if (db?.isInitialized) await db.destroy();
	}, 30_000);

	async function fixture() {
		const user = await signup();
		const ids = app.get(IdService);
		const ownerId = ids.gen();
		const remote = 'https://invite-state.example';
		await db.getRepository(MiUser).insert({
			id: ownerId, username: ownerId, usernameLower: ownerId.toLowerCase(), host: 'invite-state.example',
			uri: `${remote}/users/${ownerId}`, inbox: `${remote}/inbox`, lastFetchedAt: new Date(),
		});
		const owner = await db.getRepository(MiUser).findOneByOrFail({ id: ownerId }) as MiRemoteUser;
		const roomUri = `${remote}/chat/rooms/${ids.gen()}`;
		const url = `${remote}/chat/invite/${ids.gen()}`;
		const join = { id: `${origin}/activities/${ids.gen()}`, actor: `${origin}/users/${user.id}`, object: url };
		const room = await db.getRepository(MiChatRoom).save({ id: ids.gen(), ownerId, uri: roomUri, name: '모임' });
		return { user, owner, room, roomUri, url, join };
	}

	type Fixture = Awaited<ReturnType<typeof fixture>>;

	async function remember(f: Fixture, state: 'pending' | 'joined' | 'invited', joinId = f.join.id) {
		const redis = app.get<Redis.Redis>(DI.redis);
		const hash = (value: string) => createHash('sha256').update(value).digest('hex');
		const roomKey = `chatInviteJoin:${f.user.id}:${hash(f.roomUri)}`;
		const urlKey = `chatInviteJoinUrl:${f.user.id}:${hash(f.url)}`;
		keys.push(roomKey, urlKey);
		// 이전 요청 기록만 fixture로 준비한다. 멤버십은 제품의 Invite·수락·탈퇴 경로로 만든다.
		await redis.set(roomKey, JSON.stringify({ joinId, url: f.url, roomUri: f.roomUri, state, reason: null, roomId: f.room.id, afterAccept: false }), 'EX', 1800);
		await redis.set(urlKey, f.roomUri, 'EX', 1800);
	}

	function invitation(f: Fixture, published = new Date().toISOString()): IInvite {
		return {
			id: `${f.owner.uri}/invite/${app.get(IdService).gen()}`, type: 'Invite', actor: f.owner.uri,
			object: { id: f.roomUri, type: 'Group', attributedTo: f.owner.uri, name: f.room.name },
			target: `${origin}/users/${f.user.id}`, published,
		};
	}

	async function isMember(f: Fixture) {
		return await db.getRepository(MiChatRoomMembership).existsBy({ roomId: f.room.id, userId: f.user.id });
	}

	async function status(f: Fixture) {
		const response = await api('chat/invite-link/join-status', { url: f.url }, f.user);
		expect(response.status).toBe(200);
		return response.body;
	}

	async function refuse(f: Fixture) {
		return await app.get(ApInboxService).performOneActivity(f.owner, {
			id: `${f.owner.uri}/reject/${app.get(IdService).gen()}`,
			...renderChatJoinReject({ actor: f.owner.uri, join: f.join, reason: 'full', published: new Date().toISOString() }),
		});
	}

	test.each(['pending', 'joined', 'invited'] as const)('%s 기록과 다른 개별 초대로 성립한 현재 멤버십을 늦은 Join 거절이 덮지 않는다', async state => {
		const f = await fixture();
		expect(await app.get(ApInboxService).performOneActivity(f.owner, invitation(f))).toBe('ok');
		expect(await isMember(f)).toBe(false);
		await remember(f, state);
		expect((await api('chat/rooms/join', { roomId: f.room.id }, f.user)).status).toBe(204);
		expect(await isMember(f)).toBe(true);
		const received: unknown[] = [];
		const stream = await connectStream(f.user, 'main', event => {
			if (event.type === 'chatInviteJoinResult') received.push(event.body);
		});

		try {
			expect(await refuse(f)).toBe('ok: Join refused (full)');

			expect(await isMember(f)).toBe(true);
			expect(await status(f)).toEqual({ status: 'joined', roomId: f.room.id, reason: null });
			await expect.poll(() => received.length).toBe(1);
			expect(received[0]).toEqual({ url: f.url, status: 'joined', roomId: f.room.id, reason: null });
		} finally {
			stream.close();
		}
	});

	test('자동 수락 뒤 자진 탈퇴하면 같은 Invite의 재배달만으로 다시 가입하지 않는다', async () => {
		const f = await fixture();
		await remember(f, 'pending');
		const activity = invitation(f);
		expect(await app.get(ApInboxService).performOneActivity(f.owner, activity)).toBe('ok: joined through an invite link');
		expect(await isMember(f)).toBe(true);
		expect((await api('chat/rooms/leave', { roomId: f.room.id }, f.user)).status).toBe(204);
		expect(await isMember(f)).toBe(false);

		await app.get(ApInboxService).performOneActivity(f.owner, activity);

		expect(await isMember(f)).toBe(false);
		expect((await status(f)).status).not.toBe('joined');
	});

	test('자동 수락은 개별 초대처럼 로컬 가입 직후 참여로 알리고, 호스트가 그 Accept를 거절하면 사유와 함께 바로잡는다', async () => {
		const f = await fixture();
		const invitedAt = Date.now() - 10_000;
		await remember(f, 'pending');
		const received: unknown[] = [];
		const stream = await connectStream(f.user, 'main', event => {
			if (event.type === 'chatInviteJoinResult') received.push(event.body);
		});

		try {
			// 로컬 가입 직후: 기존 개별 초대 수락처럼 이 서버에 멤버십을 만들고 Accept는 비동기로 보낸다. 호스트 처리는 아직이다
			expect(await app.get(ApInboxService).performOneActivity(f.owner, invitation(f, new Date(invitedAt).toISOString()))).toBe('ok: joined through an invite link');
			expect(await isMember(f)).toBe(true);
			expect(await status(f)).toEqual({ status: 'joined', roomId: f.room.id, reason: null });
			await expect.poll(() => received.length).toBe(1);
			expect(received[0]).toEqual({ url: f.url, status: 'joined', roomId: f.room.id, reason: null });

			// 호스트 처리 완료(거절): 사유를 담은 Reject가 Remove보다 먼저 와도 그 자동 수락 멤버십의 거절로 알린다
			expect(await refuse(f)).toBe('ok: Join refused (full)');
			expect(await status(f)).toEqual({ status: 'refused', roomId: null, reason: 'full' });
			await expect.poll(() => received.length).toBe(2);
			expect(received[1]).toEqual({ url: f.url, status: 'refused', roomId: null, reason: 'full' });

			// 이어서 온 호스트의 정상 Remove가 이 서버의 멤버십을 끝내고, 상태는 거절 사유를 유지한다
			const removed = await app.get(ApInboxService).performOneActivity(f.owner, {
				id: `${f.owner.uri}/remove/${app.get(IdService).gen()}`, type: 'Remove', actor: f.owner.uri,
				target: f.roomUri, object: `${origin}/users/${f.user.id}`, published: new Date(invitedAt + 1000).toISOString(),
			} as IObject);
			expect(removed).toBe('ok: removed from chat room');
			expect(await isMember(f)).toBe(false);
			expect(await status(f)).toEqual({ status: 'refused', roomId: null, reason: 'full' });
		} finally {
			stream.close();
		}
	});

	test('실제 멤버십 없이 대기 중인 요청의 거절은 실패 사유를 그대로 돌려준다', async () => {
		const f = await fixture();
		await remember(f, 'pending');

		await refuse(f);

		expect(await isMember(f)).toBe(false);
		expect(await status(f)).toEqual({ status: 'refused', roomId: null, reason: 'full' });
	});

	test('같은 주소로 다시 보낸 새 Join이 있으면 오래된 Join의 거절을 무시한다', async () => {
		const f = await fixture();
		await remember(f, 'pending');
		await remember(f, 'pending', `${origin}/activities/${app.get(IdService).gen()}`);

		expect(await refuse(f)).toMatch(/^skip:/);

		expect(await isMember(f)).toBe(false);
		expect(await status(f)).toEqual({ status: 'pending', roomId: null, reason: null });
	});

	test('그룹 호스트의 정상 Remove는 실제 멤버십을 제거하고 늦은 Join 거절과 구분된다', async () => {
		const f = await fixture();
		const invitedAt = Date.now() - 10_000;
		expect(await app.get(ApInboxService).performOneActivity(f.owner, invitation(f, new Date(invitedAt).toISOString()))).toBe('ok');
		await remember(f, 'pending');
		expect((await api('chat/rooms/join', { roomId: f.room.id }, f.user)).status).toBe(204);
		await refuse(f);
		expect(await isMember(f)).toBe(true);

		const result = await app.get(ApInboxService).performOneActivity(f.owner, {
			id: `${f.owner.uri}/remove/${app.get(IdService).gen()}`, type: 'Remove', actor: f.owner.uri,
			target: f.roomUri, object: `${origin}/users/${f.user.id}`, published: new Date(invitedAt + 1000).toISOString(),
		} as IObject);

		expect(result).toBe('ok: removed from chat room');
		expect(await isMember(f)).toBe(false);
		expect(await status(f)).toEqual({ status: 'refused', roomId: null, reason: 'full' });
	});

	async function hostedJoin() {
		const owner = await signup();
		const remote = await fixture();
		const created = await api('chat/rooms/create', { name: '현재 링크 판정' }, owner);
		expect(created.status).toBe(200);
		const room = created.body;
		const linked = await api('chat/rooms/invite-link/create', { roomId: room.id }, owner);
		expect(linked.status).toBe(200);
		const link = linked.body;
		const join = { id: `${remote.owner.uri}/join/${app.get(IdService).gen()}`, type: 'Join', actor: remote.owner.uri, object: link.url };
		keys.push(`chatInviteJoinInvitation:${room.id}:${remote.owner.id}`);
		return { owner, applicant: remote.owner, room, link, join };
	}

	async function acceptHosted(f: Awaited<ReturnType<typeof hostedJoin>>) {
		const invitation = await db.getRepository(MiChatRoomInvitation).findOneByOrFail({ roomId: f.room.id, userId: f.applicant.id });
		return await app.get(ApInboxService).performOneActivity(f.applicant, {
			id: `${f.applicant.uri}/accept/${app.get(IdService).gen()}`, type: 'Accept', actor: f.applicant.uri,
			object: {
				type: 'Invite', actor: `${origin}/users/${f.owner.id}`,
				object: { id: `${origin}/chat/rooms/${f.room.id}`, type: 'Group' }, target: f.applicant.uri,
				published: app.get(IdService).parse(invitation.id).date.toISOString(),
			},
			published: new Date().toISOString(),
		} as IObject);
	}

	test('유효할 때 판정한 Join의 개별 초대는 코드 폐기 뒤에도 기존 수락 계약을 유지한다', async () => {
		const f = await hostedJoin();
		expect(await app.get(ApInboxService).performOneActivity(f.applicant, f.join)).toBe('ok: invited');
		expect((await api('chat/rooms/invite-link/revoke', { roomId: f.room.id }, f.owner)).status).toBe(204);

		const result = await acceptHosted(f);

		expect(result).toBe('ok');
		expect(await db.getRepository(MiChatRoomMembership).existsBy({ roomId: f.room.id, userId: f.applicant.id })).toBe(true);
		expect(await app.get(ApInboxService).performOneActivity(f.applicant, { ...f.join, id: `${f.applicant.uri}/join/${app.get(IdService).gen()}` })).toBe('ok: Join refused (revoked)');
		expect(await db.getRepository(MiChatRoomMembership).existsBy({ roomId: f.room.id, userId: f.applicant.id })).toBe(true);
	});

	test('이미 성립한 호스트 멤버십은 이후 코드 폐기와 오래된 요청의 처리로 제거하지 않는다', async () => {
		const f = await hostedJoin();
		expect(await app.get(ApInboxService).performOneActivity(f.applicant, f.join)).toBe('ok: invited');
		expect(await acceptHosted(f)).toBe('ok');
		expect(await db.getRepository(MiChatRoomMembership).existsBy({ roomId: f.room.id, userId: f.applicant.id })).toBe(true);
		expect(await app.get(ApInboxService).performOneActivity(f.applicant, { ...f.join, id: `${f.applicant.uri}/join/${app.get(IdService).gen()}` })).toBe('ok: invited a member again');
		expect((await api('chat/rooms/invite-link/revoke', { roomId: f.room.id }, f.owner)).status).toBe(204);

		await acceptHosted(f);

		expect(await db.getRepository(MiChatRoomMembership).existsBy({ roomId: f.room.id, userId: f.applicant.id })).toBe(true);
	});
});
