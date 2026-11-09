/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import type { MiUser } from '@/models/User.js';
import { api, createAppToken, failedApiCall, initTestDb, signup } from '../utils.js';
import type * as misskey from 'cherrypick-js';

describe('chat/messages/update', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		await api('i/update', { chatScope: 'everyone' }, alice);
		await api('i/update', { chatScope: 'everyone' }, bob);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		// Let the 3-second unread-notification timers drain before the test server closes.
		await new Promise((resolve) => setTimeout(resolve, 3500));
	});

	test('updates an authored message', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		const updated = await api('chat/messages/update', { messageId: created.body.id, text: ' edited ' }, alice);

		assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
		assert.strictEqual(updated.body.text, 'edited');
		assert.ok(updated.body.editedAt != null);
	});

	test('only an authorized owner can kick, revoke access, and reinvite a member', async () => {
		const created = await api('chat/rooms/create', { name: 'kick lifecycle' }, alice);
		assert.strictEqual(created.status, 200);
		const roomId = created.body.id;
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId, userId: bob.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId }, bob)).status, 204);
		const message = await api('chat/messages/create-to-room', { toRoomId: roomId, text: 'preserved' }, bob);
		assert.strictEqual(message.status, 200);
		const params = { roomId, userId: bob.id };
		assert.strictEqual((await api('chat/rooms/kick', params)).status, 401);
		const readToken = await createAppToken(alice, ['read:chat']);
		assert.strictEqual((await api('chat/rooms/kick', params, { token: readToken })).status, 403);
		const invalid = await api('chat/rooms/kick', { roomId } as any, alice);
		assert.strictEqual(invalid.status, 400);
		assert.strictEqual((await api('chat/rooms/kick', params, bob)).status, 400);
		assert.strictEqual((await api('chat/rooms/kick', { roomId, userId: alice.id }, alice)).status, 400);
		assert.strictEqual((await api('chat/rooms/kick', params, alice)).status, 204);
		assert.strictEqual((await api('chat/rooms/show', { roomId }, bob)).status, 400);
		assert.strictEqual((await api('chat/messages/room-timeline', { roomId }, bob)).status, 400);
		assert.strictEqual((await api('chat/messages/create-to-room', { toRoomId: roomId, text: 'denied' }, bob)).status, 400);
		const history = await api('chat/messages/room-timeline', { roomId }, alice);
		assert.ok(history.body.some(item => item.id === message.body.id && item.text === 'preserved'));
		assert.strictEqual((await api('chat/rooms/invitations/create', params, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId }, bob)).status, 204);
		assert.strictEqual((await api('chat/messages/create-to-room', { toRoomId: roomId, text: 'back' }, bob)).status, 200);
		assert.strictEqual((await api('chat/rooms/update', { roomId, isArchived: true }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/kick', params, alice)).status, 204);
	});

	test('room members require read permission and room membership', async () => {
		const created = await api('chat/rooms/create', { name: 'roster permission' }, alice);
		assert.strictEqual(created.status, 200);
		const roomId = created.body.id;
		const writeOnly = await createAppToken(alice, ['write:chat']);
		const readOnly = await createAppToken(alice, ['read:chat']);
		const readWrite = await createAppToken(alice, ['read:chat', 'write:chat']);
		const nonmember = await createAppToken(bob, ['read:chat']);

		assert.strictEqual((await api('chat/rooms/members', { roomId }, { token: writeOnly })).status, 403);
		assert.strictEqual((await api('chat/rooms/members', { roomId }, { token: readOnly })).status, 200);
		assert.strictEqual((await api('chat/rooms/members', { roomId }, { token: readWrite })).status, 200);
		assert.strictEqual((await api('chat/rooms/members', { roomId }, { token: nonmember })).status, 400);
	});

	test('does not reveal a message owned by another user', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: created.body.id, text: 'hijacked' },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('rejects whitespace-only edits', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: created.body.id, text: '   ' },
			user: alice,
		}, {
			status: 400,
			code: 'INVALID_TEXT',
			id: 'f6f8f5d4-1f37-4d3f-9e3b-4e1b4f8a2c71',
		});
	});

	test('rejects edits to a deleted message', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		const deleted = await api('chat/messages/delete', { messageId: created.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: created.body.id, text: 'edited' },
			user: alice,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('a deleted message cannot be deleted again or reacted to', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));
		const deleted = await api('chat/messages/delete', { messageId: created.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		await failedApiCall({
			endpoint: 'chat/messages/delete',
			parameters: { messageId: created.body.id },
			user: alice,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '36b67f0e-66a6-414b-83df-992a55294f17',
		});

		await failedApiCall({
			endpoint: 'chat/messages/react',
			parameters: { messageId: created.body.id, reaction: '👍' },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '9b5839b9-0ba0-4351-8c35-37082093d200',
		});
	});

	test('the conversation list falls back to the latest message that is not deleted', async () => {
		const carol = await signup({ username: 'carol' });
		await api('i/update', { chatScope: 'everyone' }, carol);
		const kept = await api('chat/messages/create-to-user', { toUserId: carol.id, text: 'kept' }, alice);
		const removed = await api('chat/messages/create-to-user', { toUserId: carol.id, text: 'removed' }, alice);
		assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
		const deleted = await api('chat/messages/delete', { messageId: removed.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		const history = await api('chat/history', { room: false, limit: 100 }, carol);

		assert.strictEqual(history.status, 200, JSON.stringify(history.body));
		assert.deepStrictEqual(history.body.map(message => message.id), [kept.body.id]);
	});

	test('a timeline shows a deleted message only to a client that asks for the marker', async () => {
		const dana = await signup({ username: 'dana' });
		await api('i/update', { chatScope: 'everyone' }, dana);
		const kept = await api('chat/messages/create-to-user', { toUserId: dana.id, text: 'kept' }, alice);
		const removed = await api('chat/messages/create-to-user', { toUserId: dana.id, text: 'removed' }, alice);
		assert.strictEqual((await api('chat/messages/delete', { messageId: removed.body.id }, alice)).status, 204);

		const plain = await api('chat/messages/user-timeline', { userId: alice.id }, dana);
		assert.deepStrictEqual(plain.body.map(message => message.id), [kept.body.id]);

		const marked = await api('chat/messages/user-timeline', { userId: alice.id, includeDeleted: true }, dana);
		assert.deepStrictEqual(marked.body.map(message => message.id), [removed.body.id, kept.body.id]);
		assert.strictEqual(marked.body[0].text, null);
		assert.notStrictEqual(marked.body[0].deletedAt, null);

		const room = await api('chat/rooms/create', { name: 'markers' }, alice);
		const roomKept = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'kept' }, alice);
		const roomRemoved = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'removed' }, alice);
		assert.strictEqual((await api('chat/messages/delete', { messageId: roomRemoved.body.id }, alice)).status, 204);

		const plainRoom = await api('chat/messages/room-timeline', { roomId: room.body.id }, alice);
		assert.deepStrictEqual(plainRoom.body.map(message => message.id), [roomKept.body.id]);
		const markedRoom = await api('chat/messages/room-timeline', { roomId: room.body.id, includeDeleted: true }, alice);
		assert.deepStrictEqual(markedRoom.body.map(message => message.id), [roomRemoved.body.id, roomKept.body.id]);
	});

	test('a user who left a room cannot edit their old message, and the room list skips deleted messages', async () => {
		const room = await api('chat/rooms/create', { name: 'room' }, alice);
		assert.strictEqual(room.status, 200, JSON.stringify(room.body));
		const invited = await api('chat/rooms/invitations/create', { roomId: room.body.id, userId: bob.id }, alice);
		assert.strictEqual(invited.status, 200, JSON.stringify(invited.body));
		const joined = await api('chat/rooms/join', { roomId: room.body.id }, bob);
		assert.strictEqual(joined.status, 204, JSON.stringify(joined.body));
		const kept = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'kept' }, bob);
		const removed = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'removed' }, alice);
		assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
		const deleted = await api('chat/messages/delete', { messageId: removed.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		const history = await api('chat/history', { room: true, limit: 100 }, alice);
		assert.strictEqual(history.status, 200, JSON.stringify(history.body));
		assert.strictEqual(history.body.find(message => message.toRoomId === room.body.id)?.id, kept.body.id);

		const left = await api('chat/rooms/leave', { roomId: room.body.id }, bob);
		assert.strictEqual(left.status, 204, JSON.stringify(left.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: kept.body.id, text: 'edited after leaving' },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('the owner can archive a room, which makes it read-only until it is unarchived', async () => {
		const carol = await signup({ username: 'archive_invitee' });
		await api('i/update', { chatScope: 'everyone' }, carol);
		const room = await api('chat/rooms/create', { name: 'archived room' }, alice);
		assert.strictEqual(room.status, 200, JSON.stringify(room.body));
		assert.strictEqual(room.body.isArchived, false);
		for (const user of [bob, carol]) {
			const invited = await api('chat/rooms/invitations/create', { roomId: room.body.id, userId: user.id }, alice);
			assert.strictEqual(invited.status, 200, JSON.stringify(invited.body));
		}
		const joined = await api('chat/rooms/join', { roomId: room.body.id }, bob);
		assert.strictEqual(joined.status, 204, JSON.stringify(joined.body));

		await failedApiCall({
			endpoint: 'chat/rooms/update',
			parameters: { roomId: room.body.id, isArchived: true },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_ROOM',
			id: 'fcdb0f92-bda6-47f9-bd05-343e0e020932',
		});

		const beforeArchive = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'before archive' }, alice);
		assert.strictEqual(beforeArchive.status, 200, JSON.stringify(beforeArchive.body));

		const archived = await api('chat/rooms/update', { roomId: room.body.id, isArchived: true }, alice);
		assert.strictEqual(archived.status, 200, JSON.stringify(archived.body));
		assert.strictEqual(archived.body.isArchived, true);
		assert.strictEqual(archived.body.name, 'archived room');
		const seenByMember = await api('chat/rooms/show', { roomId: room.body.id }, bob);
		assert.strictEqual(seenByMember.body.isArchived, true);

		await failedApiCall({
			endpoint: 'chat/messages/create-to-room',
			parameters: { toRoomId: room.body.id, text: 'refused' },
			user: bob,
		}, {
			status: 400,
			code: 'ROOM_IS_ARCHIVED',
			id: '5b6e1f2a-7c0d-4e39-9a41-2f8d3c6b7e10',
		});
		for (const [endpoint, parameters, user, id] of [
			['chat/messages/update', { messageId: beforeArchive.body.id, text: 'refused' }, alice, 'a1c94d37-2e58-4b06-8f1d-6d0b9e47c352'],
			['chat/messages/delete', { messageId: beforeArchive.body.id }, alice, 'e7f2083b-96a4-4d1c-b5e7-31c8a0d2f694'],
			['chat/messages/react', { messageId: beforeArchive.body.id, reaction: '👍' }, bob, '3d8c5e91-0f47-4a2b-86d3-c94e1b7a5f08'],
			['chat/messages/unreact', { messageId: beforeArchive.body.id, reaction: '👍' }, bob, '92b7e6c4-5a13-4f80-a7d9-08f3e2c1b6d5'],
		] as const) {
			await failedApiCall({ endpoint, parameters, user }, { status: 400, code: 'ROOM_IS_ARCHIVED', id });
		}
		await failedApiCall({
			endpoint: 'chat/rooms/update',
			parameters: { roomId: room.body.id, name: 'renamed' },
			user: alice,
		}, {
			status: 400,
			code: 'ROOM_IS_ARCHIVED',
			id: '8655493b-6d45-4466-95ec-c8c38ddae472',
		});
		await failedApiCall({
			endpoint: 'chat/rooms/invitations/create',
			parameters: { roomId: room.body.id, userId: (await signup({ username: 'archive_late' })).id },
			user: alice,
		}, {
			status: 400,
			code: 'ROOM_IS_ARCHIVED',
			id: 'b41cd32a-8b2a-4662-ae54-bc5cbb057afa',
		});
		await failedApiCall({
			endpoint: 'chat/rooms/join',
			parameters: { roomId: room.body.id },
			user: carol,
		}, {
			status: 400,
			code: 'ROOM_IS_ARCHIVED',
			id: 'c60a4f18-d3b2-4e75-9c06-7a1e58d3f2b9',
		});

		const unarchived = await api('chat/rooms/update', { roomId: room.body.id, isArchived: false, name: 'open again' }, alice);
		assert.strictEqual(unarchived.status, 200, JSON.stringify(unarchived.body));
		assert.strictEqual(unarchived.body.isArchived, false);
		assert.strictEqual(unarchived.body.name, 'open again');
		const sent = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'accepted' }, bob);
		assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
		const carolJoined = await api('chat/rooms/join', { roomId: room.body.id }, carol);
		assert.strictEqual(carolJoined.status, 204, JSON.stringify(carolJoined.body));
	});

	test('keeps the latest stored revision when inbox workers hold stale snapshots', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const snapshot = await messages.findOneByOrFail({ id: created.body.id });
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: messages,
				customEmojiService: { populateEmojis: async () => ({}) },
				userBlockingService: { checkBlocked: async () => false },
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
			}) as ChatService;
			const actor = { id: alice.id, host: 'remote.test' } as MiUser;
			await service.updateRemoteMessage(actor, { ...snapshot }, 'latest', new Date('2026-11-02T12:02:00Z'), ['wave']);
			await service.updateRemoteMessage(actor, { ...snapshot }, 'older', new Date('2026-11-02T12:01:00Z'), ['old']);
			await service.updateRemoteMessage(actor, { ...snapshot }, 'duplicate', new Date('2026-11-02T12:02:00Z'), []);
			const stored = await messages.findOneByOrFail({ id: snapshot.id });
			assert.strictEqual(stored.text, 'latest');
			assert.deepStrictEqual(stored.emojis, ['wave']);
			assert.strictEqual(stored.editedAt?.toISOString(), '2026-11-02T12:02:00.000Z');
			assert.strictEqual(events.length, 2);

			await messages.update(snapshot.id, { deletedAt: new Date(), text: null, emojis: [] });
			await service.updateRemoteMessage(actor, { ...snapshot }, 'resurrected', new Date('2026-11-02T12:03:00Z'), ['wave']);
			assert.strictEqual((await messages.findOneByOrFail({ id: snapshot.id })).text, null);
			assert.strictEqual(events.length, 2);
		} finally {
			await db.destroy();
		}
	});

	test('a local edit cannot restore text after a concurrent deletion', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: {
					findOneBy: async () => {
						const snapshot = await messages.findOneByOrFail({ id: created.body.id });
						await messages.update(snapshot.id, { text: null, deletedAt: new Date() });
						return snapshot;
					},
					update: messages.update.bind(messages),
				},
				customEmojiService: { populateEmojis: async () => ({}) },
				userBlockingService: { checkBlocked: async () => false },
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
			}) as ChatService;
			await assert.rejects(service.updateMessage(alice.id, created.body.id, 'late edit'), ChatMessageAccessError);
			assert.strictEqual((await messages.findOneByOrFail({ id: created.body.id })).text, null);
			assert.deepStrictEqual(events, []);
		} finally {
			await db.destroy();
		}
	});

	test('duplicate remote reactions and stale reactions after deletion do not change stored state twice', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const snapshot = await messages.findOneByOrFail({ id: created.body.id });
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: messages,
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
				userBlockingService: { checkBlocked: async () => false },
			}) as ChatService;
			const actor = { id: bob.id, host: 'remote.test' } as MiUser;
			await Promise.all([0, 1].map(() => service.reactRemote(actor, { ...snapshot, reactions: [] }, '👍')));
			assert.deepStrictEqual((await messages.findOneByOrFail({ id: snapshot.id })).reactions, [`${bob.id}/👍`]);
			assert.strictEqual(events.length, 2);

			await messages.update(snapshot.id, { text: null, reactions: [], deletedAt: new Date() });
			await service.reactRemote(actor, { ...snapshot, reactions: [] }, '👍');
			assert.deepStrictEqual((await messages.findOneByOrFail({ id: snapshot.id })).reactions, []);
			assert.strictEqual(events.length, 2);
		} finally {
			await db.destroy();
		}
	});

	test.each(['react', 'unreact'] as const)('local %s does not change or publish a message deleted after lookup', async method => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: {
					findOneBy: async () => {
						const snapshot = await messages.findOneByOrFail({ id: created.body.id });
						await messages.update(snapshot.id, { text: null, reactions: [], deletedAt: new Date() });
						return snapshot;
					},
					createQueryBuilder: messages.createQueryBuilder.bind(messages),
				},
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
				userBlockingService: { checkBlocked: async () => false },
			}) as ChatService;
			const error = await service[method](created.body.id, bob.id, '👍').then(() => null, error => error);
			assert.deepStrictEqual((await messages.findOneByOrFail({ id: created.body.id })).reactions, []);
			assert.deepStrictEqual(events, []);
			assert.strictEqual(error, null);
		} finally {
			await db.destroy();
		}
	});

	// These used to reach clients as 500 INTERNAL_ERROR, which also filled the server log.
	describe('refused requests', () => {
		const assertRefused = (res: { status: number; body: any }, code: string) => {
			assert.strictEqual(res.status, 400, JSON.stringify(res.body));
			assert.strictEqual(res.body.error.code, code);
		};
		const createRoom = async (owner: misskey.entities.SignupResponse) => {
			const room = await api('chat/rooms/create', { name: 'refusals' }, owner);
			assert.strictEqual(room.status, 200);
			return room.body.id as string;
		};

		test('updating a room with no fields returns it unchanged', async () => {
			const roomId = await createRoom(alice);

			const updated = await api('chat/rooms/update', { roomId }, alice);

			assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
			assert.strictEqual(updated.body.name, 'refusals');
		});

		test('joining, ignoring and rejecting need an invitation', async () => {
			const roomId = await createRoom(alice);

			assertRefused(await api('chat/rooms/join', { roomId }, bob), 'NO_SUCH_ROOM');
			assertRefused(await api('chat/rooms/invitations/ignore', { roomId }, bob), 'NO_SUCH_ROOM');
			assertRefused(await api('chat/rooms/invitations/reject', { roomId }, bob), 'NO_SUCH_ROOM');
		});

		test('leaving and muting need a membership, which the owner does not have', async () => {
			const roomId = await createRoom(alice);

			assertRefused(await api('chat/rooms/leave', { roomId }, bob), 'NO_SUCH_ROOM');
			assertRefused(await api('chat/rooms/mute', { roomId, mute: true }, bob), 'NO_SUCH_ROOM');
			assertRefused(await api('chat/rooms/leave', { roomId }, alice), 'NO_SUCH_ROOM');
			assertRefused(await api('chat/rooms/mute', { roomId, mute: true }, alice), 'NO_SUCH_ROOM');
		});

		test('only the owner can cancel an invitation', async () => {
			const roomId = await createRoom(alice);
			const carol = await signup();
			const invitation = await api('chat/rooms/invitations/create', { roomId, userId: carol.id }, alice);
			assert.strictEqual(invitation.status, 200);

			assertRefused(await api('chat/rooms/invitations/cancel', { invitationId: invitation.body.id }, bob), 'NO_SUCH_INVITATION');
			assert.strictEqual((await api('chat/rooms/invitations/cancel', { invitationId: invitation.body.id }, alice)).status, 204);
		});

		test('an invitation is refused for each reason it cannot be sent', async () => {
			const roomId = await createRoom(alice);
			const carol = await signup();
			const dave = await signup();
			const erin = await signup();
			assert.strictEqual((await api('chat/rooms/invitations/create', { roomId, userId: bob.id }, alice)).status, 200);
			assert.strictEqual((await api('chat/rooms/join', { roomId }, bob)).status, 204);
			assert.strictEqual((await api('chat/rooms/invitations/create', { roomId, userId: carol.id }, alice)).status, 200);
			assert.strictEqual((await api('blocking/create', { userId: alice.id }, dave)).status, 200);
			assert.strictEqual((await api('blocking/create', { userId: erin.id }, alice)).status, 200);

			try {
				assertRefused(await api('chat/rooms/invitations/create', { roomId, userId: alice.id }, alice), 'CANNOT_INVITE_YOURSELF');
				assertRefused(await api('chat/rooms/invitations/create', { roomId, userId: bob.id }, alice), 'ALREADY_MEMBER');
				assertRefused(await api('chat/rooms/invitations/create', { roomId, userId: carol.id }, alice), 'ALREADY_INVITED');
				assertRefused(await api('chat/rooms/invitations/create', { roomId, userId: dave.id }, alice), 'YOU_HAVE_BEEN_BLOCKED');
				assertRefused(await api('chat/rooms/invitations/create', { roomId, userId: erin.id }, alice), 'YOU_ARE_BLOCKING');
				assertRefused(await api('chat/rooms/invitations/create', { roomId, userId: 'xxxxxxxxxx' }, alice), 'NO_SUCH_USER');
			} finally {
				await api('blocking/delete', { userId: erin.id }, alice);
			}
		});

		test('a reaction that is not an emoji, or an unknown custom emoji, is refused', async () => {
			const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'react to me' }, alice);
			assert.strictEqual(created.status, 200);
			const messageId = created.body.id;

			assertRefused(await api('chat/messages/react', { messageId, reaction: 'not an emoji' }, bob), 'INVALID_REACTION');
			assertRefused(await api('chat/messages/react', { messageId, reaction: ':no_such_emoji:' }, bob), 'INVALID_REACTION');
			assertRefused(await api('chat/messages/unreact', { messageId, reaction: 'not an emoji' }, bob), 'INVALID_REACTION');
		});

		test('sending to a room gives an outsider the same answer whether or not it exists', async () => {
			const roomId = await createRoom(alice);
			const params = { toRoomId: roomId } as any;

			assertRefused(await api('chat/messages/create-to-room', params, bob), 'NO_SUCH_ROOM');
			assertRefused(await api('chat/messages/create-to-room', { ...params, fileId: 'xxxxxxxxxx' }, bob), 'NO_SUCH_ROOM');
		});

		test('a recipient who does not accept the message refuses it', async () => {
			const closed = await signup();
			assert.strictEqual((await api('i/update', { chatScope: 'none' }, closed)).status, 200);
			const blocker = await signup();
			assert.strictEqual((await api('i/update', { chatScope: 'everyone' }, blocker)).status, 200);
			assert.strictEqual((await api('blocking/create', { userId: alice.id }, blocker)).status, 200);

			assertRefused(await api('chat/messages/create-to-user', { toUserId: closed.id, text: 'hello' }, alice), 'CANNOT_CHAT_WITH_USER');
			assertRefused(await api('chat/messages/create-to-user', { toUserId: blocker.id, text: 'hello' }, alice), 'YOU_HAVE_BEEN_BLOCKED');
		});
	});
});
