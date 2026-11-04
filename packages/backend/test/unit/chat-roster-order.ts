/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { alice, bob, carol, chatRosterFixture, dave, erin, LOCAL, LOCAL_ROOM_URI, membersOf, MIRROR_URI } from '../misc/chat-roster-fixture.js';

const BASE = Date.now() - 60 * 60 * 1000;
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();
const MILLISECOND_ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAR_AHEAD = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const add = (member: { uri: string | null }, published?: string, actor = bob) => ({
	type: 'Add', actor: actor.uri, target: MIRROR_URI, object: member.uri, published,
});
const remove = (member: { uri: string | null }, published?: string, actor = bob, target = MIRROR_URI) => ({
	type: 'Remove', actor: actor.uri, target, object: member.uri, published,
});
const invite = (published?: string) => ({
	type: 'Invite',
	actor: bob.uri,
	target: `${LOCAL}/users/${alice.id}`,
	object: { type: 'Group', id: MIRROR_URI, name: 'mirror', attributedTo: bob.uri },
	published,
});
const undoInvite = (published?: string) => ({
	type: 'Undo', actor: bob.uri, object: invite(), published,
});

describe('the order of Add and Remove in a room', () => {
	test('a newer Add applies and is remembered', async () => {
		const f = chatRosterFixture({ states: [['mirror', carol.id, at(1)]] });

		await f.inbox.add(bob, add(carol, at(2)));

		expect(membersOf(f, 'mirror')).toEqual([carol.id]);
		expect(f.states.rows.get(`mirror/${carol.id}`)?.toISOString()).toBe(at(2));
	});

	test('an Add older than a Remove that overtook it does not bring the member back', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', carol.id]] });

		await f.inbox.remove(bob, remove(carol, at(2)));
		await f.inbox.add(bob, add(carol, at(1)));

		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test('a Remove older than the Add it follows does not remove the member', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', carol.id]], states: [['mirror', carol.id, at(2)]] });

		await f.inbox.remove(bob, remove(carol, at(1)));

		expect(membersOf(f, 'mirror')).toEqual([carol.id]);
	});

	test('a Remove wins a tie', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', carol.id]], states: [['mirror', carol.id, at(2)]] });

		await f.inbox.remove(bob, remove(carol, at(2)));

		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test('an Add does not win a tie', async () => {
		const f = chatRosterFixture({ states: [['mirror', carol.id, at(2)]] });

		await f.inbox.add(bob, add(carol, at(2)));

		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test.each([
		['does not state a time', undefined],
		['states a time far ahead', FAR_AHEAD],
		['states something other than a time', 'soon'],
	])('a server that %s is applied in arrival order, and cannot freeze the member', async (_label, published) => {
		const f = chatRosterFixture({ states: [['mirror', carol.id, at(2)]] });

		await f.inbox.add(bob, add(carol, published));
		expect(membersOf(f, 'mirror')).toEqual([carol.id]);
		expect(f.states.rows.get(`mirror/${carol.id}`)?.toISOString()).toBe(at(2));

		await f.inbox.remove(bob, remove(carol, published));
		expect(membersOf(f, 'mirror')).toEqual([]);
		expect(f.states.rows.get(`mirror/${carol.id}`)?.toISOString()).toBe(at(2));
	});

	test('a Remove from the owner naming an account not known here fetches it and remembers the change', async () => {
		const unknown = { id: 'grace', host: 'other.test', uri: 'https://other.test/users/grace' };
		const f = chatRosterFixture();
		f.inbox.apPersonService.resolvePerson = async () => unknown;

		await f.inbox.remove(bob, remove(unknown, at(2)));
		expect(f.states.rows.get(`mirror/${unknown.id}`)?.toISOString()).toBe(at(2));

		await f.inbox.add(bob, add(unknown, at(1)));

		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test('someone who is not in a room owned here leaves no record by saying they left', async () => {
		const f = chatRosterFixture();

		await f.inbox.remove(carol, remove(carol, at(1), carol, LOCAL_ROOM_URI));

		expect(f.states.rows.size).toBe(0);
	});
});

describe('an Invite among the changes', () => {
	test('moves the record up to its time, so a late Remove from before it changes nothing', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });

		await f.inbox.invite(bob, invite(at(2)));
		expect(f.states.rows.get(`mirror/${alice.id}`)?.toISOString()).toBe(at(2));

		await f.inbox.remove(bob, remove({ uri: `${LOCAL}/users/${alice.id}` }, at(1)));

		expect(membersOf(f, 'mirror')).toEqual([alice.id]);
	});

	test('from a server that does not state a time still arrives and leaves the record alone', async () => {
		const f = chatRosterFixture({ states: [['mirror', alice.id, at(1)]] });

		await f.inbox.invite(bob, invite());

		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: 'mirror', userId: alice.id })]);
		expect(f.states.rows.get(`mirror/${alice.id}`)?.toISOString()).toBe(at(1));
	});

	test('older than a cancellation that overtook it does not offer the invitation', async () => {
		const f = chatRosterFixture({ states: [['mirror', alice.id, at(2)]] });

		await f.inbox.invite(bob, invite(at(1)));

		expect(f.invitations.rows).toEqual([]);
	});
});

describe('a Reject among the changes', () => {
	const reject = (published?: string) => ({
		type: 'Reject',
		actor: carol.uri,
		object: { type: 'Invite', actor: `${LOCAL}/users/${alice.id}`, object: LOCAL_ROOM_URI, target: carol.uri },
		published,
	});

	test('older than what the same server said last does not consume the invitation now pending', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', carol.id]] });
		f.states.memberAt.set(`localroom/${carol.id}`, new Date(at(2)));
		f.states.rows.set(`localroom/${carol.id}`, new Date(0));

		await f.inbox.reject(carol, reject(at(1)), f.resolver);

		expect(f.invitations.rows).toHaveLength(1);
	});

	test.each([[at(3)], [undefined]])('newer than that, or without a time, consumes it (%s)', async (published) => {
		const f = chatRosterFixture({ invitations: [['localroom', carol.id]] });
		f.states.memberAt.set(`localroom/${carol.id}`, new Date(at(2)));
		f.states.rows.set(`localroom/${carol.id}`, new Date(0));

		await f.inbox.reject(carol, reject(published), f.resolver);

		expect(f.invitations.rows).toEqual([]);
	});

	test('is not compared with the time of the invitation, which is by another clock', async () => {
		const f = chatRosterFixture();
		await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);

		await f.inbox.reject(carol, reject(at(0)), f.resolver);

		expect(f.invitations.rows).toEqual([]);
	});
});

describe('accepting an invitation', () => {
	const accepted = (published?: string) => ({
		type: 'Accept',
		actor: carol.uri,
		object: { type: 'Invite', actor: `${LOCAL}/users/${alice.id}`, object: { id: LOCAL_ROOM_URI, type: 'Group' }, target: carol.uri },
		published,
	});

	test('keeps a late Remove from before it from removing the member', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', carol.id]] });

		await f.inbox.accept(carol, accepted(at(2)), f.resolver);
		await f.inbox.remove(carol, remove(carol, at(1), carol, LOCAL_ROOM_URI));

		expect(membersOf(f, 'localroom')).toEqual([carol.id]);
	});

	test('someone who was never invited gets no answer that would reveal the room', async () => {
		const f = chatRosterFixture();

		const result = await f.inbox.accept(carol, accepted(at(2)), f.resolver);

		expect(result).toMatch(/^skip:/);
		expect(f.delivered()).toEqual([]);
		expect(membersOf(f, 'localroom')).toEqual([]);
	});

	test('on this server sends Accept even when an old membership is still here', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], invitations: [['mirror', alice.id]] });

		await f.chatService.joinToRoom(alice.id, 'mirror');

		const accept = f.delivered().find(({ activity }) => activity.type === 'Accept');
		expect(accept?.to).toBe(bob.inbox);
		expect(accept?.activity.published).toMatch(MILLISECOND_ISO_8601);
		expect(f.invitations.rows).toEqual([]);
		expect(membersOf(f, 'mirror')).toEqual([alice.id]);
		expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalledWith('mirror', 'membershipStarted', expect.anything());
	});

	test('does not treat a local join as a change by the owner, so a cancellation that crossed it still applies', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]], states: [['mirror', alice.id, at(1)]] });

		await f.chatService.joinToRoom(alice.id, 'mirror');

		expect(f.states.rows.get(`mirror/${alice.id}`)?.toISOString()).toBe(at(1));
	});
});

describe('a cancelled invitation', () => {
	test('removes the pending invitation and is remembered', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]], states: [['mirror', alice.id, at(1)]] });

		await f.inbox.undo(bob, undoInvite(at(2)), f.resolver);

		expect(f.invitations.rows).toEqual([]);
		expect(f.states.rows.get(`mirror/${alice.id}`)?.toISOString()).toBe(at(2));
	});

	test('that crossed the acceptance takes back the membership the owner will never count', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], states: [['mirror', alice.id, at(1)]] });

		await f.inbox.undo(bob, undoInvite(at(2)), f.resolver);

		expect(membersOf(f, 'mirror')).toEqual([]);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('mirror', 'membershipEnded', { userId: alice.id });
	});

	test.each([[at(1)], [at(2)]])('late, after accepting a newer invitation, leaves the membership alone (%s)', async (published) => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], states: [['mirror', alice.id, at(2)]] });

		await f.inbox.undo(bob, undoInvite(published), f.resolver);

		expect(membersOf(f, 'mirror')).toEqual([alice.id]);
	});

	test('late, while a newer invitation is pending, leaves that invitation alone', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]], states: [['mirror', alice.id, at(2)]] });

		await f.inbox.undo(bob, undoInvite(at(1)), f.resolver);

		expect(f.invitations.rows).toHaveLength(1);
	});

	test('without a time cannot be placed, so it leaves a membership alone', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], states: [['mirror', alice.id, at(1)]] });

		await f.inbox.undo(bob, undoInvite(), f.resolver);

		expect(membersOf(f, 'mirror')).toEqual([alice.id]);
	});

	test('without a time still removes a pending invitation', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]] });

		await f.inbox.undo(bob, undoInvite(), f.resolver);

		expect(f.invitations.rows).toEqual([]);
	});

	test('from someone other than the owner changes nothing', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });

		await f.inbox.undo(carol, { ...undoInvite(at(2)), actor: carol.uri, object: { ...invite(), actor: carol.uri } }, f.resolver);

		expect(membersOf(f, 'mirror')).toEqual([alice.id]);
	});
});

describe('what this server sends states its time in milliseconds', () => {
	test('Remove when leaving a room', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });

		await f.chatService.leaveRoom(alice.id, 'mirror');

		expect(f.delivered().find(({ activity }) => activity.type === 'Remove')?.activity.published).toMatch(MILLISECOND_ISO_8601);
	});

	test('Remove when removing a member', async () => {
		const f = chatRosterFixture({ memberships: [['localroom', carol.id]] });

		await f.chatService.kickRoomMember(alice as never, await f.rooms.findOneBy({ id: 'localroom' }) as never, carol.id);

		expect(f.delivered().find(({ activity }) => activity.type === 'Remove')?.activity.published).toMatch(MILLISECOND_ISO_8601);
	});

	test('Undo when cancelling an invitation', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', carol.id]] });

		await f.chatService.cancelRoomInvitation(alice.id, f.invitations.rows[0].id);

		expect(f.delivered().find(({ activity }) => activity.type === 'Undo')?.activity.published).toMatch(MILLISECOND_ISO_8601);
	});

	test('Invite', async () => {
		const f = chatRosterFixture();

		await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);

		expect(f.delivered().find(({ activity }) => activity.type === 'Invite')?.activity.published).toMatch(MILLISECOND_ISO_8601);
	});

	test('Reject when refusing an invitation', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]] });

		await f.chatService.rejectRoomInvitation(alice.id, 'mirror');

		expect(f.delivered().find(({ activity }) => activity.type === 'Reject')?.activity.published).toMatch(MILLISECOND_ISO_8601);
	});
});

describe('a message or an edit from someone not known to be in the room', () => {
	const note = (overrides: Record<string, unknown> = {}) => ({
		id: 'https://third.test/chat/messages/n1',
		type: 'Note',
		attributedTo: erin.uri,
		content: 'hello',
		_misskey_talk: true,
		to: [`${LOCAL}/users/${alice.id}`],
		...overrides,
	});

	test('in another server\'s room waits for the roster', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });

		await expect(f.inbox.createChatMessage(f.resolver, erin, note({ _misskey_chatRoom: MIRROR_URI }), { type: 'Create' })).rejects.toThrow('chat room membership is not ready');

		expect(f.queueService.createChatRoomRosterSyncJob).toHaveBeenCalledWith('mirror');
	});

	test('an edit in another server\'s room waits for the roster too', async () => {
		const uri = 'https://third.test/chat/messages/n1';
		const f = chatRosterFixture({
			memberships: [['mirror', alice.id]],
			messages: [{ id: 'n1', uri, fromUserId: erin.id, toRoomId: 'mirror', toUserId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] }],
		});

		await expect(f.inbox.update(erin, { type: 'Update', actor: erin.uri, object: note({ _misskey_chatRoom: MIRROR_URI, updated: at(2) }) }, f.resolver)).rejects.toThrow('chat room membership is not ready');

		expect(f.queueService.createChatRoomRosterSyncJob).toHaveBeenCalledWith('mirror');
		expect(f.messages.rows[0].text).toBe('hello');
	});

	test('in a room owned here is skipped: this server knows who is in it', async () => {
		const f = chatRosterFixture();

		const result = await f.inbox.createChatMessage(f.resolver, erin, note({ _misskey_chatRoom: LOCAL_ROOM_URI }), { type: 'Create' });

		expect(result).toMatch(/^skip:/);
		expect(f.queueService.createChatRoomRosterSyncJob).not.toHaveBeenCalled();
	});

	test('an edit in a room owned here from someone neither invited nor in it is dropped without retrying', async () => {
		const uri = 'https://third.test/chat/messages/n1';
		const f = chatRosterFixture({
			messages: [{ id: 'n1', uri, fromUserId: erin.id, toRoomId: 'localroom', toUserId: null, text: 'hello', reactions: [], deletedAt: null, editedAt: null, fileIds: [], emojis: [] }],
		});

		const result = await f.inbox.update(erin, { type: 'Update', actor: erin.uri, object: note({ _misskey_chatRoom: LOCAL_ROOM_URI, updated: at(2) }) }, f.resolver);

		expect(result).toMatch(/^skip:/);
		expect(f.messages.rows[0].text).toBe('hello');
		expect(f.queueService.createChatRoomRosterSyncJob).not.toHaveBeenCalled();
	});

	test('in a room owned here, someone invited may still be on their way in', async () => {
		const f = chatRosterFixture({ invitations: [['localroom', erin.id]] });

		await expect(f.inbox.createChatMessage(f.resolver, erin, note({ _misskey_chatRoom: LOCAL_ROOM_URI }), { type: 'Create' })).rejects.toThrow('chat room membership is not ready');

		expect(f.queueService.createChatRoomRosterSyncJob).not.toHaveBeenCalled();
	});
});

describe('asking the owner for the roster', () => {
	const reaction = (actor: { uri: string | null }, published = at(1)) => ({
		id: `${actor.uri}/chat-reactions/1`,
		type: 'EmojiReact',
		actor: actor.uri,
		object: 'https://remote.test/chat/messages/m1',
		content: '👍',
		published,
	});
	const roomMessage = { id: 'm1', uri: 'https://remote.test/chat/messages/m1', fromUserId: bob.id, toRoomId: 'mirror', reactions: [], deletedAt: null, editedAt: null, fileIds: [], text: 'hello' };
	const sync = (f: ReturnType<typeof chatRosterFixture>) => f.queueService.createChatRoomRosterSyncJob;

	test('a reaction from someone this server has not heard of in another server\'s room waits for the roster', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [{ ...roomMessage }] });

		await expect(f.inbox.like(erin, reaction(erin))).rejects.toThrow('chat room membership is not ready');

		expect(sync(f)).toHaveBeenCalledWith('mirror');
	});

	test('a reaction from a member asks nothing', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id], ['mirror', erin.id]], messages: [{ ...roomMessage }] });

		await f.inbox.like(erin, reaction(erin));

		expect(sync(f)).not.toHaveBeenCalled();
		expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/👍`]);
	});

	test('a reaction from a stranger in a room owned here is refused without asking anyone', async () => {
		const message = { ...roomMessage, uri: `${LOCAL}/chat/messages/m1`, fromUserId: alice.id, toRoomId: 'localroom' };
		const f = chatRosterFixture({ messages: [message] });

		const result = await f.inbox.like(erin, { ...reaction(erin), object: message.uri });

		expect(result).toMatch(/^skip:/);
		expect(sync(f)).not.toHaveBeenCalled();
	});

	test('asks once a minute for each member', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [{ ...roomMessage }] });

		await expect(f.inbox.like(erin, reaction(erin))).rejects.toThrow();
		await expect(f.inbox.like(erin, reaction(erin))).rejects.toThrow();

		expect(sync(f)).toHaveBeenCalledTimes(1);
	});
});

describe('an account here and the Add that names it', () => {
	const daveHere = { uri: `${LOCAL}/users/${dave.id}` };

	test('without their acceptance, an Add does not make them a member', async () => {
		const f = chatRosterFixture();

		const result = await f.inbox.add(bob, add(daveHere, at(1)));

		expect(result).toMatch(/^skip:/);
		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test('after their acceptance, an Add brings back what the roster took away before the owner heard of it', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', dave.id]], states: [['mirror', dave.id, at(1)]] });
		await f.chatService.joinToRoom(dave.id, 'mirror');
		await f.chatService.removeRoomMember(await f.rooms.findOneBy({ id: 'mirror' }) as never, dave as never);
		expect(membersOf(f, 'mirror')).toEqual([]);

		await f.inbox.add(bob, add(daveHere, at(2)));

		expect(membersOf(f, 'mirror')).toEqual([dave.id]);
	});

	test('leaving forgets the acceptance', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', dave.id]], states: [['mirror', dave.id, at(1)]] });
		await f.chatService.joinToRoom(dave.id, 'mirror');
		await f.chatService.leaveRoom(dave.id, 'mirror');

		const result = await f.inbox.add(bob, add(daveHere, at(2)));

		expect(result).toMatch(/^skip:/);
		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test('the owner removing them forgets the acceptance', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', dave.id]], states: [['mirror', dave.id, at(1)]] });
		await f.chatService.joinToRoom(dave.id, 'mirror');
		await f.inbox.remove(bob, remove(daveHere, at(2)));

		const result = await f.inbox.add(bob, add(daveHere, at(3)));

		expect(result).toMatch(/^skip:/);
		expect(membersOf(f, 'mirror')).toEqual([]);
	});

	test('a cancellation that crossed the acceptance forgets it', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', alice.id]], states: [['mirror', alice.id, at(1)]] });
		await f.chatService.joinToRoom(alice.id, 'mirror');
		await f.inbox.undo(bob, undoInvite(at(2)), f.resolver);
		expect(membersOf(f, 'mirror')).toEqual([]);

		const result = await f.inbox.add(bob, add({ uri: `${LOCAL}/users/${alice.id}` }, at(3)));

		expect(result).toMatch(/^skip:/);
		expect(membersOf(f, 'mirror')).toEqual([]);
	});
});

describe('every way of becoming a member leaves a record', () => {
	const accepted = (published?: string) => ({
		type: 'Accept',
		actor: carol.uri,
		object: { type: 'Invite', actor: `${LOCAL}/users/${alice.id}`, object: { id: LOCAL_ROOM_URI, type: 'Group' }, target: carol.uri },
		published,
	});
	const recorded = (f: ReturnType<typeof chatRosterFixture>, roomId: string, userId: string) => f.states.rows.get(`${roomId}/${userId}`);

	test.each([
		['a room owned here', 'localroom'],
		['another server\'s room', 'mirror'],
	])('joining %s by accepting an invitation from before the record was kept', async (_label, roomId) => {
		const f = chatRosterFixture({ invitations: [[roomId, dave.id]] });

		await f.chatService.joinToRoom(dave.id, roomId);

		expect(membersOf(f, roomId)).toEqual([dave.id]);
		expect(recorded(f, roomId, dave.id)).toBeInstanceOf(Date);
	});

	test('joining leaves the time of the invitation in place, so that a cancellation crossing the join still applies', async () => {
		const f = chatRosterFixture({ invitations: [['mirror', dave.id]], states: [['mirror', dave.id, at(1)]] });

		await f.chatService.joinToRoom(dave.id, 'mirror');

		expect(recorded(f, 'mirror', dave.id)?.toISOString()).toBe(at(1));
	});

	test.each([
		['that states a time', at(2)],
		['that does not state one', undefined],
		['that states one far ahead', FAR_AHEAD],
	])('an Accept %s', async (_label, published) => {
		const f = chatRosterFixture({ invitations: [['localroom', carol.id]] });

		await f.inbox.accept(carol, accepted(published), f.resolver);

		expect(membersOf(f, 'localroom')).toEqual([carol.id]);
		expect(recorded(f, 'localroom', carol.id)).toBeInstanceOf(Date);
		expect(recorded(f, 'localroom', carol.id)!.getTime()).toBeLessThan(Date.parse(FAR_AHEAD));
	});

	test.each([
		['that states a time', at(2)],
		['that does not state one', undefined],
		['that states one far ahead', FAR_AHEAD],
	])('an Add %s', async (_label, published) => {
		const f = chatRosterFixture();

		await f.inbox.add(bob, add(carol, published));

		expect(membersOf(f, 'mirror')).toEqual([carol.id]);
		expect(recorded(f, 'mirror', carol.id)).toBeInstanceOf(Date);
		expect(recorded(f, 'mirror', carol.id)!.getTime()).toBeLessThan(Date.parse(FAR_AHEAD));
	});

	// The roster job has its own test in chat-roster.ts. A new way of inserting a membership has to be added to these and to the list below.
	test('these are all the ways', () => {
		const sourceRoot = resolve(import.meta.dirname, '../../src');
		const inserting = /manager\.insert\(MiChatRoomMembership|chatRoomMembershipsRepository\.(insert|insertOne|save|upsert)\(/g;
		const sites = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
			.filter(file => file.endsWith('.ts'))
			.flatMap(file => Array.from(readFileSync(resolve(sourceRoot, file), 'utf8').matchAll(inserting), () => file.replaceAll('\\', '/')))
			.toSorted();

		expect(sites).toEqual([
			'core/ChatService.ts',
			'core/activitypub/ApInboxService.ts',
			'core/activitypub/ApInboxService.ts',
			'queue/processors/ChatRoomRosterSyncProcessorService.ts',
		]);
	});
});

describe('servers whose clocks disagree', () => {
	const NOW = Date.now();
	const accepted = (published: string) => ({
		type: 'Accept',
		actor: carol.uri,
		object: { type: 'Invite', actor: `${LOCAL}/users/${alice.id}`, object: { id: LOCAL_ROOM_URI, type: 'Group' }, target: carol.uri },
		published,
	});
	const ownRemove = (published: string) => remove(carol, published, carol, LOCAL_ROOM_URI);
	const room = (f: ReturnType<typeof chatRosterFixture>) => f.rooms.findOneBy({ id: 'localroom' }) as never;

	// The member's clock reads this far from the owner's. Ahead stays within what counts as a date at all.
	describe.each([
		['an hour behind', -60 * 60 * 1000],
		['four minutes ahead', 4 * 60 * 1000],
	])('in a room owned here, with a member\'s server %s', (_label, skew) => {
		const memberClock = (seconds: number) => new Date(NOW + skew + seconds * 1000).toISOString();

		test('leaving right after accepting counts', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			await f.inbox.accept(carol, accepted(memberClock(0)), f.resolver);
			expect(membersOf(f, 'localroom')).toEqual([carol.id]);

			await f.inbox.remove(carol, ownRemove(memberClock(1)));

			expect(membersOf(f, 'localroom')).toEqual([]);
		});

		test('leaving right after being invited again and accepting counts', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			await f.inbox.accept(carol, accepted(memberClock(-20)), f.resolver);
			await f.chatService.kickRoomMember(alice as never, await room(f), carol.id);
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			await f.inbox.accept(carol, accepted(memberClock(0)), f.resolver);

			await f.inbox.remove(carol, ownRemove(memberClock(1)));

			expect(membersOf(f, 'localroom')).toEqual([]);
		});

		test('a leave from before the new membership, arriving late, does not end it', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			await f.inbox.accept(carol, accepted(memberClock(-20)), f.resolver);
			await f.chatService.kickRoomMember(alice as never, await room(f), carol.id);
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			await f.inbox.accept(carol, accepted(memberClock(0)), f.resolver);

			await f.inbox.remove(carol, ownRemove(memberClock(-10)));

			expect(membersOf(f, 'localroom')).toEqual([carol.id]);
		});

		test('a leave that overtook its Accept keeps them out', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);

			await f.inbox.remove(carol, ownRemove(memberClock(1)));
			await f.inbox.accept(carol, accepted(memberClock(0)), f.resolver);

			expect(membersOf(f, 'localroom')).toEqual([]);
			expect(f.invitations.rows).toEqual([]);
		});
	});

	describe('in another server\'s room', () => {
		const ownerClock = (seconds: number) => new Date(NOW - 60 * 60 * 1000 + seconds * 1000).toISOString();
		const aliceHere = { uri: `${LOCAL}/users/${alice.id}` };

		test('a cancellation crossing an acceptance applies though the owner\'s clock reads earlier than ours', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(ownerClock(0)));
			await f.chatService.joinToRoom(alice.id, 'mirror');

			await f.inbox.undo(bob, undoInvite(ownerClock(1)), f.resolver);

			expect(membersOf(f, 'mirror')).toEqual([]);
		});

		test('a Remove from the owner after an acceptance applies though the owner\'s clock reads earlier than ours', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(ownerClock(0)));
			await f.chatService.joinToRoom(alice.id, 'mirror');

			await f.inbox.remove(bob, remove(aliceHere, ownerClock(1)));

			expect(membersOf(f, 'mirror')).toEqual([]);
		});

		test('a late Remove from the owner, older than the invitation since accepted, changes nothing', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(ownerClock(0)));
			await f.chatService.joinToRoom(alice.id, 'mirror');

			await f.inbox.remove(bob, remove(aliceHere, ownerClock(-1)));

			expect(membersOf(f, 'mirror')).toEqual([alice.id]);
		});

		test('a member leaving goes by arrival: their clock cannot be placed among the owner\'s', async () => {
			const behind = chatRosterFixture({ memberships: [['mirror', carol.id]], states: [['mirror', carol.id, ownerClock(10)]] });
			await behind.inbox.remove(carol, remove(carol, ownerClock(-100), carol));
			expect(membersOf(behind, 'mirror')).toEqual([]);
			expect(behind.states.rows.get(`mirror/${carol.id}`)?.toISOString()).toBe(ownerClock(10));

			const ahead = chatRosterFixture({ memberships: [['mirror', carol.id]], states: [['mirror', carol.id, ownerClock(0)]] });
			await ahead.inbox.remove(carol, remove(carol, new Date(NOW + 4 * 60 * 1000).toISOString(), carol));
			expect(membersOf(ahead, 'mirror')).toEqual([]);

			await ahead.inbox.add(bob, add(carol, ownerClock(10)));
			expect(membersOf(ahead, 'mirror')).toEqual([carol.id]);
		});
	});
});

describe('an answer repeats the time of the invitation it answers', () => {
	const answer = (type: 'Accept' | 'Reject', invitedAt: string | undefined) => ({
		type,
		actor: carol.uri,
		object: {
			type: 'Invite',
			actor: `${LOCAL}/users/${alice.id}`,
			object: type === 'Accept' ? { id: LOCAL_ROOM_URI, type: 'Group' } : LOCAL_ROOM_URI,
			target: carol.uri,
			published: invitedAt,
		},
		published: at(50),
	});
	const send = (f: ReturnType<typeof chatRosterFixture>, type: 'Accept' | 'Reject', invitedAt: string | undefined) =>
		type === 'Accept' ? f.inbox.accept(carol, answer(type, invitedAt), f.resolver) : f.inbox.reject(carol, answer(type, invitedAt), f.resolver);
	const sentInvite = (f: ReturnType<typeof chatRosterFixture>) => f.delivered().findLast(({ activity }) => activity.type === 'Invite')?.activity.published as string;

	describe.each(['Accept', 'Reject'] as const)('%s, in a room owned here', (type) => {
		test('of an earlier invitation, arriving after it was cancelled and sent again, leaves the new one alone', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			await f.chatService.cancelRoomInvitation(alice.id, f.invitations.rows[0].id);
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);
			const earlier = new Date(Date.parse(sentInvite(f)) - 5000).toISOString();

			const result = await send(f, type, earlier);

			expect(result).toMatch(/^skip:/);
			expect(f.invitations.rows).toHaveLength(1);
			expect(membersOf(f, 'localroom')).toEqual([]);
		});

		test('of the invitation pending now takes effect', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);

			await send(f, type, sentInvite(f));

			expect(f.invitations.rows).toEqual([]);
			expect(membersOf(f, 'localroom')).toEqual(type === 'Accept' ? [carol.id] : []);
		});

		test('from a server that does not repeat the time is taken as before', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);

			await send(f, type, undefined);

			expect(f.invitations.rows).toEqual([]);
			expect(membersOf(f, 'localroom')).toEqual(type === 'Accept' ? [carol.id] : []);
		});

		test('repeating something that is not a time is taken as not repeating one', async () => {
			const f = chatRosterFixture();
			await f.chatService.createRoomInvitation(alice.id, 'localroom', carol.id);

			await send(f, type, 'yesterday-ish');

			expect(f.invitations.rows).toEqual([]);
		});

		test('of no invitation at all reveals nothing', async () => {
			const f = chatRosterFixture();

			expect(await send(f, type, at(1))).toMatch(/^skip:/);
			expect(f.delivered()).toEqual([]);
			expect(membersOf(f, 'localroom')).toEqual([]);
		});
	});

	describe('from this server, answering another server\'s room', () => {
		const answered = (f: ReturnType<typeof chatRosterFixture>, type: string) => f.delivered().find(({ activity }) => activity.type === type)?.activity.object;

		test('Accept repeats the time as it was received', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(at(2)));

			await f.chatService.joinToRoom(alice.id, 'mirror');

			expect(answered(f, 'Accept').published).toBe(at(2));
		});

		test('Accept repeats it with a membership a lost Remove left behind', async () => {
			const f = chatRosterFixture({ memberships: [['mirror', alice.id]] });
			await f.inbox.invite(bob, invite(at(2)));

			await f.chatService.joinToRoom(alice.id, 'mirror');

			expect(answered(f, 'Accept').published).toBe(at(2));
		});

		test('Reject repeats the time as it was received', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(at(2)));

			await f.chatService.rejectRoomInvitation(alice.id, 'mirror');

			expect(answered(f, 'Reject').published).toBe(at(2));
		});

		test('Reject repeats it when a moderator removes this server\'s copy', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(at(2)));

			await f.chatService.deleteRoom(await f.rooms.findOneBy({ id: 'mirror' }) as never, { id: 'moderator', host: null } as never);

			expect(answered(f, 'Reject').published).toBe(at(2));
		});

		test.each([
			['does not state a time', undefined],
			['states one far ahead', FAR_AHEAD],
		])('nothing is repeated when the Invite %s', async (_label, published) => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(published));

			await f.chatService.joinToRoom(alice.id, 'mirror');

			expect(answered(f, 'Accept')).not.toHaveProperty('published');
		});

		test('the newer of two Invites is the one answered, whichever came first', async () => {
			const f = chatRosterFixture();
			await f.inbox.invite(bob, invite(at(2)));
			await f.inbox.invite(bob, invite(at(3)));
			await f.chatService.joinToRoom(alice.id, 'mirror');
			expect(answered(f, 'Accept').published).toBe(at(3));

			const later = chatRosterFixture();
			await later.inbox.invite(bob, invite(at(3)));
			await later.inbox.invite(bob, invite(at(2)));
			await later.chatService.joinToRoom(alice.id, 'mirror');
			expect(answered(later, 'Accept').published).toBe(at(3));
		});
	});
});
