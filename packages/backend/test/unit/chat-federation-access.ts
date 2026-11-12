/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ChatService } from '@/core/ChatService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { chatRosterOver, forgetfulRedis } from '../misc/chat-roster-stub.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

const owner = { id: 'owner', host: 'owner.test', uri: 'https://owner.test/users/owner' };
const otherActor = { id: 'other', host: 'owner.test', uri: 'https://owner.test/users/other' };
const localUser = { id: 'local', host: null, uri: null, chatScope: 'none' };
const remoteMember = { id: 'carol', host: 'third.test', uri: 'https://third.test/users/carol' };
const roomUri = 'https://owner.test/chat/rooms/room1';
const messageUri = 'https://owner.test/chat/messages/message1';

function fixture(options: { beforeInsert?: () => Promise<void>; resolveImage?: () => Promise<null> } = {}) {
	const users = new Map<string, { id: string; host: string | null; uri: string | null }>([
		[owner.uri, owner], [otherActor.uri, otherActor], ['https://local.test/users/local', localUser],
	]);
	const memberships: { roomId: string; userId: string }[] = [];
	const messages: { id: string; uri: string; text: string | null; emojis: string[]; editedAt?: Date | null; deletedAt?: Date | null }[] = [];
	const tombstones = new Map<string, string>();
	const locks = new Map<string, string>();
	const lockExpirations = new Map<string, number>();
	const profiles = new Map<string, string>();
	let sequence = 0;
	const pipeline = { set: () => pipeline, sadd: () => pipeline, exec: async () => [] };
	const redisClient = {
		eval: memoryRedis().eval,
		get: async (key: string) => locks.get(key) ?? tombstones.get(key) ?? null,
		set: async (key: string, value: string, _mode: string, timeout: number) => {
			if ((lockExpirations.get(key) ?? Infinity) <= Date.now()) locks.delete(key);
			if (locks.has(key)) return null;
			locks.set(key, value);
			lockExpirations.set(key, Date.now() + timeout);
			return 'OK';
		},
		del: async (key: string) => locks.delete(key),
		exists: async (key: string) => Number(tombstones.has(key)),
		setex: async (key: string, _ttl: number, value: string) => { tombstones.set(key, value); },
		scard: async () => 0,
		sadd: async () => 1,
		expire: async () => 1,
		smembers: async () => [],
		sismember: async () => 0,
		pipeline: () => pipeline,
	};
	// ApInboxService writes memberships inside a transaction, so the fixture has to answer the
	// queries that transaction makes from the same in-memory memberships the assertions inspect.
	const transactionManager = {
		findOne: async () => ({ id: 'room1', ownerId: owner.id }),
		findOneBy: async (_entity: unknown, criteria: { roomId: string; userId: string }) =>
			memberships.find(member => member.roomId === criteria.roomId && member.userId === criteria.userId) ?? null,
		countBy: async (_entity: unknown, criteria: { roomId: string }) =>
			memberships.filter(member => member.roomId === criteria.roomId).length,
		insert: async (_entity: unknown, membership: typeof memberships[number]) => {
			memberships.push(membership);
			return membership;
		},
		withRepository: (repository: unknown) => repository,
	};
	const db = {
		transaction: async <T>(run: (manager: typeof transactionManager) => Promise<T>): Promise<T> => await run(transactionManager),
	};
	const chatService = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		chatMessagesRepository: {
			findOneBy: async ({ uri }: { uri: string }) => messages.find(message => message.uri === uri) ?? null,
			existsBy: async () => true,
			insertOne: async (message: typeof messages[number]) => {
				await options.beforeInsert?.();
				messages.push(message);
				return message;
			},
			update: async (criteria: string | { id: string }[], patch: Partial<typeof messages[number]>) => {
				const id = typeof criteria === 'string' ? criteria : criteria[0].id;
				const message = messages.find(message => message.id === id);
				if (message == null) return { affected: 0 };
				if (typeof criteria !== 'string' && (message.deletedAt != null ||
					(message.editedAt != null && patch.editedAt != null && message.editedAt >= patch.editedAt))) return { affected: 0 };
				Object.assign(message, patch);
				return { affected: 1 };
			},
		},
		chatApprovalsRepository: {
			createQueryBuilder: () => ({
				where() { return this; }, orWhere() { return this; }, take() { return this; },
				getMany: async () => [{ userId: localUser.id }, { userId: owner.id }],
			}),
		},
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null },
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		idService: { gen: () => `message${++sequence}` },
		chatEntityService: { packMessageLiteFor1on1: async (message: unknown) => message },
		customEmojiService: { populateEmojis: async () => ({}) },
		globalEventService: { publishChatUserStream: () => {}, publishChatRoomStream: () => {}, publishMainStream: () => {} },
		redisClient,
	});
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		db,
		chatService,
		chatMessagesRepository: chatService.chatMessagesRepository,
		globalEventService: { publishChatUserStream: () => {}, publishChatRoomStream: () => {} },
		redisClient,
		chatRosterService: chatRosterOver(redisClient),
		chatRoomsRepository: { findOneBy: async () => ({ id: 'room1', ownerId: owner.id }) },
		chatRoomMembershipsRepository: {
			findOneBy: async ({ userId }: { userId: string }) => memberships.find(member => member.userId === userId) ?? null,
			findBy: async ({ roomId }: { roomId: string }) => memberships.filter(member => member.roomId === roomId),
			insertOne: async (membership: typeof memberships[number]) => { memberships.push(membership); return membership; },
		},
		apDbResolverService: { getUserFromApId: async (uri: string) => users.get(uri) ?? null },
		apPersonService: {
			resolvePerson: async (uri: string) => {
				if (uri === remoteMember.uri) users.set(uri, remoteMember);
				return users.get(uri) ?? null;
			},
			updatePerson: async (uri: string, _resolver: unknown, object: { name: string }) => { profiles.set(uri, object.name); },
		},
		apResolverService: { createResolver: async () => ({ resolve: async (object: unknown) => object }) },
		apNoteService: { fetchNote: async () => null, extractEmojis: async () => [{ name: 'newemoji' }] },
		apImageService: { resolveImage: options.resolveImage ?? (async () => null), findStoredImage: async () => null },
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null },
		utilityService: new UtilityService({ host: 'local.test', url: 'https://local.test' } as never, {} as never),
		logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
		idService: { gen: () => `membership${++sequence}` },
	});
	return { inbox, memberships, messages, tombstones, profiles };
}

afterEach(() => vi.useRealTimers());

describe('federated chat room membership authority', () => {
	test('a remote owner cannot add a local user before local acceptance', async () => {
		const f = fixture();
		await f.inbox.add(owner, { type: 'Add', actor: owner.uri, target: roomUri, object: 'https://local.test/users/local' });
		expect(f.memberships).toEqual([]);
	});

	test('a remote owner resolves and adds a previously unknown third-server member', async () => {
		const f = fixture();
		await f.inbox.add(owner, { type: 'Add', actor: owner.uri, target: roomUri, object: remoteMember.uri });
		expect(f.memberships).toEqual([expect.objectContaining({ roomId: 'room1', userId: 'carol' })]);
	});

	test('a repeated remote membership assertion does not add a second membership', async () => {
		const f = fixture();
		f.memberships.push({ roomId: 'room1', userId: otherActor.id });
		await f.inbox.add(owner, { type: 'Add', actor: owner.uri, target: roomUri, object: otherActor.uri });
		expect(f.memberships).toEqual([{ roomId: 'room1', userId: 'other' }]);
	});

	test('the implicit room owner is not inserted as a membership', async () => {
		const f = fixture();
		await f.inbox.add(owner, { type: 'Add', actor: owner.uri, target: roomUri, object: owner.uri });
		expect(f.memberships).toEqual([]);
	});
});

describe('deferred chat delete authority', () => {
	test('a remote actor cannot tombstone a message URI on another server', async () => {
		const f = fixture();
		await f.inbox.delete(owner, { type: 'Delete', actor: owner.uri, object: 'https://third.test/chat/messages/message1' });
		expect(f.tombstones.size).toBe(0);
	});

	test('a deferred delete records its author URI', async () => {
		const f = fixture();
		await f.inbox.delete(owner, { type: 'Delete', actor: owner.uri, object: messageUri });
		expect([...f.tombstones]).toEqual([[
			'chat_delete_upon_arrival:https://owner.test/chat/messages/message1:https%3A%2F%2Fowner.test%2Fusers%2Fowner',
			'https://owner.test/users/owner',
		]]);
	});

	test.each([owner, otherActor])('a deferred delete from $id suppresses only that author’s Create', async (deleter) => {
		vi.useFakeTimers();
		const f = fixture();
		await f.inbox.delete(deleter, { type: 'Delete', actor: deleter.uri, object: messageUri });
		await f.inbox.createChatMessage({}, owner, {
			id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
			_misskey_content: 'Hello', to: ['https://local.test/users/local'],
		}, { type: 'Create', actor: owner.uri });
		expect(f.messages.map(message => message.text)).toEqual(deleter.id === owner.id ? [] : ['Hello']);
	});

	test('another actor on the same server cannot overwrite the author’s deferred deletion', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.inbox.delete(owner, { type: 'Delete', actor: owner.uri, object: messageUri });
		await f.inbox.delete(otherActor, { type: 'Delete', actor: otherActor.uri, object: messageUri });
		await f.inbox.createChatMessage({}, owner, {
			id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
			_misskey_content: 'Deleted', to: ['https://local.test/users/local'],
		}, { type: 'Create', actor: owner.uri });
		expect(f.messages).toEqual([]);
	});

	test('a Delete racing a pending Create leaves the received message deleted', async () => {
		vi.useFakeTimers();
		const insertionStarted = Promise.withResolvers<void>();
		const continueInsertion = Promise.withResolvers<void>();
		const f = fixture({ beforeInsert: async () => {
			insertionStarted.resolve();
			await continueInsertion.promise;
		} });
		const creating = f.inbox.createChatMessage({}, owner, {
			id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
			_misskey_content: 'Deleted', to: ['https://local.test/users/local'],
		}, { type: 'Create', actor: owner.uri });
		await insertionStarted.promise;
		const deleting = f.inbox.delete(owner, { type: 'Delete', actor: owner.uri, object: messageUri });
		// Let Delete reach either its lookup or the held Create lock before inserting.
		await vi.advanceTimersByTimeAsync(0);
		continueInsertion.resolve();
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all([creating, deleting]);
		expect(f.messages).toHaveLength(1);
		expect(f.messages[0].deletedAt).toBeInstanceOf(Date);
		expect(f.messages[0].text).toBeNull();
	});
});

test('ordinary Group actor updates still update the remote profile', async () => {
	const f = fixture();
	const community = { id: 'community', host: 'lemmy.test', uri: 'https://lemmy.test/c/community' };
	await f.inbox.update(community, {
		type: 'Update', actor: community.uri,
		object: { id: community.uri, type: 'Group', name: 'New community name' },
	});
	expect(f.profiles.get(community.uri)).toBe('New community name');
});

test('an Update received before Create preserves the edit timestamp and is not inserted again', async () => {
	vi.useFakeTimers();
	const f = fixture();
	const object = {
		id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
		_misskey_content: 'Edited', to: ['https://local.test/users/local'], updated: '2026-11-02T00:01:00.000Z',
	};
	await f.inbox.update(owner, { type: 'Update', actor: owner.uri, object });
	expect(f.messages[0].editedAt).toEqual(new Date('2026-11-02T00:01:00.000Z'));
	await f.inbox.createChatMessage({}, owner, { ...object, _misskey_content: 'Original', updated: undefined }, { type: 'Create', actor: owner.uri });
	expect(f.messages.map(message => message.text)).toEqual(['Edited']);
});

test('chat Updates import emoji metadata for the edited text', async () => {
	const f = fixture();
	const message = { id: 'message1', uri: messageUri, text: 'Old', emojis: ['oldemoji'] };
	f.messages.push(message);
	const updateRemoteMessage = vi.fn().mockResolvedValue(message);
	Object.defineProperty(f.inbox.chatService, 'updateRemoteMessage', { value: updateRemoteMessage });
	await f.inbox.update(owner, { type: 'Update', actor: owner.uri, object: {
		id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
		_misskey_content: ':newemoji:', updated: '2026-11-02T00:02:00.000Z',
		tag: [{ type: 'Emoji', name: ':newemoji:', icon: { type: 'Image', url: 'https://owner.test/newemoji.png' } }],
	} });
	expect(updateRemoteMessage).toHaveBeenCalledWith(owner, message, ':newemoji:', new Date('2026-11-02T00:02:00.000Z'), ['newemoji']);
});

test('Delete during a slow attachment download suppresses insertion after the old lock lease expires', async () => {
	vi.useFakeTimers();
	const downloadStarted = Promise.withResolvers<void>();
	const finishDownload = Promise.withResolvers<null>();
	const f = fixture({ resolveImage: async () => {
		downloadStarted.resolve();
		return await finishDownload.promise;
	} });
	const creating = f.inbox.createChatMessage({}, owner, {
		id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
		_misskey_content: 'Deleted', to: ['https://local.test/users/local'],
		attachment: [{ type: 'Document', url: 'https://owner.test/slow.png' }],
	}, { type: 'Create', actor: owner.uri });
	await downloadStarted.promise;
	await vi.advanceTimersByTimeAsync(30_100);
	await f.inbox.delete(owner, { type: 'Delete', actor: owner.uri, object: messageUri });
	finishDownload.resolve(null);
	await creating;
	expect(f.messages).toEqual([]);
});

test('a slow initial Update applies its newer text to a concurrent Create instead of inserting twice', async () => {
	vi.useFakeTimers();
	const downloadStarted = Promise.withResolvers<void>();
	const finishDownload = Promise.withResolvers<null>();
	const f = fixture({ resolveImage: async () => {
		downloadStarted.resolve();
		return await finishDownload.promise;
	} });
	const object = {
		id: messageUri, type: 'Note', attributedTo: owner.uri, _misskey_talk: true,
		_misskey_content: 'Edited', to: ['https://local.test/users/local'], updated: '2026-11-02T00:02:00.000Z',
		attachment: [{ type: 'Document', url: 'https://owner.test/slow.png' }],
	};
	const updating = f.inbox.update(owner, { type: 'Update', actor: owner.uri, object });
	await downloadStarted.promise;
	await vi.advanceTimersByTimeAsync(30_100);
	await f.inbox.createChatMessage({}, owner, { ...object, _misskey_content: 'Original', updated: undefined, attachment: [] }, { type: 'Create', actor: owner.uri });
	finishDownload.resolve(null);
	await updating;
	expect(f.messages.map(message => message.text)).toEqual(['Edited']);
	expect(f.messages[0].editedAt).toEqual(new Date('2026-11-02T00:02:00.000Z'));
});
