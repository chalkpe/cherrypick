/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { buildChatRoomDelete, buildChatRoomUpdate } from '@/core/activitypub/misc/chat-payloads.js';
import { alice, bob, carol, chatRosterFixture, dave, erin, LOCAL, LOCAL_ROOM_URI, membersOf, MIRROR_URI } from '../misc/chat-roster-fixture.js';

const BASE = Date.now() - 60 * 60 * 1000;
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();
const FAR_AHEAD = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const deleteGroup = { id: `${MIRROR_URI}#delete`, type: 'Delete', actor: bob.uri, object: { id: MIRROR_URI, type: 'Tombstone', formerType: 'Group' } };
const updateGroup = (updated?: string, name = 'renamed') => ({
	id: `${MIRROR_URI}#update`,
	type: 'Update',
	actor: bob.uri,
	object: { id: MIRROR_URI, type: 'Group', name, summary: '', attributedTo: bob.uri, updated },
});
const addMember = { type: 'Add', actor: bob.uri, target: MIRROR_URI, object: carol.uri, published: at(1) };
const invite = {
	type: 'Invite',
	actor: bob.uri,
	target: `${LOCAL}/users/${alice.id}`,
	object: { type: 'Group', id: MIRROR_URI, name: 'mirror', attributedTo: bob.uri },
	published: at(1),
};

describe('a room its owner has deleted', () => {
	test('is remembered for at least thirty days', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });

		expect(await f.inbox.delete(bob, deleteGroup)).toBe('ok: chat room deleted');

		expect(f.redisClient.ttl.get(`chat_room_deleted:${MIRROR_URI}`)).toBeGreaterThanOrEqual(30 * 24 * 60 * 60);
		expect(await f.chatRosterService.isRoomDeletedByOwner(MIRROR_URI)).toBe(true);
	});

	test.each<[string, (f: ReturnType<typeof chatRosterFixture>) => Promise<unknown>]>([
		['Add', f => f.inbox.add(bob, addMember)],
		['Update', f => f.inbox.update(bob, updateGroup(at(2)), f.resolver)],
		['Delete', f => f.inbox.delete(bob, deleteGroup)],
		['Invite', f => f.inbox.invite(bob, invite)],
		['Remove', f => f.inbox.remove(bob, { type: 'Remove', actor: bob.uri, target: MIRROR_URI, object: carol.uri, published: at(1) })],
	])('skips a late %s without retrying and without keeping it for later', async (_label, send) => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.inbox.delete(bob, deleteGroup);

		await expect(send(f)).resolves.toMatch(/^(skip|room not found)/);

		expect(await f.rooms.findOneBy({ id: 'mirror' })).toBeNull();
		expect(f.invitations.rows).toEqual([]);
		expect(f.redisClient.lists.size).toBe(0);
	});

	test('a late message is skipped rather than retried', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.inbox.delete(bob, deleteGroup);

		const result = await f.inbox.createChatMessage(f.resolver, carol, {
			id: 'https://other.test/chat/messages/m1',
			type: 'Note',
			attributedTo: carol.uri,
			content: 'late',
			_misskey_talk: true,
			_misskey_chatRoom: MIRROR_URI,
			to: [`${LOCAL}/users/${alice.id}`],
		}, { type: 'Create' });

		expect(result).toMatch(/^skip:/);
	});

	test('a message for a room not known yet still waits for its Invite', async () => {
		const f = chatRosterFixture();
		await f.rooms.delete('mirror');

		await expect(f.inbox.createChatMessage(f.resolver, carol, {
			id: 'https://other.test/chat/messages/m1',
			type: 'Note',
			attributedTo: carol.uri,
			content: 'early',
			_misskey_talk: true,
			_misskey_chatRoom: MIRROR_URI,
			to: [`${LOCAL}/users/${alice.id}`],
		}, { type: 'Create' })).rejects.toThrow('chat room is not ready');
	});

	test.each<[string, Record<string, unknown>]>([
		['a deletion', { type: 'Delete', actor: carol.uri, object: { id: 'https://other.test/chat/messages/gone', type: 'Tombstone', formerType: 'Note' } }],
	])('%s of a message this server never got, naming the room, is not kept for later', async (_label, activity) => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.inbox.delete(bob, deleteGroup);

		const result = await f.inbox.delete(carol, { ...activity, context: MIRROR_URI, _misskey_chatRoom: MIRROR_URI });

		expect(result).toBe('skip: room was deleted');
		expect([...f.redisClient.values.keys()].filter(key => key.startsWith('chat_delete_upon_arrival'))).toEqual([]);
	});

	test('a deletion of a message this server never got, without naming a room, is kept as before', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.inbox.delete(bob, deleteGroup);

		const result = await f.inbox.delete(carol, { type: 'Delete', actor: carol.uri, object: { id: 'https://other.test/chat/messages/gone', type: 'Tombstone', formerType: 'Note' } });

		expect(result).toBe('ok: chat message tombstone stored');
	});

	test.each<[string, Record<string, unknown>]>([
		['a reaction', { id: 'https://other.test/react/1', type: 'EmojiReact', actor: carol.uri, object: 'https://other.test/chat/messages/gone', content: '👍' }],
		['a reaction as Like', { id: 'https://other.test/react/1', type: 'Like', actor: carol.uri, object: 'https://other.test/chat/messages/gone', content: '👍' }],
	])('%s to a message this server never got, naming the room, is not kept for later', async (_label, activity) => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.inbox.delete(bob, deleteGroup);

		const result = await f.inbox.like(carol, { ...activity, context: MIRROR_URI, _misskey_chatRoom: MIRROR_URI });

		expect(result).toBe('skip: room was deleted');
		expect(f.redisClient.lists.size).toBe(0);
	});

	test('the withdrawal of a reaction to a message this server never got, naming the room, is not kept for later', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.inbox.delete(bob, deleteGroup);
		const like = { id: 'https://other.test/react/1', type: 'EmojiReact', actor: carol.uri, object: 'https://other.test/chat/messages/gone', content: '👍', context: MIRROR_URI, _misskey_chatRoom: MIRROR_URI };

		const result = await f.inbox.undo(carol, { id: `${like.id}/undo`, type: 'Undo', actor: carol.uri, object: like, context: MIRROR_URI, _misskey_chatRoom: MIRROR_URI }, f.resolver);

		expect(result).toBe('skip: room was deleted');
	});

	test('naming a room that is gone decides nothing about a message that is here', async () => {
		const uri = 'https://other.test/chat/messages/here';
		const f = chatRosterFixture({
			memberships: [['mirror', alice.id], ['mirror', carol.id]],
			messages: [{ id: 'm1', uri, fromUserId: carol.id, toRoomId: 'mirror', toUserId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] }],
		});
		await f.chatRosterService.markRoomDeletedByOwner('https://remote.test/chat/rooms/other');

		const result = await f.inbox.delete(carol, { type: 'Delete', actor: carol.uri, object: { id: uri, type: 'Tombstone', formerType: 'Note' }, context: 'https://remote.test/chat/rooms/other' });

		expect(result).toBe('ok: chat message deleted');
		expect(f.messages.rows[0].deletedAt).not.toBeNull();
	});

	test('tells those who were in it, and only them, that it was deleted', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id], ['mirror', carol.id]], invitations: [['mirror', dave.id]] });

		await f.inbox.delete(bob, deleteGroup);

		expect(await f.chatRosterService.wasRoomDeletedFor(alice.id, 'mirror')).toBe(true);
		expect(await f.chatRosterService.wasRoomDeletedFor(dave.id, 'mirror')).toBe(true);
		expect(await f.chatRosterService.wasRoomDeletedFor(erin.id, 'mirror')).toBe(false);
	});
});

describe('a moderator removing this server\'s copy of another server\'s room', () => {
	const room = (f: ReturnType<typeof chatRosterFixture>) => f.rooms.findOneBy({ id: 'mirror' }) as never;

	test('tells the owner that the members here have left', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id], ['mirror', dave.id], ['mirror', carol.id]] });

		await f.chatService.deleteRoom(await room(f), { id: 'moderator', host: null } as never);

		const removes = f.delivered().filter(({ activity }) => activity.type === 'Remove');
		expect(removes.filter(({ to }) => to === bob.inbox).map(({ from, activity }) => [from, activity.object, activity.target])).toEqual([
			[alice.id, `${LOCAL}/users/${alice.id}`, MIRROR_URI],
			[dave.id, `${LOCAL}/users/${dave.id}`, MIRROR_URI],
		]);
		expect(removes.every(({ activity }) => activity.id != null && activity.published != null)).toBe(true);
		expect(removes.map(({ to }) => to)).toContain(carol.inbox);
	});

	test('refuses the invitations waiting here', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', dave.id]] });

		await f.chatService.deleteRoom(await room(f), { id: 'moderator', host: null } as never);

		const [reject] = f.delivered().filter(({ activity }) => activity.type === 'Reject');
		expect(reject).toMatchObject({ from: dave.id, to: bob.inbox });
	});

	test('sends nothing when the owner is the one who deleted it', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });

		await f.chatService.deleteRoom(await room(f), undefined, { federate: false });

		expect(f.delivered()).toEqual([]);
	});

	test('skips what was still on its way, but a new invitation brings the room back', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		await f.chatService.deleteRoom(await room(f), { id: 'moderator', host: null } as never);

		await expect(f.inbox.add(bob, addMember)).resolves.toMatch(/^skip:/);
		expect(await f.chatRosterService.isRoomGone(MIRROR_URI)).toBe(true);

		await f.inbox.invite(bob, invite);

		expect(await f.rooms.findOneBy({ uri: MIRROR_URI })).not.toBeNull();
		expect(f.invitations.rows).toHaveLength(1);
		expect(await f.chatRosterService.isRoomGone(MIRROR_URI)).toBe(false);
	});
});

describe('what this server sends about a message names its room', () => {
	const uri = `${LOCAL}/chat/messages/m1`;
	const roomMessage = (overrides: Record<string, unknown> = {}) => ({ id: 'm1', uri, fromUserId: alice.id, toRoomId: 'mirror', toUserId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [], ...overrides });
	const direct = { id: 'm1', uri, fromUserId: alice.id, toUserId: bob.id, toRoomId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] };
	const sent = (f: ReturnType<typeof chatRosterFixture>, type: string) => f.delivered().find(({ activity }) => activity.type === type)?.activity;
	const named = { context: MIRROR_URI, _misskey_chatRoom: MIRROR_URI };

	test('a deletion', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [roomMessage()] });

		await f.chatService.deleteMessage(f.messages.rows[0] as never);

		expect(sent(f, 'Delete')).toMatchObject(named);
	});

	test('a reaction', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', dave.id]], messages: [roomMessage()] });

		await f.chatService.react('m1', dave.id, '👍');

		expect(sent(f, 'EmojiReact')).toMatchObject(named);
	});

	test('the withdrawal of a reaction, outside and inside', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', dave.id]], messages: [roomMessage({ reactions: [`${dave.id}/👍`] })] });

		await f.chatService.unreact('m1', dave.id, '👍');

		expect(sent(f, 'Undo')).toMatchObject(named);
		expect(sent(f, 'Undo')?.object).toMatchObject(named);
	});

	test('a message between two people names none', async () => {
		const f = chatRosterFixture({ messages: [direct] });

		await f.chatService.deleteMessage(f.messages.rows[0] as never);

		expect(sent(f, 'Delete')).not.toHaveProperty('context');
		expect(sent(f, 'Delete')).not.toHaveProperty('_misskey_chatRoom');
	});
});

describe('who is named on room updates and deletions', () => {
	test('deleting an owner also sends the existing group Delete to remote members without a follow', async () => {
		const f = chatRosterFixture({ memberships: [['localroom', carol.id]], invitations: [['localroom', erin.id]] });

		await f.chatService.deleteRoomsOwnedBy(alice.id);

		expect(f.delivered().filter(({ activity }) => activity.type === 'Delete').map(({ to }) => to).sort()).toEqual([carol.inbox, erin.inbox].sort());
		expect(await f.rooms.findOneBy({ id: 'localroom' })).toBeNull();
	});

	const owner = { id: 'alice', host: null };
	const options = { baseUrl: LOCAL, published: at(1), updated: at(1) };
	const roomRow = { id: 'localroom', name: 'room', description: '', isArchived: false };

	test('a room update names nobody', () => {
		expect(buildChatRoomUpdate(roomRow, owner, options)).not.toHaveProperty('to');
	});

	test('a room deletion names nobody', () => {
		expect(buildChatRoomDelete(roomRow, owner, options)).not.toHaveProperty('to');
	});

	test('both still reach the members and those invited', async () => {
		const f = chatRosterFixture({ memberships: [['localroom', carol.id]], invitations: [['localroom', erin.id]] });
		const row = await f.rooms.findOneBy({ id: 'localroom' }) as never;

		await f.chatService.updateRoom(row, { name: 'renamed' });
		await f.chatService.deleteRoom(row);

		const inboxes = (type: string) => f.delivered().filter(({ activity }) => activity.type === type).map(({ to }) => to);
		expect(inboxes('Update').sort()).toEqual([carol.inbox, erin.inbox].sort());
		expect(inboxes('Delete').sort()).toEqual([carol.inbox, erin.inbox].sort());
		for (const { activity } of f.delivered()) expect(activity).not.toHaveProperty('to');
	});
});

describe('times from other servers in the changes they announce', () => {
	test('a room update dated far ahead does not freeze the room', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
		const updateRoom = f.chatService.updateRoom;
		const seen: unknown[] = [];
		f.inbox.chatService = Object.assign(Object.create(f.chatService), {
			updateRoom: async (room: unknown, patch: unknown, options: { remoteUpdatedAt?: Date }) => {
				seen.push(options.remoteUpdatedAt);
				return await updateRoom(room as never, patch as never, { ...options, remoteUpdatedAt: undefined });
			},
		});

		await f.inbox.update(bob, updateGroup(FAR_AHEAD), f.resolver);

		expect(seen).toEqual([undefined]);
	});

	test('a message edit dated far ahead does not outlast later edits', async () => {
		const uri = 'https://other.test/chat/messages/m1';
		const f = chatRosterFixture({
			memberships: [['mirror', alice.id], ['mirror', carol.id]],
			messages: [{ id: 'm1', uri, fromUserId: carol.id, toRoomId: 'mirror', toUserId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] }],
		});

		await f.inbox.update(carol, {
			type: 'Update',
			actor: carol.uri,
			object: { id: uri, type: 'Note', attributedTo: carol.uri, content: 'edited', _misskey_talk: true, updated: FAR_AHEAD },
		}, f.resolver);

		expect((f.messages.rows[0].editedAt as Date).getTime()).toBeLessThan(Date.parse(FAR_AHEAD));
	});
});

describe('telling someone their room lists changed', () => {
	const changed = (f: ReturnType<typeof chatRosterFixture>) => f.globalEventService.publishMainStream.mock.calls
		.filter(call => call[1] === 'chatRoomListChanged')
		.map(call => call[0]);

	test('an invitation arriving from another server', async () => {
		const f = chatRosterFixture();

		await f.inbox.invite(bob, invite);

		expect(changed(f)).toEqual([alice.id]);
	});

	test('an invitation withdrawn by another server', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]] });

		await f.inbox.undo(bob, { type: 'Undo', actor: bob.uri, object: invite, published: at(2) }, f.resolver);

		expect(changed(f)).toEqual([alice.id]);
	});

	test('an invitation on this server', async () => {
		const f = chatRosterFixture();

		await f.chatService.createRoomInvitation(alice.id, 'localroom', dave.id);

		expect(changed(f)).toEqual([dave.id]);
	});

	test('cancelling an invitation on this server', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', dave.id]] });

		await f.chatService.cancelRoomInvitation(alice.id, f.invitations.rows[0].id);

		expect(changed(f)).toEqual([dave.id]);
	});

	test.each<[string, (f: ReturnType<typeof chatRosterFixture>) => Promise<unknown>]>([
		['joining', f => f.chatService.joinToRoom(dave.id, 'localroom')],
		['ignoring', f => f.chatService.ignoreRoomInvitation(dave.id, 'localroom')],
	])('%s an invitation, for their other windows', async (_label, act) => {
		const f = chatRosterFixture({ invitations: [['localroom', dave.id]] });

		await act(f);

		expect(changed(f)).toEqual([dave.id]);
	});

	test('refusing an invitation, for their other windows and for the owner waiting on the answer', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', dave.id]] });

		await f.chatService.rejectRoomInvitation(dave.id, 'localroom');

		expect(changed(f)).toEqual([dave.id, alice.id]);
	});

	test('refusing an invitation to a room of another server tells nobody there', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]] });

		await f.chatService.rejectRoomInvitation(alice.id, 'mirror');

		expect(changed(f)).toEqual([alice.id]);
	});

	test('a refusal arriving from another server, for the owner waiting on the answer', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', carol.id]] });

		await f.inbox.reject(carol, {
			type: 'Reject',
			actor: carol.uri,
			object: { type: 'Invite', actor: `${LOCAL}/users/${alice.id}`, object: LOCAL_ROOM_URI, target: carol.uri },
		} as never, f.resolver);

		expect(f.invitations.rows).toEqual([]);
		expect(changed(f)).toEqual([alice.id]);
	});

	test('leaving a room', async () => {
		const f = chatRosterFixture({ memberships: [['localroom', dave.id]] });

		await f.chatService.leaveRoom(dave.id, 'localroom');

		expect(changed(f)).toEqual([dave.id]);
	});

	test('being removed from a room', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', dave.id]] });

		await f.inbox.remove(bob, { type: 'Remove', actor: bob.uri, target: MIRROR_URI, object: `${LOCAL}/users/${dave.id}`, published: at(1) });

		expect(changed(f)).toEqual([dave.id]);
	});

	test('creating a room', async () => {
		const f = chatRosterFixture();

		await f.chatService.createRoom(alice as never, { name: 'new' });

		expect(changed(f)).toEqual([alice.id]);
	});

	test('a room changing, for everyone here who sees it in a list', async () => {
		const f = chatRosterFixture({ memberships: [['localroom', dave.id], ['localroom', carol.id]] });

		await f.chatService.updateRoom(await f.rooms.findOneBy({ id: 'localroom' }) as never, { name: 'renamed' });

		expect(changed(f).sort()).toEqual([alice.id, dave.id].sort());
	});

	test('a room being deleted, for everyone here who saw it in a list', async () => {
		const f = chatRosterFixture({ memberships: [['localroom', dave.id], ['localroom', carol.id]] });

		await f.chatService.deleteRoom(await f.rooms.findOneBy({ id: 'localroom' }) as never);

		expect(changed(f).sort()).toEqual([alice.id, dave.id].sort());
		expect(membersOf(f, 'localroom')).toBeDefined();
	});
});
