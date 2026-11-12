/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import push from 'web-push';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { IdService } from '@/core/IdService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { ChatService } from '@/core/ChatService.js';
import type { Config } from '@/config.js';
import type * as Redis from 'ioredis';
import { MiChatMessage, MiChatRoom, MiChatRoomMembership, MiChatRoomUnread, MiChatRoomUserSettings, MiUser } from '@/models/_.js';
import type { MiMeta, SwSubscriptionsRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { api, connectStream, initTestDb, origin, relativeFetch, signup } from '../utils.js';
import type { UserToken } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

type Level = 'all' | 'mentions' | 'none' | 'inherit';
type Settings = { level: Level; effectiveLevel: Exclude<Level, 'inherit'> };
type Unread = { hasUnread: boolean; hasUnreadNotification: boolean; unreadChannelIds: string[]; notificationChannelIds: string[] };

describe('그룹 알림과 채널 읽음', () => {
	let owner: Awaited<ReturnType<typeof signup>>;
	let member: Awaited<ReturnType<typeof signup>>;
	let outsider: Awaited<ReturnType<typeof signup>>;
	let db: Awaited<ReturnType<typeof initTestDb>>;
	let app: TestingModule;

	beforeAll(async () => {
		owner = await signup({ username: 'notifyowner' });
		member = await signup({ username: 'notifymember' });
		outsider = await signup({ username: 'notifyoutsider' });
		db = await initTestDb(true);
		const vapid = push.generateVAPIDKeys();
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(DI.db).useValue(db)
			.overrideProvider(PushNotificationService).useFactory({
				inject: [DI.config, DI.meta, DI.redis, DI.swSubscriptionsRepository, HttpRequestService],
				factory: (config: Config, meta: MiMeta, redis: Redis.Redis, subscriptions: SwSubscriptionsRepository, http: HttpRequestService) => new PushNotificationService(
					{ ...config, url: 'https://notifications.example' },
					{ ...meta, enableServiceWorker: true, swPublicKey: vapid.publicKey, swPrivateKey: vapid.privateKey },
					redis, subscriptions, http,
				),
			}).compile();
		await app.init();
	});

	afterAll(async () => {
		await waitForChatNotificationTurn();
		await app?.close();
		if (db?.isInitialized) await db.destroy();
	}, 30_000);

	async function request<T>(path: string, params: object, user: UserToken) {
		const response = await relativeFetch(`api/chat/rooms/${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...params, i: user.token }),
		});
		const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() as T : null;
		return { status: response.status, body };
	}

	async function settings(roomId: string, user: UserToken, level?: Level, channelId?: string) {
		const result = await request<Settings>('notifications', { roomId, level, channelId }, user);
		expect(result.status, JSON.stringify(result.body)).toBe(200);
		return result.body!;
	}

	async function unread(roomId: string, user: UserToken = owner) {
		const result = await request<Unread>('unread', { roomId }, user);
		expect(result.status, JSON.stringify(result.body)).toBe(200);
		return result.body!;
	}

	async function room(channels = false) {
		const created = await api('chat/rooms/create', { name: '알림 시험' }, owner);
		expect(created.status).toBe(200);
		const roomId = created.body.id;
		expect((await api('chat/rooms/invitations/create', { roomId, userId: member.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, member)).status).toBe(204);
		if (!channels) return { roomId, general: undefined, other: undefined };
		const converted = await api('chat/rooms/convert-to-channels', { roomId }, owner);
		expect(converted.status).toBe(200);
		const other = await api('chat/rooms/channels/create', { roomId, name: '다른 채널' }, owner);
		expect(other.status).toBe(200);
		return { roomId, general: converted.body.legacyChannelId!, other: other.body.id };
	}

	async function send(roomId: string, channelId: string | undefined, text: string) {
		const result = await api('chat/messages/create-to-room', { toRoomId: roomId, toRoomChannelId: channelId, text }, member);
		expect(result.status, JSON.stringify(result.body)).toBe(200);
		return result.body;
	}

	test.each([false, true])('그룹장과 멤버는 자기 설정만 바꾼다 (채널=%s)', async channels => {
		const { roomId } = await room(channels);

		expect(await settings(roomId, owner, 'mentions')).toMatchObject({ level: 'mentions', effectiveLevel: 'mentions' });
		expect(await settings(roomId, member)).toMatchObject({ level: 'all', effectiveLevel: 'all' });
		expect(await settings(roomId, member, 'none')).toMatchObject({ level: 'none', effectiveLevel: 'none' });
		expect(await settings(roomId, owner)).toMatchObject({ level: 'mentions' });
		expect((await request('notifications', { roomId, level: 'all' }, outsider)).status).toBe(400);
	});

	test('채널 개별 설정이 기본값보다 우선하고 그룹 끄기가 전체에 우선한다', async () => {
		const { roomId, general, other } = await room(true);
		await settings(roomId, owner, 'mentions');

		expect(await settings(roomId, owner, undefined, general)).toMatchObject({ level: 'inherit', effectiveLevel: 'mentions' });
		expect(await settings(roomId, owner, 'all', other)).toMatchObject({ level: 'all', effectiveLevel: 'all' });
		await settings(roomId, owner, 'none');
		expect(await settings(roomId, owner, undefined, other)).toMatchObject({ level: 'all', effectiveLevel: 'none' });
		await settings(roomId, owner, 'mentions');
		expect(await settings(roomId, owner, 'inherit', other)).toMatchObject({ level: 'inherit', effectiveLevel: 'mentions' });
	});

	test.each([false, true])('멘션이 없는 글은 정적인 미읽음만 남긴다 (채널=%s)', async channels => {
		const { roomId, general } = await room(channels);
		await settings(roomId, owner, 'mentions');
		await send(roomId, general, '일반 메시지 @everyone');

		expect(await unread(roomId)).toMatchObject({ hasUnread: true, hasUnreadNotification: false, notificationChannelIds: [] });
		await send(roomId, general, '@notifyowner 계정 멘션');
		expect(await unread(roomId)).toMatchObject({ hasUnread: true, hasUnreadNotification: true });
	});

	test.each([false, true])('알림 끄기는 정적인 미읽음도 남기지 않는다 (채널=%s)', async channels => {
		const { roomId, general } = await room(channels);
		await settings(roomId, owner, 'none');

		await send(roomId, general, '@notifyowner 끈 그룹의 글');

		expect(await unread(roomId)).toMatchObject({ hasUnread: false, hasUnreadNotification: false, unreadChannelIds: [], notificationChannelIds: [] });
	});

	test('채널 알림 끄기는 그 채널의 미읽음만 숨긴다', async () => {
		const { roomId, general, other } = await room(true);
		await settings(roomId, owner, 'none', other);

		await send(roomId, general, '켜 둔 채널');
		await send(roomId, other, '@notifyowner 끈 채널');

		expect(await unread(roomId)).toMatchObject({ hasUnread: true, unreadChannelIds: [general], notificationChannelIds: [general] });
	});

	test('알림을 끈 그룹의 글은 계정 미읽음 표시를 켜지 않는다', async () => {
		const quiet = await signup({ username: 'notifyquiet' });
		const created = await api('chat/rooms/create', { name: '끈 그룹' }, quiet);
		expect(created.status).toBe(200);
		const roomId = created.body.id;
		expect((await api('chat/rooms/invitations/create', { roomId, userId: member.id }, quiet)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, member)).status).toBe(204);
		await settings(roomId, quiet, 'none');

		await send(roomId, undefined, '@notifyquiet 끈 그룹의 글');

		expect((await api('i', {}, quiet)).body).toMatchObject({ hasUnreadChatMessages: false, hasUnreadChatNotifications: false });
		expect((await api('chat/history', { room: true }, quiet)).body.find(message => message.toRoomId === roomId)).toMatchObject({ isRead: true });
	});

	test('한 채널을 읽어도 다른 채널 미읽음을 유지하고 그룹 전체를 읽을 수 있다', async () => {
		const { roomId, general, other } = await room(true);
		const first = await send(roomId, general, '첫 채널');
		await send(roomId, other, '둘째 채널');

		expect((await unread(roomId)).unreadChannelIds.sort()).toEqual([general, other].sort());
		expect((await request('read', { roomId, channelId: general, untilId: first.id }, owner)).status).toBe(204);
		expect((await unread(roomId)).unreadChannelIds).toEqual([other]);
		expect((await request('read', { roomId, readAll: true }, owner)).status).toBe(204);
		expect(await unread(roomId)).toMatchObject({ hasUnread: false, unreadChannelIds: [] });
	});

	test('오래된 화면의 읽음 경계 뒤 메시지를 보존한다', async () => {
		const { roomId, general } = await room(true);
		const old = await send(roomId, general, '이미 본 글');
		await send(roomId, general, '아직 보지 않은 글');

		expect((await request('read', { roomId, channelId: general, untilId: old.id }, owner)).status).toBe(204);
		expect((await unread(roomId)).hasUnread).toBe(true);
	});

	test('삭제·채널 삭제가 미읽음 집계를 정리한다', async () => {
		const { roomId, general, other } = await room(true);
		const message = await send(roomId, general, '삭제할 글');
		await send(roomId, other, '삭제할 채널');

		expect((await api('chat/messages/delete', { messageId: message.id }, member)).status).toBe(204);
		expect((await unread(roomId)).unreadChannelIds).toEqual([other]);
		expect((await api('chat/rooms/channels/delete', { channelId: other! }, owner)).status).toBe(204);
		expect((await unread(roomId)).hasUnread).toBe(false);
	});

	test('열린 화면의 메시지에 수신자별 소리 허용을 전달한다', async () => {
		const { roomId } = await room();
		await settings(roomId, owner, 'mentions');
		const messages: { text?: string; shouldNotify?: boolean }[] = [];
		const stream = await connectStream(owner, 'chatRoom', event => {
			if (event.type === 'message') messages.push(event.body);
		}, { roomId });
		try {
			await send(roomId, undefined, '조용한 글');
			await send(roomId, undefined, '@notifyowner 소리 나는 글');
			await expect.poll(() => messages.length).toBe(2);

			expect(messages.map(message => message.shouldNotify)).toEqual([false, true]);
		} finally {
			stream.close();
		}
	});

	test('로컬 수정은 새 멘션만 알리며 같은 대상의 재수정은 알리지 않는다', async () => {
		const { roomId } = await room();
		await settings(roomId, owner, 'mentions');
		const received: { id: string }[] = [];
		const stream = await connectStream(owner, 'main', event => {
			if (event.type === 'newChatMessage' && event.body?.toRoomId === roomId) received.push(event.body);
		});
		try {
			const message = await send(roomId, undefined, '처음에는 멘션 없음');
			await waitForChatNotificationTurn();
			expect(received).toHaveLength(0);
			expect((await api('chat/messages/update', { messageId: message.id, text: '@notifyowner 새 멘션' }, member)).status).toBe(200);
			await waitForChatNotificationTurn();
			expect(received.map(value => value.id)).toEqual([message.id]);

			expect((await api('chat/messages/update', { messageId: message.id, text: '@notifyowner 본문만 수정' }, member)).status).toBe(200);
			await waitForChatNotificationTurn();
			expect(received.map(value => value.id)).toEqual([message.id]);
		} finally {
			stream.close();
		}
	});

	test('수정 알림은 새로 멘션된 사람에게만 가고 설정을 바꾼 다른 수신자에게 가지 않는다', async () => {
		const { roomId } = await room();
		expect((await api('chat/rooms/invitations/create', { roomId, userId: outsider.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, outsider)).status).toBe(204);
		await settings(roomId, owner, 'mentions');
		await settings(roomId, outsider, 'mentions');
		const received: { userId: string; id: string }[] = [];
		const listen = (user: typeof owner) => connectStream(user, 'main', event => {
			if (event.type === 'newChatMessage' && event.body?.toRoomId === roomId) received.push({ userId: user.id, id: event.body.id });
		});
		const streams = [await listen(owner), await listen(outsider)];
		try {
			const message = await send(roomId, undefined, '처음에는 아무도 멘션하지 않음');
			await waitForChatNotificationTurn();
			expect(received).toHaveLength(0);
			await settings(roomId, owner, 'all');

			expect((await api('chat/messages/update', { messageId: message.id, text: '@notifyoutsider 새 멘션' }, member)).status).toBe(200);
			await waitForChatNotificationTurn();

			expect(received).toEqual([{ userId: outsider.id, id: message.id }]);
		} finally {
			for (const stream of streams) stream.close();
		}
	});

	test('원격 수신과 원격 수정도 실제 DB·스트림에 같은 정책을 적용한다', async () => {
		const { roomId, general } = await room(true);
		await settings(roomId, owner, 'mentions');
		const id = app.get(IdService).gen();
		const users = db.getRepository(MiUser);
		await users.insert({ id, username: 'remote-notify', usernameLower: 'remote-notify', host: 'remote-notify.example', uri: 'https://remote-notify.example/users/remote', inbox: 'https://remote-notify.example/inbox', lastFetchedAt: new Date() });
		const actor = await users.findOneByOrFail({ id }) as MiRemoteUser;
		await db.getRepository(MiChatRoomMembership).insert({ id: app.get(IdService).gen(), userId: id, roomId });
		const roomUri = app.get(ApRendererService).genLocalChatRoomUri(roomId);
		const uri = `https://remote-notify.example/chat/messages/${app.get(IdService).gen()}`;
		const inbox = app.get(ApInboxService);
		const received: { shouldNotify?: boolean }[] = [];
		const stream = await connectStream(owner, 'chatRoom', event => {
			if (event.type === 'message' || event.type === 'updated') received.push(event.body);
		}, { roomId, channelId: general });
		try {
			const note = { id: uri, type: 'Note', attributedTo: actor.uri, to: [`${origin}/users/${owner.id}`, `${origin}/users/${member.id}`], _misskey_talk: true, _misskey_chatRoom: roomUri, _misskey_chatChannel: `${roomUri}/channels/${general}`, _misskey_content: '원격 일반 글', content: '<p>원격 일반 글</p>' };
			const create = { id: `${uri}/create`, type: 'Create', actor: actor.uri, object: note };
			await inbox.performOneActivity(actor, create);
			const saved = await db.getRepository(MiChatMessage).findOneByOrFail({ uri });
			expect((await api('chat/messages/show', { messageId: saved.id }, owner)).body.text).toBe('원격 일반 글');
			expect(await unread(roomId)).toMatchObject({ hasUnread: true, hasUnreadNotification: false });

			const text = `@notifyowner@${new URL(origin).hostname} 원격 멘션`;
			const update = { id: `${uri}/update`, type: 'Update', actor: actor.uri, object: { ...note, _misskey_content: text, content: `<p>${text}</p>`, updated: new Date().toISOString() } };
			await inbox.performOneActivity(actor, update);
			await inbox.performOneActivity(actor, update);
			await expect.poll(() => received.length).toBe(2);
			expect(received.map(value => value.shouldNotify)).toEqual([false, true]);
			expect(await unread(roomId)).toMatchObject({ hasUnread: true, hasUnreadNotification: true });
			expect((await db.getRepository(MiChatMessage).findOneByOrFail({ id: saved.id })).mentionedUserIds).toContain(owner.id);
		} finally {
			stream.close();
		}
	});

	test('읽음과 새 메시지를 동시에 처리해도 마지막 새 글의 상태가 남는다', async () => {
		const { roomId, general } = await room(true);
		const seen = await send(roomId, general, '읽은 글');

		await Promise.all([
			request('read', { roomId, channelId: general, untilId: seen.id }, owner),
			send(roomId, general, '동시에 도착한 새 글'),
		]);

		expect((await unread(roomId)).hasUnread).toBe(true);
	});

	test('채널 개별 알림과 그룹 전체 끄기가 실제 main stream에도 적용된다', async () => {
		const { roomId, general, other } = await room(true);
		await settings(roomId, owner, 'mentions');
		await settings(roomId, owner, 'all', other);
		const received: { toRoomChannelId: string }[] = [];
		const stream = await connectStream(owner, 'main', event => {
			if (event.type === 'newChatMessage' && event.body?.toRoomId === roomId) received.push(event.body);
		});
		try {
			await send(roomId, general, '상속한 멘션 전용 채널');
			await send(roomId, other, '개별 모두 받기 채널');
			await waitForChatNotificationTurn();
			expect(received.map(message => message.toRoomChannelId)).toEqual([other]);

			await settings(roomId, owner, 'none');
			await send(roomId, other, '@notifyowner 그룹 전체 끄기');
			await waitForChatNotificationTurn();
			expect(received).toHaveLength(1);
			expect((await unread(roomId)).hasUnreadNotification).toBe(false);
		} finally {
			stream.close();
		}
	});

	test('지연 알림 전에 삭제한 글은 소리·푸시용 이벤트와 미읽음을 남기지 않는다', async () => {
		const { roomId } = await room();
		const received: unknown[] = [];
		const stream = await connectStream(owner, 'main', event => {
			if (event.type === 'newChatMessage' && event.body?.toRoomId === roomId) received.push(event.body);
		});
		try {
			const message = await send(roomId, undefined, '@notifyowner 곧 삭제할 글');
			expect((await api('chat/messages/delete', { messageId: message.id }, member)).status).toBe(204);
			await waitForChatNotificationTurn();

			expect(received).toHaveLength(0);
			expect((await unread(roomId)).hasUnread).toBe(false);
		} finally {
			stream.close();
		}
	});

	test('탈퇴·그룹 삭제가 개인 상태를 정리한다', async () => {
		const { roomId } = await room();
		await settings(roomId, member, 'mentions');
		expect((await api('chat/messages/create-to-room', { toRoomId: roomId, text: '@notifymember 새 글' }, owner)).status).toBe(200);

		expect((await api('chat/rooms/leave', { roomId }, member)).status).toBe(204);
		expect(await db.getRepository(MiChatRoomUnread).countBy({ roomId, userId: member.id })).toBe(0);
		expect(await db.getRepository(MiChatRoomUserSettings).countBy({ roomId, userId: member.id })).toBe(0);
		expect((await api('chat/rooms/delete', { roomId }, owner)).status).toBe(204);
		expect(await db.getRepository(MiChatRoomUnread).countBy({ roomId })).toBe(0);
		expect(await db.getRepository(MiChatRoomUserSettings).countBy({ roomId })).toBe(0);
	});

	test('실제 푸시 전송 경로는 새 멘션에만 연결하고 조용한 글·중복·끄기에서는 연결하지 않는다', async () => {
		let connections = 0;
		const collector = createServer(socket => {
			socket.on('error', () => {});
			socket.once('data', () => { connections++; socket.destroy(); });
		});
		collector.listen(0, '127.0.0.1');
		await once(collector, 'listening');
		const address = collector.address();
		if (address == null || typeof address === 'string') throw new Error('push collector is not listening');
		try {
			const keys = createECDH('prime256v1');
			keys.generateKeys();
			expect((await api('sw/register', { endpoint: `https://127.0.0.1:${address.port}/push`, auth: randomBytes(16).toString('base64url'), publickey: keys.getPublicKey().toString('base64url') }, owner)).status).toBe(200);
			await app.get(PushNotificationService).refreshCache(owner.id);
			const { roomId } = await room();
			await settings(roomId, owner, 'mentions');
			const id = app.get(IdService).gen();
			await db.getRepository(MiUser).insert({ id, username: 'push-remote', usernameLower: 'push-remote', host: 'push-remote.example', uri: 'https://push-remote.example/users/remote', inbox: 'https://push-remote.example/inbox' });
			const actor = await db.getRepository(MiUser).findOneByOrFail({ id });
			await db.getRepository(MiChatRoomMembership).insert({ id: app.get(IdService).gen(), userId: actor.id, roomId });
			const target = await db.getRepository(MiChatRoom).findOneByOrFail({ id: roomId });
			const chat = app.get(ChatService);
			const created = await chat.createMessageToRoom(actor, target, { text: '조용한 원격 글' });
			await waitForChatNotificationTurn();
			expect(connections).toBe(0);

			const message = await db.getRepository(MiChatMessage).findOneByOrFail({ id: created.id });
			const text = `@notifyowner@${new URL(origin).hostname} 새 멘션`;
			await chat.updateRemoteMessage(actor, message, text, new Date());
			await expect.poll(() => connections, { timeout: 10_000 }).toBe(1);
			await chat.updateRemoteMessage(actor, message, `${text} 본문 수정`, new Date());
			await waitForChatNotificationTurn();
			expect(connections).toBe(1);

			await settings(roomId, owner, 'none');
			await chat.createMessageToRoom(actor, target, { text });
			await waitForChatNotificationTurn();
			expect(connections).toBe(1);
		} finally {
			await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
		}
	}, 30_000);
});
