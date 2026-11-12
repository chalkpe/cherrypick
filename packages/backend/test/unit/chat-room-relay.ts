/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { meta as membersMeta } from '@/server/api/endpoints/chat/rooms/members.js';
import { alice, bob, carol, chatRosterFixture, dave, erin, frank, LOCAL, LOCAL_ROOM_URI, mallory, MIRROR_URI } from '../misc/chat-roster-fixture.js';

const BASE = Date.now() - 60 * 60 * 1000;
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

const carolMessageUri = 'https://other.test/chat/messages/m1';

test('room member listing requires the chat read permission', () => {
	expect(membersMeta.kind).toBe('read:chat');
});

function storedMessage(overrides: Record<string, unknown> = {}) {
	return { id: 'm1', uri: carolMessageUri, fromUserId: carol.id, toRoomId: 'mirror', toUserId: null, text: 'hello', reactions: [] as string[], deletedAt: null, editedAt: null, fileIds: [], emojis: [], ...overrides };
}

describe('the owner passes on what a member did', () => {
	const roomOwnedHere = [['localroom', carol.id], ['localroom', erin.id], ['localroom', dave.id]] as [string, string][];
	const message = () => storedMessage({ toRoomId: 'localroom' });
	const room = (f: ReturnType<typeof chatRosterFixture>) => f.rooms.findOneBy({ id: 'localroom' });
	const announces = (f: ReturnType<typeof chatRosterFixture>) => f.delivered().filter(({ activity }) => activity.type === 'Announce');

	test('an edit, naming the message and the time it was edited', async () => {
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [message()] });
		const editedAt = new Date(at(5));

		await f.chatService.updateRemoteMessage(carol as never, f.messages.rows[0] as never, 'edited', editedAt);

		const [relay, ...rest] = announces(f);
		expect(rest).toEqual([]);
		expect(relay.from).toBe(alice.id);
		expect(relay.to).toBe(erin.inbox);
		expect(relay.activity).toMatchObject({
			id: `${LOCAL_ROOM_URI}#relay/${encodeURIComponent(carolMessageUri)}/${editedAt.getTime()}`,
			actor: `${LOCAL}/users/${alice.id}`,
			object: carolMessageUri,
			context: LOCAL_ROOM_URI,
			_misskey_chatRoom: LOCAL_ROOM_URI,
		});
	});

	test('an edit that changed nothing is not passed on', async () => {
		const editedAt = new Date(at(5));
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [{ ...message(), editedAt }] });

		await f.chatService.updateRemoteMessage(carol as never, f.messages.rows[0] as never, 'older', new Date(at(4)));

		expect(announces(f)).toEqual([]);
	});

	test('a deletion, carrying the activity itself', async () => {
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [message()] });
		const activity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${carolMessageUri}#delete`,
			type: 'Delete',
			actor: carol.uri,
			object: { id: carolMessageUri, type: 'Tombstone' },
			signature: { type: 'RsaSignature2017' },
		};

		await f.chatService.deleteRemoteMessage(carol as never, f.messages.rows[0] as never, { activity });

		const [relay, ...rest] = announces(f);
		expect(rest).toEqual([]);
		expect(relay.to).toBe(erin.inbox);
		expect(relay.activity.id).toBe(`${LOCAL_ROOM_URI}#relay/${encodeURIComponent(activity.id)}`);
		expect(relay.activity.object).toEqual({ id: activity.id, type: 'Delete', actor: carol.uri, object: activity.object });
	});

	test('a reaction, once, however many copies of it arrive', async () => {
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [message()] });
		const activity = { id: `${erin.uri}/chat-reactions/1`, type: 'EmojiReact', actor: erin.uri, object: carolMessageUri, content: '👍' };

		await f.chatService.reactRemote(erin as never, await f.messages.findOneBy({ id: 'm1' }) as never, '👍', activity.id, { activity });
		await f.chatService.reactRemote(erin as never, await f.messages.findOneBy({ id: 'm1' }) as never, '👍', activity.id, { activity });

		const [relay, ...rest] = announces(f);
		expect(rest).toEqual([]);
		expect(relay.to).toBe(carol.inbox);
		expect(relay.activity.id).toBe(`${LOCAL_ROOM_URI}#relay/${encodeURIComponent(activity.id)}`);
		expect(relay.activity.object).toEqual(activity);
	});

	test('the withdrawal of a reaction', async () => {
		const pair = `${erin.id}/👍`;
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [{ ...message(), reactions: [pair] }] });
		const like = { id: `${erin.uri}/chat-reactions/1`, type: 'EmojiReact', actor: erin.uri, object: carolMessageUri, content: '👍' };
		const activity = { id: `${like.id}/undo`, type: 'Undo', actor: erin.uri, object: like };

		await f.chatService.unreactRemote(erin as never, f.messages.rows[0] as never, '👍', like.id, { activity });

		const [relay, ...rest] = announces(f);
		expect(rest).toEqual([]);
		expect(relay.activity.object).toEqual(activity);
	});

	test('a reaction that arrived before its message, when the message arrives', async () => {
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [message()] });
		const activity = { id: `${erin.uri}/chat-reactions/1`, type: 'EmojiReact', actor: erin.uri, object: carolMessageUri, content: '👍' };

		await f.chatService.storePendingChatReaction(erin.id, carolMessageUri, '👍', false, activity.id, { activity });
		await f.chatService.applyPendingChatReactions(await f.messages.findOneBy({ id: 'm1' }) as never);

		expect(announces(f).map(({ activity: announce }) => announce.object)).toEqual([activity]);
	});

	test('an activity without an ID cannot be told apart from its copies, so it is not passed on', async () => {
		const f = chatRosterFixture({ memberships: roomOwnedHere, messages: [message()] });

		await f.chatService.deleteRemoteMessage(carol as never, f.messages.rows[0] as never, { activity: { type: 'Delete', actor: carol.uri, object: carolMessageUri } as never });

		expect(announces(f)).toEqual([]);
	});

	test('only the owner\'s server passes anything on', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', carol.id], ['mirror', erin.id], ['mirror', alice.id]], messages: [storedMessage()] });

		await f.chatService.updateRemoteMessage(carol as never, f.messages.rows[0] as never, 'edited', new Date(at(5)));
		await f.chatService.deleteRemoteMessage(carol as never, f.messages.rows[0] as never, { activity: { id: 'https://other.test/d', type: 'Delete', actor: carol.uri, object: carolMessageUri } as never });

		expect(announces(f)).toEqual([]);
		expect(await room(f)).not.toBeNull();
	});
});

describe('receiving what the owner passed on', () => {
	const members = [['mirror', alice.id], ['mirror', carol.id], ['mirror', erin.id]] as [string, string][];
	const relay = (object: unknown, overrides: Record<string, unknown> = {}) => ({
		id: `${MIRROR_URI}#relay/${encodeURIComponent((object as { id: string }).id)}`,
		type: 'Announce',
		actor: bob.uri,
		to: [`${LOCAL}/users/${alice.id}`],
		object,
		context: MIRROR_URI,
		_misskey_chatRoom: MIRROR_URI,
		...overrides,
	});
	const deletion = (actor: { uri: string | null } = carol, target = carolMessageUri) => ({ id: `${target}#delete`, type: 'Delete', actor: actor.uri, object: { id: target, type: 'Tombstone', formerType: 'Note' } });
	const like = (actor: { uri: string | null } = erin, type = 'EmojiReact', target = carolMessageUri) => ({ id: `${actor.uri}/chat-reactions/1`, type, actor: actor.uri, object: target, content: '👍' });
	const undo = (actor: { uri: string | null } = erin, object: unknown = like(actor)) => ({ id: `${actor.uri}/chat-reactions/1/undo`, type: 'Undo', actor: actor.uri, object });
	const announce = (f: ReturnType<typeof chatRosterFixture>, activity: unknown, actor = bob) => f.inbox.announce(actor, activity, f.resolver);

	describe('an edit', () => {
		const editRelay = (updated: string) => ({
			id: `${MIRROR_URI}#relay/${encodeURIComponent(carolMessageUri)}/${Date.parse(updated)}`,
			type: 'Announce',
			actor: bob.uri,
			to: [`${LOCAL}/users/${alice.id}`],
			object: carolMessageUri,
			context: MIRROR_URI,
			_misskey_chatRoom: MIRROR_URI,
		});
		const fetchedNote = (text: string, updated: string) => ({
			id: carolMessageUri,
			type: 'Note',
			attributedTo: carol.uri,
			content: text,
			_misskey_content: text,
			_misskey_talk: true,
			_misskey_chatRoom: MIRROR_URI,
			updated,
			to: [`${LOCAL}/users/${alice.id}`],
		});

		test('fetches the message as a member and applies it without storing a second copy', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()], fetched: { [carolMessageUri]: fetchedNote('edited', at(5)) } });

			const result = await announce(f, editRelay(at(5)));

			expect(result).toBe('ok: chat message updated');
			expect(f.signers).toEqual([alice.id]);
			expect(f.messages.rows).toHaveLength(1);
			expect(f.messages.rows[0]).toMatchObject({ text: 'edited', editedAt: new Date(at(5)) });
		});

		test('by someone this server no longer counts waits for the roster', async () => {
			const f = chatRosterFixture({ memberships: [['mirror', alice.id], ['mirror', frank.id]], messages: [storedMessage()], fetched: { [carolMessageUri]: fetchedNote('edited', at(5)) } });

			await expect(announce(f, editRelay(at(5)))).rejects.toThrow('chat room membership is not ready');

			expect(f.signers).toEqual([alice.id]);
			expect(f.messages.rows[0].text).toBe('hello');
			expect(f.queueService.createChatRoomRosterSyncJob).toHaveBeenCalledWith('mirror');
		});

		test('older than what is stored changes nothing', async () => {
			const f = chatRosterFixture({
				memberships: members,
				messages: [storedMessage({ text: 'newer', editedAt: new Date(at(6)) })],
				fetched: { [carolMessageUri]: fetchedNote('older', at(5)) },
			});

			await announce(f, editRelay(at(5)));

			expect(f.messages.rows[0].text).toBe('newer');
		});

		test('of a message deleted by now changes nothing', async () => {
			const f = chatRosterFixture({
				memberships: members,
				messages: [storedMessage()],
				fetched: { [carolMessageUri]: { id: carolMessageUri, type: 'Tombstone' } },
			});

			const result = await announce(f, editRelay(at(5)));

			expect(result).toMatch(/^skip:/);
			expect(f.messages.rows[0].text).toBe('hello');
		});

		test('a relay of a new message already stored fetches nothing', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			const result = await announce(f, relay({ id: carolMessageUri }, { object: carolMessageUri }));

			expect(result).toBe('skip: chat message exists');
			expect(f.signers).toEqual([]);
		});
	});

	describe('where a message is fetched from', () => {
		const relayFrom = (uri: string) => ({
			id: `${MIRROR_URI}#relay/${encodeURIComponent(uri)}`,
			type: 'Announce',
			actor: bob.uri,
			to: [`${LOCAL}/users/${alice.id}`],
			object: uri,
			context: MIRROR_URI,
			_misskey_chatRoom: MIRROR_URI,
		});

		test('a server none of the members are on gets no signed request, and the roster is read again', async () => {
			const uri = 'https://attacker.example/anything';
			const f = chatRosterFixture({ memberships: members, fetched: { [uri]: {} } });

			await expect(announce(f, relayFrom(uri))).rejects.toThrow();

			expect(f.signers).toEqual([]);
			expect(f.queueService.createChatRoomRosterSyncJob).toHaveBeenCalledWith('mirror');
		});

		test('the owner\'s own server is a member\'s server', async () => {
			const uri = 'https://remote.test/chat/messages/m9';
			const f = chatRosterFixture({ memberships: members, fetched: { [uri]: { id: uri, type: 'Tombstone' } } });

			await announce(f, relayFrom(uri));

			expect(f.signers).toEqual([alice.id]);
		});

		test('a member\'s server is asked as a member', async () => {
			const uri = 'https://third.test/chat/messages/m9';
			const f = chatRosterFixture({ memberships: members, fetched: { [uri]: { id: uri, type: 'Tombstone' } } });

			await announce(f, relayFrom(uri));

			expect(f.signers).toEqual([alice.id]);
		});
	});

	describe('a deletion', () => {
		test('by the author', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			await announce(f, relay(deletion()));

			expect(f.messages.rows[0].deletedAt).not.toBeNull();
		});

		test('by the room owner', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			await announce(f, relay(deletion(bob)));

			expect(f.messages.rows[0].deletedAt).not.toBeNull();
		});

		test('by a member who has left, of their own message', async () => {
			const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [storedMessage()] });

			await announce(f, relay(deletion()));

			expect(f.messages.rows[0].deletedAt).not.toBeNull();
		});

		test('by someone else is refused', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			const result = await announce(f, relay(deletion(erin)));

			expect(result).toMatch(/^skip:/);
			expect(f.messages.rows[0].deletedAt).toBeNull();
		});

		test('of a message from another room is refused', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage({ toRoomId: 'localroom' })] });

			const result = await announce(f, relay(deletion()));

			expect(result).toMatch(/^skip:/);
			expect(f.messages.rows[0].deletedAt).toBeNull();
		});

		test('a relay arriving before the author’s Create prevents the late message from appearing', async () => {
			const f = chatRosterFixture({ memberships: members });
			const createMessage = vi.spyOn(f.chatService, 'createMessageToRoom').mockResolvedValue({} as never);
			const note = { id: carolMessageUri, type: 'Note', attributedTo: carol.uri, to: [`${LOCAL}/users/${alice.id}`], context: MIRROR_URI, _misskey_talk: true, content: 'deleted' };

			await announce(f, relay(deletion()));
			await f.inbox.create(carol, { id: `${carolMessageUri}#create`, type: 'Create', actor: carol.uri, object: note }, f.resolver);

			expect(createMessage).not.toHaveBeenCalled();
		});

		test('a pending relay cannot delete a message in another room', async () => {
			const f = chatRosterFixture({ memberships: [...members, ['localroom', carol.id]] });
			const createMessage = vi.spyOn(f.chatService, 'createMessageToRoom').mockResolvedValue({} as never);
			const note = { id: carolMessageUri, type: 'Note', attributedTo: carol.uri, to: [`${LOCAL}/users/${alice.id}`], context: LOCAL_ROOM_URI, _misskey_talk: true, content: 'kept' };

			await announce(f, relay(deletion()));
			await f.inbox.create(carol, { id: `${carolMessageUri}#create`, type: 'Create', actor: carol.uri, object: note }, f.resolver);

			expect(createMessage).toHaveBeenCalledOnce();
		});

		test('a pending relay cannot delete another author’s message on the same host', async () => {
			const f = chatRosterFixture({ memberships: [...members, ['mirror', frank.id]] });
			const createMessage = vi.spyOn(f.chatService, 'createMessageToRoom').mockResolvedValue({} as never);
			const note = { id: carolMessageUri, type: 'Note', attributedTo: frank.uri, to: [`${LOCAL}/users/${alice.id}`], context: MIRROR_URI, _misskey_talk: true, content: 'kept' };

			await announce(f, relay(deletion()));
			await f.inbox.create(frank, { id: `${carolMessageUri}#create`, type: 'Create', actor: frank.uri, object: note }, f.resolver);

			expect(createMessage).toHaveBeenCalledOnce();
		});

		test('an unrelated actor cannot leave a pending deletion', async () => {
			const f = chatRosterFixture({ memberships: members });
			const createMessage = vi.spyOn(f.chatService, 'createMessageToRoom').mockResolvedValue({} as never);
			const note = { id: carolMessageUri, type: 'Note', attributedTo: carol.uri, to: [`${LOCAL}/users/${alice.id}`], context: MIRROR_URI, _misskey_talk: true, content: 'kept' };

			expect(await announce(f, relay(deletion(erin)))).toMatch(/^skip:/);
			await f.inbox.create(carol, { id: `${carolMessageUri}#create`, type: 'Create', actor: carol.uri, object: note }, f.resolver);

			expect(createMessage).toHaveBeenCalledOnce();
		});

		test('an unknown same-host actor cannot leave a pending deletion', async () => {
			const f = chatRosterFixture({ memberships: members });

			await expect(announce(f, relay(deletion(frank)))).rejects.toThrow('chat room membership is not ready');
			expect([...f.redisClient.values.keys()].filter(key => key.startsWith('chat_delete_upon_arrival:'))).toEqual([]);
		});

		test('a local author cannot be impersonated for a pending deletion', async () => {
			const f = chatRosterFixture({ memberships: members });
			const localAuthor = { uri: `${LOCAL}/users/${alice.id}` };

			expect(await announce(f, relay(deletion(localAuthor, `${LOCAL}/chat/messages/m2`)))).toMatch(/^skip:/);
			expect([...f.redisClient.values.keys()].filter(key => key.startsWith('chat_delete_upon_arrival:'))).toEqual([]);
		});
	});

	describe('a reaction', () => {
		test.each(['EmojiReact', 'Like'])('as %s', async (type) => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			await announce(f, relay(like(erin, type)));

			expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/👍`]);
		});

		test('a copy of it changes nothing', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			await announce(f, relay(like()));
			await announce(f, relay(like()));

			expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/👍`]);
		});

		test('from someone not known to be a member waits for the roster', async () => {
			const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [storedMessage()] });

			await expect(announce(f, relay(like()))).rejects.toThrow('chat room membership is not ready');

			expect(f.messages.rows[0].reactions).toEqual([]);
			expect(f.queueService.createChatRoomRosterSyncJob).toHaveBeenCalledWith('mirror');
		});

		test('to a message from another room is refused', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage({ toRoomId: 'localroom' })] });

			expect(await announce(f, relay(like()))).toMatch(/^skip:/);
			expect(f.messages.rows[0].reactions).toEqual([]);
		});

		test('that overtook its message is kept until the message arrives', async () => {
			const f = chatRosterFixture({ memberships: members });

			await announce(f, relay(like()));
			f.messages.rows.push(storedMessage());
			await f.chatService.applyPendingChatReactions(await f.messages.findOneBy({ id: 'm1' }) as never);

			expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/👍`]);
		});

		test('kept that way counts only for a message of that room', async () => {
			const f = chatRosterFixture({ memberships: [...members, ['localroom', erin.id]] });

			await announce(f, relay(like()));
			f.messages.rows.push(storedMessage({ toRoomId: 'localroom' }));
			await f.chatService.applyPendingChatReactions(await f.messages.findOneBy({ id: 'm1' }) as never);

			expect(f.messages.rows[0].reactions).toEqual([]);
		});

		describe('with a custom emoji', () => {
			const emojiUri = 'https://third.test/emojis/blob';
			const tag = (id: string, url: string) => ({ id, type: 'Emoji', name: ':blob:', icon: { type: 'Image', url } });
			const customLike = (tagged: unknown) => ({ ...like(), content: ':blob:', tag: [tagged] });
			const extracted = (f: ReturnType<typeof chatRosterFixture>) => f.inbox.apNoteService.extractEmojis as ReturnType<typeof vi.fn>;
			const withExtract = (fetched: Record<string, unknown>) => {
				const f = chatRosterFixture({ memberships: members, messages: [storedMessage()], fetched });
				f.inbox.apNoteService.extractEmojis = vi.fn(async () => []);
				return f;
			};

			test('takes the image from the reacting account\'s server, not from what the owner passed on', async () => {
				const fromItsServer = tag(emojiUri, 'https://third.test/blob.png');
				const f = withExtract({ [emojiUri]: fromItsServer });

				await announce(f, relay(customLike(tag(emojiUri, 'https://evil.test/other.png'))));

				expect(extracted(f)).toHaveBeenCalledExactlyOnceWith(fromItsServer, erin.host);
				expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/:blob@third.test:`]);
			});

			test('does not go to another server for it, even as the owner names one', async () => {
				const elsewhere = 'https://evil.test/emojis/blob';
				const f = withExtract({ [elsewhere]: tag(elsewhere, 'https://evil.test/other.png') });

				await announce(f, relay(customLike(tag(elsewhere, 'https://evil.test/other.png'))));

				expect(f.signers).toEqual([]);
				expect(extracted(f)).not.toHaveBeenCalled();
				expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/:blob@third.test:`]);
			});

			test('what the server answers must be that emoji', async () => {
				const f = withExtract({ [emojiUri]: tag('https://third.test/emojis/other', 'https://third.test/other.png') });

				await announce(f, relay(customLike(tag(emojiUri, 'https://evil.test/other.png'))));

				expect(extracted(f)).not.toHaveBeenCalled();
			});

			test('the reaction counts even when the emoji cannot be fetched', async () => {
				const f = withExtract({ [emojiUri]: new Error('unreachable') });

				await announce(f, relay(customLike(tag(emojiUri, 'https://evil.test/other.png'))));

				expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/:blob@third.test:`]);
			});
		});

		test('the withdrawal, by someone who has left since', async () => {
			const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [storedMessage({ reactions: [`${erin.id}/👍`] })] });

			await announce(f, relay(undo()));

			expect(f.messages.rows[0].reactions).toEqual([]);
		});

		test('a withdrawal must carry the reaction itself', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage({ reactions: [`${erin.id}/👍`] })] });

			expect(await announce(f, relay(undo(erin, like().id)))).toMatch(/^skip:/);
			expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/👍`]);
		});

		test('a withdrawal of someone else\'s reaction is refused', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage({ reactions: [`${erin.id}/👍`] })] });

			expect(await announce(f, relay(undo(carol, like(erin))))).toMatch(/^skip:/);
			expect(f.messages.rows[0].reactions).toEqual([`${erin.id}/👍`]);
		});
	});

	describe('refuses', () => {
		test('anything but these three kinds', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			for (const type of ['Create', 'Update', 'Follow', 'Block', 'Add', 'Remove', 'Announce']) {
				expect(await announce(f, relay({ id: `https://other.test/${type}`, type, actor: carol.uri, object: carolMessageUri }))).toMatch(/^skip:/);
			}
			expect(f.signers).toEqual([]);
		});

		test('an activity without an ID', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			expect(await announce(f, { ...relay(deletion()), object: { type: 'Delete', actor: carol.uri, object: carolMessageUri } })).toMatch(/^skip:/);
			expect(f.messages.rows[0].deletedAt).toBeNull();
		});

		test('someone other than the room owner passing it on', async () => {
			const f = chatRosterFixture({ memberships: members, messages: [storedMessage()] });

			expect(await announce(f, relay(deletion()), carol)).toMatch(/^skip:/);
			expect(f.messages.rows[0].deletedAt).toBeNull();
		});

		test('words put in the mouth of someone on this server', async () => {
			const localMessage = storedMessage({ id: 'm2', uri: `${LOCAL}/chat/messages/m2`, fromUserId: alice.id });
			const f = chatRosterFixture({ memberships: [...members, ['mirror', dave.id]], messages: [storedMessage(), localMessage] });
			const aliceHere = { uri: `${LOCAL}/users/${alice.id}` };

			expect(await announce(f, relay(deletion(aliceHere, localMessage.uri)))).toMatch(/^skip:/);
			expect(await announce(f, relay(like(aliceHere)))).toMatch(/^skip:/);
			expect(await announce(f, relay(undo(aliceHere)))).toMatch(/^skip:/);
			expect(f.messages.rows[1].deletedAt).toBeNull();
			expect(f.messages.rows[0].reactions).toEqual([]);
		});

		test('an actor on a server this one refuses', async () => {
			const f = chatRosterFixture({ memberships: [...members, ['mirror', mallory.id]], messages: [storedMessage()], refusedHosts: ['evil.test'] });

			expect(await announce(f, relay(like(mallory)))).toMatch(/^skip:/);
			expect(f.messages.rows[0].reactions).toEqual([]);
		});

		test('a room this server does not have', async () => {
			const f = chatRosterFixture({ messages: [storedMessage()] });
			const other = 'https://remote.test/chat/rooms/other';

			expect(await announce(f, relay(deletion(), { context: other, _misskey_chatRoom: other }))).toMatch(/^skip:/);
			expect(f.messages.rows[0].deletedAt).toBeNull();
		});
	});
});

describe('what comes straight from a member\'s server', () => {
	const uri = carolMessageUri;
	const reaction = { id: `${erin.uri}/chat-reactions/1`, type: 'EmojiReact', actor: erin.uri, object: uri, content: '👍' };
	const undo = { id: `${reaction.id}/undo`, type: 'Undo', actor: erin.uri, object: reaction };

	test('the remote owner cannot erase a local author’s original through the service', async () => {
		const original = storedMessage({ uri: `${LOCAL}/chat/messages/m2`, fromUserId: alice.id, text: 'original', fileIds: ['file'], reactions: ['reaction'] });
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [original] });

		await expect(f.chatService.deleteRemoteMessage(bob as never, f.messages.rows[0] as never)).rejects.toThrow('cannot delete');
		expect(f.messages.rows[0]).toMatchObject({ text: 'original', fileIds: ['file'], reactions: ['reaction'], deletedAt: null });
	});

	test('the remote owner cannot erase a local author’s original through inbox Delete', async () => {
		const original = storedMessage({ uri: `${LOCAL}/chat/messages/m2`, fromUserId: alice.id, text: 'original', fileIds: ['file'], reactions: ['reaction'] });
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [original] });

		const result = await f.inbox.delete(bob, { type: 'Delete', actor: bob.uri, object: { id: original.uri, type: 'Tombstone', formerType: 'Note' } });

		expect(result).toMatch(/^skip:/);
		expect(f.messages.rows[0]).toMatchObject({ text: 'original', fileIds: ['file'], reactions: ['reaction'], deletedAt: null });
	});

	test('someone who has left can take their reaction back', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [storedMessage({ reactions: [`${erin.id}/👍`] })] });

		await f.inbox.undo(erin, undo, f.resolver);

		expect(f.messages.rows[0].reactions).toEqual([]);
		expect(f.queueService.createChatRoomRosterSyncJob).not.toHaveBeenCalled();
	});

	test('taking back a reaction does not touch anyone else\'s', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id]], messages: [storedMessage({ reactions: [`${carol.id}/👍`] })] });

		await f.inbox.undo(erin, undo, f.resolver);

		expect(f.messages.rows[0].reactions).toEqual([`${carol.id}/👍`]);
	});

	test('the room owner can delete someone else\'s message', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id], ['mirror', carol.id]], messages: [storedMessage()] });

		const result = await f.inbox.delete(bob, { type: 'Delete', actor: bob.uri, object: { id: uri, type: 'Tombstone', formerType: 'Note' } });

		expect(result).toBe('ok: chat message deleted');
		expect(f.messages.rows[0].deletedAt).not.toBeNull();
	});

	test('anyone else cannot', async () => {
		const f = chatRosterFixture({ memberships: [['mirror', alice.id], ['mirror', carol.id], ['mirror', erin.id]], messages: [storedMessage()] });

		const result = await f.inbox.delete(erin, { type: 'Delete', actor: erin.uri, object: { id: uri, type: 'Tombstone', formerType: 'Note' } });

		expect(result).toMatch(/^skip:/);
		expect(f.messages.rows[0].deletedAt).toBeNull();
	});

	test('the owner of a room cannot delete a message outside it', async () => {
		const direct = storedMessage({ toRoomId: null, toUserId: alice.id });
		const f = chatRosterFixture({ messages: [direct] });

		const result = await f.inbox.delete(bob, { type: 'Delete', actor: bob.uri, object: { id: uri, type: 'Tombstone', formerType: 'Note' } });

		expect(result).toMatch(/^skip:/);
		expect(f.messages.rows[0].deletedAt).toBeNull();
	});
});

describe('a server that is not told about Announce with an activity inside', () => {
	test('a plain boost of a note goes on working as before', async () => {
		const f = chatRosterFixture();
		const announced = { id: 'https://remote.test/announces/1', type: 'Announce', actor: bob.uri, object: { id: 'https://remote.test/notes/1', type: 'Delete' } };

		expect(await f.inbox.announce(bob, announced, f.resolver)).toMatch(/^skip: unknown object type/);
	});
});


describe('일반 채널 활동의 소유 서버 중계', () => {
	test.each(['update', 'delete', 'react', 'unreact'] as const)('%s를 미지원 멤버 서버로 중계하지 않는다', async operation => {
		const source = storedMessage({ toRoomId: 'localroom', toRoomChannelId: 'private', channelRefs: [], reactions: operation === 'unreact' ? [`${carol.id}/👍`] : [] });
		const f = chatRosterFixture({ memberships: [['localroom', carol.id], ['localroom', erin.id], ['localroom', bob.id]], messages: [source] });
		Object.assign(f.rooms.rows.find(room => room.id === 'localroom')!, { hasChannels: true, legacyChannelId: 'general' });
		Object.assign(f.chatService, { chatRoomChannelService: {
			remoteRefs: async () => [],
			deliverableTo: async (host: string) => host === erin.host,
		} });
		const stored = await f.messages.findOneBy({ id: source.id });
		const like = { id: `${carol.uri}/chat-reactions/channels`, type: 'EmojiReact', actor: carol.uri, object: source.uri, content: '👍' };

		if (operation === 'update') await f.chatService.updateRemoteMessage(carol as never, stored as never, 'edited', new Date());
		if (operation === 'delete') await f.chatService.deleteRemoteMessage(carol as never, stored as never, { activity: { id: `${source.uri}#delete`, type: 'Delete', actor: carol.uri, object: source.uri } as never });
		if (operation === 'react') await f.chatService.reactRemote(carol as never, { ...stored, fromUserId: erin.id } as never, '👍', like.id, { activity: like as never });
		if (operation === 'unreact') await f.chatService.unreactRemote(carol as never, stored as never, '👍', like.id, { activity: { id: `${like.id}/undo`, type: 'Undo', actor: carol.uri, object: like } as never });

		expect(f.delivered().map(delivery => delivery.to)).toEqual([erin.inbox]);
	});
});
