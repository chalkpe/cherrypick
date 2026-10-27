/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, beforeAll, vi } from 'vitest';
import { rejects, strictEqual } from 'node:assert';
import * as Misskey from 'cherrypick-js';
import { Redis } from 'ioredis';
import { createAccount, type LoginUser, resolveRemoteUser, WAIT_FOR_FEDERATION } from './utils.js';

/**
 * a.test だけが LiveKit を持つ (compose.a.yml の livekit.a.test と、setup.sh が a.test.config.json に足す voiceCall)。
 * b.test には LiveKit が無いので、b.test の /livekit/* は 404 を返す
 */
describe('Voice call', () => {
	/**
	 * 通話に対応していないと分かったホストは、各サーバーが Redis (redis.test を a.test と b.test で共有) に 1 時間覚えておく
	 * (`<サーバーのホスト>:chatVoice:unsupportedHost:<相手のホスト>`)。
	 * 前の実行 (a.test に LiveKit が無かったときなど) の記録が残っていると、トークンを取りに行かずに断ってしまうので、毎回消してから始める
	 */
	beforeAll(async () => {
		const redis = new Redis({ host: 'redis.test', port: 6379 });
		try {
			let cursor = '0';
			do {
				const [next, keys] = await redis.scan(cursor, 'MATCH', '*:chatVoice:unsupportedHost:*', 'COUNT', 100);
				if (keys.length > 0) await redis.del(...keys);
				cursor = next;
			} while (cursor !== '0');
		} finally {
			redis.disconnect();
		}
	});

	/** LiveKit のトークン (JWT) の中身を、署名を確かめずに読む */
	function decodeToken(token: string): { sub?: unknown; video?: { room?: unknown } } {
		const payload = token.split('.')[1];
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	}

	/**
	 * owner のサーバーにルームを作り、他のサーバーの invitee を招待して、invitee のサーバーで参加させる。
	 * 参加 (Accept) が owner のサーバーに届き、invitee がメンバーになるまで待つ
	 */
	async function createRoomWithRemoteMember(
		owner: LoginUser,
		invitee: LoginUser,
		inviteeInOwnerHost: Misskey.entities.UserDetailedNotMe,
	): Promise<Misskey.entities.ChatRoom> {
		const room = await owner.client.request('chat/rooms/create', { name: 'Voice call' });
		await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: inviteeInOwnerHost.id });

		// Invite が届くと、invitee のサーバーに同じ id のルーム (ミラー) ができる
		await vi.waitFor(async () => {
			const invitations = await invitee.client.request('chat/rooms/invitations/inbox', {});
			strictEqual(invitations.some(invitation => invitation.roomId === room.id), true);
		}, WAIT_FOR_FEDERATION);

		await invitee.client.request('chat/rooms/join', { roomId: room.id });

		await vi.waitFor(async () => {
			const members = await owner.client.request('chat/rooms/members', { roomId: room.id });
			strictEqual(members.some(member => member.userId === inviteeInOwnerHost.id), true);
		}, WAIT_FOR_FEDERATION);

		return room;
	}

	describe('in a room hosted on a.test', () => {
		let alice: LoginUser, bob: LoginUser, eve: LoginUser;
		let room: Misskey.entities.ChatRoom;

		beforeAll(async () => {
			[alice, bob, eve] = await Promise.all([
				createAccount('a.test'),
				createAccount('b.test'),
				createAccount('b.test'),
			]);

			const bobInA = await resolveRemoteUser('b.test', bob.id, alice);
			room = await createRoomWithRemoteMember(alice, bob, bobInA);
		});

		test('a member on b.test gets a token for a room hosted on a.test', async () => {
			const res = await bob.client.request('chat/rooms/voice/join', { roomId: room.id });

			strictEqual(res.url, 'https://a.test/livekit');
			const payload = decodeToken(res.token);
			strictEqual(payload.video?.room, `chatRoom:${room.id}`);
			strictEqual(payload.sub, `https://b.test/users/${bob.id}`);
		});

		test('a user on b.test who is not a member is refused', async () => {
			// b.test はこのルームをミラーとして知っているが、eve はメンバーではない。
			// b.test には LiveKit が無いので、メンバーでない人にはルームがあるかもミラーかも見せず、最初に VOICE_CALL_UNAVAILABLE で断る
			await rejects(
				async () => await eve.client.request('chat/rooms/voice/join', { roomId: room.id }),
				(err: any) => {
					strictEqual(err.code, 'VOICE_CALL_UNAVAILABLE');
					return true;
				},
			);
		});
	});

	describe('in a room hosted on b.test', () => {
		let carol: LoginUser, dave: LoginUser;
		let room: Misskey.entities.ChatRoom;

		beforeAll(async () => {
			[carol, dave] = await Promise.all([
				createAccount('b.test'),
				createAccount('a.test'),
			]);

			const daveInB = await resolveRemoteUser('a.test', dave.id, carol);
			room = await createRoomWithRemoteMember(carol, dave, daveInB);
		});

		test('a.test reports REMOTE_HOST_UNSUPPORTED for a room hosted on b.test, which has no LiveKit', async () => {
			// a.test は dave の鍵で署名して b.test の /livekit/federation/token にトークンを求める。
			// b.test には LiveKit が無いので 404 が返り、a.test はそれを REMOTE_HOST_UNSUPPORTED として dave に返す
			await rejects(
				async () => await dave.client.request('chat/rooms/voice/join', { roomId: room.id }),
				(err: any) => {
					strictEqual(err.code, 'REMOTE_HOST_UNSUPPORTED');
					return true;
				},
			);
		});
	});
});
