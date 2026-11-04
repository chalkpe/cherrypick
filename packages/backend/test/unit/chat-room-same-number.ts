/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { alice, bob, carol, chatRosterFixture, erin, LOCAL, membersOf } from '../misc/chat-roster-fixture.js';

// A room number means something only on the server that gave it. Mastodon's are small and count up, so two servers soon share one.
const BOB_ROOM = 'https://remote.test/chat/rooms/34';
const CAROL_ROOM = 'https://other.test/chat/rooms/34';
const ALICE_URI = `${LOCAL}/users/${alice.id}`;

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 3, 0, minutes)).toISOString();

const invite = (owner: { uri: string | null }, room: string, published = at(1)) => ({
	type: 'Invite',
	actor: owner.uri,
	target: ALICE_URI,
	object: { type: 'Group', id: room, name: `room of ${owner.uri}`, attributedTo: owner.uri },
	published,
});

const note = (author: { uri: string | null }, room: string, id: string, extra: Record<string, unknown> = {}) => ({
	id: `${author.uri}/chat/messages/${id}`,
	type: 'Note',
	attributedTo: author.uri,
	content: id,
	_misskey_talk: true,
	_misskey_chatRoom: room,
	to: [ALICE_URI],
	...extra,
});

/** What matters here is the room a message goes to, so the message is only written down. */
function withMessages(f: ReturnType<typeof chatRosterFixture>) {
	Object.defineProperty(f.chatService, 'createMessageToRoom', {
		value: vi.fn(async (author: { id: string }, room: { id: string }, params: { text: string; uri: string }) => {
			await f.messages.insert({ id: `stored${f.messages.rows.length}`, uri: params.uri, fromUserId: author.id, toRoomId: room.id, toUserId: null, text: params.text, reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] });
		}),
	});
	return f;
}

/** alice is invited to the room with the same number on both servers. */
async function invited() {
	const f = withMessages(chatRosterFixture());
	await f.inbox.invite(bob, invite(bob, BOB_ROOM));
	await f.inbox.invite(carol, invite(carol, CAROL_ROOM));
	const bobMirror = (await f.rooms.findOneBy({ uri: BOB_ROOM }))!;
	const carolMirror = (await f.rooms.findOneBy({ uri: CAROL_ROOM }))!;
	return { f, bobMirror, carolMirror };
}

/** alice has joined both, and each owner has heard of it. */
async function joined() {
	const { f, bobMirror, carolMirror } = await invited();
	await f.chatService.joinToRoom(alice.id, bobMirror.id);
	await f.chatService.joinToRoom(alice.id, carolMirror.id);
	return { f, bobMirror, carolMirror };
}

const sentTo = (f: ReturnType<typeof chatRosterFixture>, owner: { inbox?: string | null }, type: string) =>
	f.delivered().filter(({ to, activity }) => to === owner.inbox && activity.type === type).map(({ activity }) => activity);

describe('two servers giving a room the same number', () => {
	describe('invitations', () => {
		test('each makes its own copy of the room, under its own owner and URI', async () => {
			const { f, bobMirror, carolMirror } = await invited();

			expect(bobMirror).toMatchObject({ ownerId: bob.id, uri: BOB_ROOM });
			expect(carolMirror).toMatchObject({ ownerId: carol.id, uri: CAROL_ROOM });
			expect(bobMirror.id).not.toBe(carolMirror.id);
			expect(f.invitations.rows.map(row => row.roomId).sort()).toEqual([bobMirror.id, carolMirror.id].sort());
		});

		test('a copy from before takes the number only for its own server', async () => {
			const f = chatRosterFixture();
			f.rooms.rows.push({ id: '34', name: 'old', description: '', ownerId: bob.id, uri: BOB_ROOM, isArchived: false });

			await f.inbox.invite(carol, invite(carol, CAROL_ROOM));

			expect(await f.rooms.findOneBy({ id: '34' })).toMatchObject({ ownerId: bob.id, uri: BOB_ROOM });
			const mirror = await f.rooms.findOneBy({ uri: CAROL_ROOM });
			expect(mirror).toMatchObject({ ownerId: carol.id });
			expect(mirror?.id).not.toBe('34');
		});

		test('someone else on the owner\'s server cannot take over a copy', async () => {
			const { f, bobMirror } = await invited();
			const sameServer = { ...bob, id: 'bobs-neighbor', uri: 'https://remote.test/users/bobs-neighbor' };

			await expect(f.inbox.invite(sameServer, invite(sameServer, BOB_ROOM))).resolves.toBe('skip: inviter is not the room owner');

			expect((await f.rooms.findOneBy({ uri: BOB_ROOM }))?.ownerId).toBe(bob.id);
			expect(bobMirror.ownerId).toBe(bob.id);
		});

		test('a cancellation reaches only the invitation of its own server', async () => {
			const { f, bobMirror, carolMirror } = await invited();

			await f.inbox.undoInvite(carol, invite(carol, CAROL_ROOM), new Date(at(2)));

			expect(f.invitations.rows.map(row => row.roomId)).toEqual([bobMirror.id]);
			expect(f.invitations.rows.map(row => row.roomId)).not.toContain(carolMirror.id);
		});

		test('joining answers the owner of that room, with the URI the owner wrote', async () => {
			const { f, carolMirror } = await invited();

			await f.chatService.joinToRoom(alice.id, carolMirror.id);

			const [accept, ...rest] = sentTo(f, carol, 'Accept');
			expect(rest).toEqual([]);
			expect(accept.object.object.id).toBe(CAROL_ROOM);
			expect(sentTo(f, bob, 'Accept')).toEqual([]);
			expect(membersOf(f, carolMirror.id)).toEqual([alice.id]);
		});

		test('rejecting answers the owner of that room, with the URI the owner wrote', async () => {
			const { f, carolMirror, bobMirror } = await invited();

			await f.chatService.rejectRoomInvitation(alice.id, carolMirror.id);

			expect(sentTo(f, carol, 'Reject').map(activity => activity.object.object)).toEqual([CAROL_ROOM]);
			expect(sentTo(f, bob, 'Reject')).toEqual([]);
			expect(f.invitations.rows.map(row => row.roomId)).toEqual([bobMirror.id]);
		});
	});

	describe('messages', () => {
		test('each lands in the room of the URI it names', async () => {
			const { f, bobMirror, carolMirror } = await joined();

			await f.inbox.createChatMessage(f.resolver, bob, note(bob, BOB_ROOM, 'from-bob'), { type: 'Create' });
			await f.inbox.createChatMessage(f.resolver, carol, note(carol, CAROL_ROOM, 'from-carol'), { type: 'Create' });

			expect(f.messages.rows.find(row => row.uri === `${bob.uri}/chat/messages/from-bob`)?.toRoomId).toBe(bobMirror.id);
			expect(f.messages.rows.find(row => row.uri === `${carol.uri}/chat/messages/from-carol`)?.toRoomId).toBe(carolMirror.id);
		});

		test('someone cannot write in the other room by naming its URI', async () => {
			const { f } = await joined();

			await expect(f.inbox.createChatMessage(f.resolver, carol, note(carol, BOB_ROOM, 'forged'), { type: 'Create' }))
				.rejects.toThrow('chat room membership is not ready');

			expect(f.messages.rows).toEqual([]);
		});

		test('what alice sends names the room by the URI its owner wrote', async () => {
			const { f, carolMirror } = await joined();
			f.messages.rows.push({ id: 'm1', uri: null, fromUserId: alice.id, toRoomId: carolMirror.id, toUserId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] });

			await f.chatService.deleteMessage(f.messages.rows[0] as never);

			expect(sentTo(f, carol, 'Delete')[0]).toMatchObject({ context: CAROL_ROOM, _misskey_chatRoom: CAROL_ROOM });
			expect(sentTo(f, bob, 'Delete')).toEqual([]);
		});

		test('an edit and a deletion stay with their own message', async () => {
			const { f, bobMirror, carolMirror } = await joined();
			await f.inbox.createChatMessage(f.resolver, bob, note(bob, BOB_ROOM, 'same'), { type: 'Create' });
			await f.inbox.createChatMessage(f.resolver, carol, note(carol, CAROL_ROOM, 'same'), { type: 'Create' });
			const bobUri = `${bob.uri}/chat/messages/same`;
			const carolUri = `${carol.uri}/chat/messages/same`;

			await f.inbox.update(carol, { type: 'Update', actor: carol.uri, object: note(carol, CAROL_ROOM, 'same', { content: 'edited', updated: at(5) }) }, f.resolver);
			expect(f.messages.rows.find(row => row.uri === carolUri)).toMatchObject({ text: 'edited', toRoomId: carolMirror.id });
			expect(f.messages.rows.find(row => row.uri === bobUri)).toMatchObject({ text: 'same', toRoomId: bobMirror.id });

			await f.inbox.delete(carol, { type: 'Delete', actor: carol.uri, object: { id: carolUri, type: 'Tombstone' } });
			expect(f.messages.rows.find(row => row.uri === carolUri)?.deletedAt).not.toBeNull();
			expect(f.messages.rows.find(row => row.uri === bobUri)?.deletedAt).toBeNull();
		});

		test('a relayed message goes to the room of the owner relaying it', async () => {
			const relayed = note(erin, CAROL_ROOM, 'relayed');
			const f = withMessages(chatRosterFixture({ fetched: { [relayed.id]: relayed } }));
			await f.inbox.invite(bob, invite(bob, BOB_ROOM));
			await f.inbox.invite(carol, invite(carol, CAROL_ROOM));
			const bobMirror = (await f.rooms.findOneBy({ uri: BOB_ROOM }))!;
			const carolMirror = (await f.rooms.findOneBy({ uri: CAROL_ROOM }))!;
			await f.chatService.joinToRoom(alice.id, bobMirror.id);
			await f.chatService.joinToRoom(alice.id, carolMirror.id);
			f.memberships.rows.push({ id: 'erin-in-carol', roomId: carolMirror.id, userId: erin.id }, { id: 'erin-in-bob', roomId: bobMirror.id, userId: erin.id });

			await f.inbox.relayedChatMessage(carol, { id: `${CAROL_ROOM}#relay/1`, type: 'Announce', actor: carol.uri, to: [ALICE_URI], object: relayed.id }, relayed.id, CAROL_ROOM, f.resolver);

			expect(f.messages.rows).toEqual([expect.objectContaining({ uri: relayed.id, toRoomId: carolMirror.id })]);
		});

		test('an owner cannot relay into the other room', async () => {
			const { f } = await joined();
			const reaction = { id: `${erin.uri}/chat-reactions/1`, type: 'EmojiReact', actor: erin.uri, object: `${carol.uri}/chat/messages/x`, content: '👍' };

			await expect(f.inbox.relayedChatActivity(bob, reaction, CAROL_ROOM, f.resolver)).resolves.toBe('skip: room is not on the relaying server');
			await expect(f.inbox.relayedChatActivity(carol, reaction, BOB_ROOM, f.resolver)).resolves.toBe('skip: room is not on the relaying server');
		});
	});

	describe('members', () => {
		test('an Add reaches only the room of its owner', async () => {
			const { f, bobMirror, carolMirror } = await joined();

			await expect(f.inbox.add(carol, { type: 'Add', actor: carol.uri, target: CAROL_ROOM, object: erin.uri, published: at(3) })).resolves.toBe('ok: chat room member added');

			expect(membersOf(f, carolMirror.id)).toContain(erin.id);
			expect(membersOf(f, bobMirror.id)).not.toContain(erin.id);
		});

		test('an owner cannot add to the other room', async () => {
			const { f, bobMirror } = await joined();

			await expect(f.inbox.add(carol, { type: 'Add', actor: carol.uri, target: BOB_ROOM, object: erin.uri, published: at(3) })).resolves.toBe('skip: only the room owner can add a member');

			expect(membersOf(f, bobMirror.id)).not.toContain(erin.id);
		});

		test('being removed from one leaves the other', async () => {
			const { f, bobMirror, carolMirror } = await joined();

			await f.inbox.remove(carol, { type: 'Remove', actor: carol.uri, target: CAROL_ROOM, object: ALICE_URI, published: at(3) });

			expect(membersOf(f, carolMirror.id)).not.toContain(alice.id);
			expect(membersOf(f, bobMirror.id)).toContain(alice.id);
		});
	});

	describe('the room itself', () => {
		test('an Update changes only the room of its owner', async () => {
			const { f, bobMirror, carolMirror } = await joined();

			await f.inbox.update(carol, { id: `${CAROL_ROOM}#update`, type: 'Update', actor: carol.uri, object: { id: CAROL_ROOM, type: 'Group', name: 'renamed', summary: '', attributedTo: carol.uri, updated: at(3) } }, f.resolver);

			expect((await f.rooms.findOneBy({ id: carolMirror.id }))?.name).toBe('renamed');
			expect((await f.rooms.findOneBy({ id: bobMirror.id }))?.name).toBe(`room of ${bob.uri}`);
		});

		test('deleting one leaves the other, and the other can still invite', async () => {
			const { f, bobMirror, carolMirror } = await joined();

			await expect(f.inbox.delete(carol, { type: 'Delete', actor: carol.uri, object: { id: CAROL_ROOM, type: 'Tombstone', formerType: 'Group' } })).resolves.toBe('ok: chat room deleted');

			expect(await f.rooms.findOneBy({ id: carolMirror.id })).toBeNull();
			expect(await f.rooms.findOneBy({ id: bobMirror.id })).not.toBeNull();
			expect(membersOf(f, bobMirror.id)).toContain(alice.id);
			expect(await f.chatRosterService.isRoomGone(CAROL_ROOM)).toBe(true);
			expect(await f.chatRosterService.isRoomGone(BOB_ROOM)).toBe(false);
		});
	});
});

describe('rows from before room URIs were kept', () => {
	const old = { id: '34', name: 'old', description: '', ownerId: bob.id, uri: null, isArchived: false };

	test('are taken up again by the owner, who fills in the URI', async () => {
		const f = chatRosterFixture();
		f.rooms.rows.push({ ...old });

		await f.inbox.invite(bob, invite(bob, BOB_ROOM));

		expect(f.rooms.rows.filter(row => row.ownerId === bob.id && row.id !== 'mirror')).toEqual([expect.objectContaining({ id: '34', uri: BOB_ROOM })]);
		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: '34' })]);
	});

	test('are left alone by another server with the same number', async () => {
		const f = chatRosterFixture();
		f.rooms.rows.push({ ...old });

		await f.inbox.invite(carol, invite(carol, CAROL_ROOM));

		expect(await f.rooms.findOneBy({ id: '34' })).toMatchObject({ ownerId: bob.id, uri: null });
		expect(await f.rooms.findOneBy({ uri: CAROL_ROOM })).toMatchObject({ ownerId: carol.id });
	});

	test('still get what names them on the owner\'s server', async () => {
		const f = withMessages(chatRosterFixture({ memberships: [['34', alice.id]] }));
		f.rooms.rows.push({ ...old });

		await f.inbox.createChatMessage(f.resolver, bob, note(bob, BOB_ROOM, 'hello'), { type: 'Create' });

		expect(f.messages.rows[0]).toMatchObject({ toRoomId: '34' });
	});

	test('do not take what names the same number on another server', async () => {
		const f = chatRosterFixture({ memberships: [['34', alice.id], ['34', carol.id]] });
		f.rooms.rows.push({ ...old });

		await expect(f.inbox.createChatMessage(f.resolver, bob, note(bob, CAROL_ROOM, 'hello'), { type: 'Create' })).rejects.toThrow('chat room is not ready');

		expect(f.messages.rows).toEqual([]);
	});
});

describe('servers from before room URIs write the room with their own host', () => {
	const ownHost = (actor: { uri: string | null }, number: string) => `${new URL(actor.uri!).origin}/chat/rooms/${number}`;

	test('in a message to a room owned here', async () => {
		const f = withMessages(chatRosterFixture({ memberships: [['localroom', carol.id]] }));

		await f.inbox.createChatMessage(f.resolver, carol, note(carol, ownHost(carol, 'localroom'), 'hello'), { type: 'Create' });

		expect(f.messages.rows[0]).toMatchObject({ toRoomId: 'localroom' });
	});

	test('in a message to a room of a third server that its author is in', async () => {
		const { f, bobMirror } = await invited();
		f.memberships.rows.push({ id: 'erin-in-bob', roomId: bobMirror.id, userId: erin.id }, { id: 'alice-in-bob', roomId: bobMirror.id, userId: alice.id });

		await f.inbox.createChatMessage(f.resolver, erin, note(erin, ownHost(erin, '34'), 'hello'), { type: 'Create' });

		expect(f.messages.rows[0]).toMatchObject({ toRoomId: bobMirror.id });
	});

	test('with no telling which room when the author is in two with that number', async () => {
		const { f, bobMirror, carolMirror } = await invited();
		f.memberships.rows.push({ id: 'a', roomId: bobMirror.id, userId: erin.id }, { id: 'b', roomId: carolMirror.id, userId: erin.id });

		await expect(f.inbox.createChatMessage(f.resolver, erin, note(erin, ownHost(erin, '34'), 'hello'), { type: 'Create' })).rejects.toThrow('chat room is not ready');

		expect(f.messages.rows).toEqual([]);
	});

	test('but only their own host: a room is not found for someone naming another server', async () => {
		const { f, bobMirror } = await invited();
		f.memberships.rows.push({ id: 'erin-in-bob', roomId: bobMirror.id, userId: erin.id });

		await expect(f.inbox.createChatMessage(f.resolver, erin, note(erin, 'https://evil.test/chat/rooms/34', 'hello'), { type: 'Create' })).rejects.toThrow('chat room is not ready');

		expect(f.messages.rows).toEqual([]);
	});
});
