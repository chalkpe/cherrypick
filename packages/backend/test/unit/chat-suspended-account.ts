/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatMessageAccessError, ChatMessageRecipientSuspendedError, ChatRoomAccessError, ChatRoomInvitationRefusedError, ChatService } from '@/core/ChatService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { UserSuspendService } from '@/core/UserSuspendService.js';
import type { MiChatMessage } from '@/models/_.js';
import CreateToUserEndpoint from '@/server/api/endpoints/chat/messages/create-to-user.js';
import ShowEndpoint from '@/server/api/endpoints/chat/messages/show.js';
import InvitationCreateEndpoint from '@/server/api/endpoints/chat/rooms/invitations/create.js';
import { chatRosterOver, forgetfulRedis } from '../misc/chat-roster-stub.js';

const alice = { id: 'alice', host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false };

describe('delayed chat notifications after suspension', () => {
	afterEach(() => vi.useRealTimers());

	function fixture(blockCleanup = false) {
		const author = { ...alice, id: 'author' };
		const reader = { ...alice, id: 'reader', chatScope: 'everyone' };
		const room = { id: 'room1', ownerId: author.id, isArchived: false };
		const users = [author, reader];
		const notifications = vi.fn();
		const stream = vi.fn();
		let readerStillMember = true;
		let readerMuted = false;
		let message: Partial<MiChatMessage> | null = null;
		let cleanupStarted!: () => void;
		let releaseCleanup!: () => void;
		const cleanupStartedPromise = new Promise<void>(resolve => { cleanupStarted = resolve; });
		const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
		const pipeline = {
			set: () => pipeline, sadd: () => pipeline, del: () => pipeline, srem: () => pipeline,
			get: () => pipeline, exec: async () => [[null, 'message1']],
		};
		const usersRepository = {
			update: async (id: string, values: { isSuspended: boolean }) => {
				const user = users.find(candidate => candidate.id === id);
				if (user) Object.assign(user, values);
			},
			existsBy: async ({ id, isSuspended }: { id: string; isSuspended: boolean }) => users.some(user => user.id === id && user.isSuspended === isSuspended),
			findOneBy: async ({ id }: { id: string }) => users.find(user => user.id === id) ?? null,
		};
		const userEntityService = { isLocalUser: () => true, isRemoteUser: () => false, genLocalUserUri: (id: string) => `https://local.test/users/${id}` };
		const chatService = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' }, usersRepository, userEntityService,
			idService: { gen: () => 'message1' },
			chatRoomMembershipsRepository: {
				findBy: async () => [{ userId: reader.id, isMuted: readerMuted }],
				findOneBy: async ({ userId }: { userId: string }) => readerStillMember && userId === reader.id ? { userId, isMuted: readerMuted } : null,
			},
			chatMessagesRepository: {
				insertOne: async (value: Partial<MiChatMessage>) => (message = value),
				findOneBy: async () => message,
				createQueryBuilder: () => ({ select() { return this; }, where() { return this; }, andWhere() { return this; }, getRawMany: async () => {
					if (blockCleanup) {
						cleanupStarted();
						await cleanupGate;
					}
					return [];
				} }),
			},
			chatApprovalsRepository: {
				createQueryBuilder: () => ({ where() { return this; }, orWhere() { return this; }, take() { return this; }, getMany: async () => [] }),
				insertOne: async () => undefined,
			},
			roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
			userBlockingService: { checkBlocked: async () => false },
			chatEntityService: { packMessageLiteForRoom: async (value: unknown) => value, packMessageLiteFor1on1: async (value: unknown) => value, packMessageDetailed: async (value: unknown) => value },
			globalEventService: { publishChatRoomStream: vi.fn(), publishChatUserStream: vi.fn(), publishMainStream: stream },
			pushNotificationService: { pushNotification: notifications },
			redisClient: { pipeline: () => pipeline, get: async () => 'message1', incr: async () => 1 },
			chatRoomsRepository: { findOneBy: async () => room },
		}) as ChatService;
		const suspension = Object.assign(Object.create(UserSuspendService.prototype), {
			usersRepository, userEntityService, chatService,
			moderationLogService: { log: vi.fn() },
			globalEventService: { publishInternalEvent: vi.fn() },
			followRequestsRepository: { delete: async () => undefined },
			followingsRepository: { find: async () => [] },
			apRendererService: { renderDelete: () => ({}), addContext: (value: unknown) => value },
			queueService: { createUnfollowJob: vi.fn() },
		}) as UserSuspendService;
		return { author, reader, room, chatService, suspension, notifications, stream, cleanupStartedPromise, releaseCleanup, removeReader: () => { readerStillMember = false; }, muteReader: () => { readerMuted = true; } };
	}

	test('does not send a delayed room message after its author is suspended', async () => {
		vi.useFakeTimers();
		const f = fixture();

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		await f.suspension.suspend(f.author as never, f.author as never);
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.stream).not.toHaveBeenCalled();
		expect(f.notifications).not.toHaveBeenCalled();
	});

	test('still sends a delayed room message from an active author', async () => {
		vi.useFakeTimers();
		const f = fixture();

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.notifications).toHaveBeenCalledWith('reader', 'newChatMessage', expect.objectContaining({ text: 'hello' }));
	});

	test('does not notify a reader who left while an unread marker is still visible', async () => {
		vi.useFakeTimers();
		const f = fixture();

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		f.removeReader();
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.stream).not.toHaveBeenCalled();
		expect(f.notifications).not.toHaveBeenCalled();
	});

	test('does not notify a reader who muted the room before delayed delivery', async () => {
		vi.useFakeTimers();
		const f = fixture();

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		f.muteReader();
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.stream).not.toHaveBeenCalled();
		expect(f.notifications).not.toHaveBeenCalled();
	});

	test('does not notify a direct-message recipient while suspension cleanup is pending', async () => {
		vi.useFakeTimers();
		const f = fixture(true);

		await f.chatService.createMessageToUser(f.author, f.reader as never, { text: 'hello' });
		await f.suspension.suspend(f.author as never, f.author as never);
		await f.cleanupStartedPromise;
		await vi.advanceTimersByTimeAsync(3000);
		f.releaseCleanup();

		expect(f.stream).not.toHaveBeenCalled();
		expect(f.notifications).not.toHaveBeenCalled();
	});

	test('still sends a delayed direct message from an active author', async () => {
		vi.useFakeTimers();
		const f = fixture();

		await f.chatService.createMessageToUser(f.author, f.reader as never, { text: 'hello' });
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.stream).toHaveBeenCalledWith('reader', 'newChatMessage', expect.objectContaining({ text: 'hello' }));
		expect(f.notifications).toHaveBeenCalledWith('reader', 'newChatMessage', expect.objectContaining({ text: 'hello' }));
	});
});

function remoteUser(id: string, overrides: Record<string, unknown> = {}) {
	return { id, host: `${id}.test`, uri: `https://${id}.test/users/${id}`, inbox: `https://${id}.test/users/${id}/inbox`, sharedInbox: null, isSuspended: false, chatScope: 'everyone', ...overrides };
}

function createService(invitee?: { id: string }) {
	const deliver = vi.fn();
	const insertOne = vi.fn(async (message: unknown) => message);
	const insertInvitation = vi.fn(async (invitation: unknown) => invitation);
	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		idService: { gen: () => 'generated', parse: () => ({ date: new Date('2026-11-04T00:00:00Z') }) },
		queueService: { deliver },
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			addContext: (activity: unknown) => activity,
			renderChatMessage: async () => ({ type: 'Note' }),
			renderChatRoom: () => ({ type: 'Group' }),
			renderInvite: () => ({ type: 'Invite' }),
		},
		usersRepository: {
			findOneBy: async () => invitee ?? null,
			findOneByOrFail: async () => alice,
		},
		chatApprovalsRepository: {
			createQueryBuilder: () => ({
				where() { return this; }, orWhere() { return this; }, take() { return this; },
				getMany: async () => [],
			}),
			insertOne: vi.fn(),
		},
		chatMessagesRepository: { insertOne },
		chatEntityService: { packMessageLiteFor1on1: async (message: unknown) => message },
		chatRoomsRepository: { findOneBy: async () => ({ id: 'room1', ownerId: alice.id, isArchived: false }) },
		chatRoomMembershipsRepository: { countBy: async () => 1, findOneBy: async () => null },
		chatRoomInvitationsRepository: { findOneBy: async () => null, insertOne: insertInvitation },
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		globalEventService: { publishChatUserStream: vi.fn(), publishMainStream: vi.fn() },
		chatRosterService: chatRosterOver(forgetfulRedis()),
	}) as ChatService;
	return { service, insertOne, insertInvitation, inboxes: () => deliver.mock.calls.map(call => call[2]) };
}

describe('delivering chat activities to an account suspended on this server', () => {
	const active = remoteUser('active');
	const suspended = remoteUser('suspended', { isSuspended: true });
	const deliverTo = (f: ReturnType<typeof createService>, users: unknown[], type: string) =>
		(f.service as never as { deliverToRemoteUsers: (...args: unknown[]) => Promise<void> }).deliverToRemoteUsers(alice, users, { type });

	test.each(['Create', 'Update', 'Announce', 'Like', 'Add'])('holds back %s', async type => {
		const f = createService();

		await deliverTo(f, [suspended, active], type);

		expect(f.inboxes()).toEqual([active.inbox]);
	});

	test.each(['Delete', 'Remove', 'Undo'])('still sends %s, which takes something back', async type => {
		const f = createService();

		await deliverTo(f, [suspended, active], type);

		expect(f.inboxes()).toEqual([suspended.inbox, active.inbox]);
	});

	test('still reaches an active account behind the same shared inbox', async () => {
		const f = createService();
		const sharedInbox = 'https://shared.test/inbox';

		await deliverTo(f, [{ ...suspended, sharedInbox }, { ...active, sharedInbox }], 'Create');

		expect(f.inboxes()).toEqual([sharedInbox]);
	});

	test('sends a direct message to an active account', async () => {
		const f = createService();

		await f.service.createMessageToUser(alice, active as never, { text: 'hello' });

		expect(f.inboxes()).toEqual([active.inbox]);
	});

	test('sends an invitation to an active account', async () => {
		const f = createService(active);

		await f.service.createRoomInvitation(alice.id, 'room1', active.id);

		expect(f.inboxes()).toEqual([active.inbox]);
	});
});

describe('sending to an account suspended on this server', () => {
	const remote = remoteUser('suspended', { isSuspended: true });
	const local = { ...remote, host: null, inbox: null, uri: null };

	test.each([
		['remote', remote],
		['local', local],
	])('a direct message to a %s account is refused without being stored', async (_name, recipient) => {
		const f = createService();

		await expect(f.service.createMessageToUser(alice, recipient as never, { text: 'hello' })).rejects.toBeInstanceOf(ChatMessageRecipientSuspendedError);

		expect(f.insertOne).not.toHaveBeenCalled();
		expect(f.inboxes()).toEqual([]);
	});

	test('the refusal counts as final for a message from another server', () => {
		expect(new ChatMessageRecipientSuspendedError('x')).toBeInstanceOf(ChatMessageAccessError);
	});

	test('the API says why a direct message was refused', async () => {
		const service = { checkChatAvailability: vi.fn(), findOwnFilesForMessage: vi.fn().mockResolvedValue([]), createMessageToUser: vi.fn().mockRejectedValue(new ChatMessageRecipientSuspendedError('suspended')) };
		const endpoint = new CreateToUserEndpoint({ getUser: vi.fn().mockResolvedValue(remote) } as never, service as never);

		await expect(endpoint.exec({ toUserId: remote.id, text: 'hello' }, { id: 'alice' } as never, null, null)).rejects.toMatchObject({ code: 'RECIPIENT_IS_SUSPENDED' });
	});

	test.each([
		['remote', remote],
		['local', local],
	])('an invitation to a %s account is refused without being stored', async (_name, invitee) => {
		const f = createService(invitee);

		await expect(f.service.createRoomInvitation(alice.id, 'room1', invitee.id)).rejects.toMatchObject({ reason: 'suspended' });

		expect(f.insertInvitation).not.toHaveBeenCalled();
		expect(f.inboxes()).toEqual([]);
	});

	test('the API says why an invitation was refused', async () => {
		const service = { checkChatAvailability: vi.fn(), findMyRoomById: vi.fn().mockResolvedValue({ id: 'room1' }), createRoomInvitation: vi.fn().mockRejectedValue(new ChatRoomInvitationRefusedError('suspended')) };
		const endpoint = new InvitationCreateEndpoint(service as never, {} as never);

		await expect(endpoint.exec({ roomId: 'room1', userId: remote.id }, { id: 'alice' } as never, null, null)).rejects.toMatchObject({ code: 'USER_IS_SUSPENDED' });
	});
});

describe('suspending a remote account', () => {
	const owner = { id: 'owner', host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false };
	const other = remoteUser('other');
	const member = remoteUser('member', { isSuspended: true });
	const localRoom = { id: 'local-room', ownerId: owner.id, owner, isArchived: false, uri: null };
	const remoteOwner = remoteUser('remote-owner');
	const mirrorRoom = { id: 'mirror-room', ownerId: remoteOwner.id, owner: remoteOwner, isArchived: false, uri: 'https://remote-owner.test/chat/rooms/mirror-room' };

	function createRoomService(rooms: object[], target: { id: string } = member) {
		const deliver = vi.fn();
		const removed: string[] = [];
		const service = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			db: { transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback({
				findOne: async (_entity: unknown, { where }: { where: { id: string } }) => rooms.find(room => (room as { id: string }).id === where.id) ?? null,
				delete: async (_entity: unknown, where: { roomId: string }) => { removed.push(where.roomId); return { affected: 1 }; },
			}) },
			idService: { gen: () => 'generated' },
			queueService: { deliver },
			chatRoomMembershipsRepository: {
				findBy: vi.fn(async (where: { userId?: string; roomId?: string }) => where.userId != null
					? rooms.map(room => ({ roomId: (room as { id: string }).id, userId: where.userId }))
					: [{ roomId: where.roomId, userId: target.id }, { roomId: where.roomId, userId: other.id }]),
				delete: vi.fn(async (where: { roomId: string }) => { removed.push(where.roomId); return { affected: 1 }; }),
			},
			chatRoomInvitationsRepository: { findBy: vi.fn().mockResolvedValue([]) },
			chatRoomsRepository: { find: vi.fn().mockResolvedValue(rooms) },
			chatMessagesRepository: { createQueryBuilder: () => ({ select() { return this; }, where() { return this; }, andWhere() { return this; }, getRawMany: async () => [{ toUserId: 'reader' }] }) },
			usersRepository: { findBy: vi.fn().mockResolvedValue([owner, target, other]) },
			userEntityService: {
				isLocalUser: (user: { host: string | null }) => user.host == null,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
			},
			apRendererService: {
				addContext: (activity: unknown) => activity,
				genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
				renderRemove: (_actor: unknown, target: string, object: string) => ({ type: 'Remove', target, object }),
			},
			globalEventService: { publishChatRoomStream: vi.fn() },
			liveKitService: { removeParticipant: vi.fn().mockResolvedValue(undefined), identityOf: (user: { id: string }) => user.id },
			redisClient: { pipeline: () => ({ del: vi.fn().mockReturnThis(), srem: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }) },
		}) as ChatService;
		return { service, deliver, removed };
	}

	test('takes it out of the rooms owned here and tells the members, the account included', async () => {
		const f = createRoomService([localRoom]);

		await f.service.handleUserSuspended(member as never);

		expect(f.removed).toEqual(['local-room']);
		expect(f.deliver.mock.calls.map(call => call[2]).sort()).toEqual([member.inbox, other.inbox].sort());
		expect(f.deliver.mock.calls[0][1]).toMatchObject({ type: 'Remove', object: member.uri });
		expect(f.deliver.mock.calls[0][0]).toBe(owner);
	});

	test('leaves the rooms of other servers to their owners', async () => {
		const f = createRoomService([mirrorRoom]);

		await f.service.handleUserSuspended(member as never);

		expect(f.removed).toEqual([]);
		expect(f.deliver).not.toHaveBeenCalled();
	});

	test('a failure in one room does not keep it in the others', async () => {
		const f = createRoomService([{ ...localRoom, id: 'first' }, { ...localRoom, id: 'second' }]);
		const kick = vi.spyOn(f.service, 'kickRoomMember').mockRejectedValueOnce(new Error('database')).mockResolvedValue(true);

		await f.service.handleUserSuspended(member as never);

		expect(kick).toHaveBeenCalledTimes(2);
	});

	test('keeps a suspended account of this server in its rooms', async () => {
		const localMember = { ...member, host: null };
		const f = createRoomService([localRoom], localMember);

		await f.service.handleUserSuspended(localMember as never);

		expect(f.removed).toEqual([]);
	});

	function createSuspendService() {
		const chatService = { handleUserSuspended: vi.fn().mockResolvedValue(undefined) };
		const service = Object.assign(Object.create(UserSuspendService.prototype), {
			usersRepository: { update: vi.fn().mockResolvedValue({}) },
			moderationLogService: { log: vi.fn() },
			followRequestsRepository: { delete: vi.fn() },
			followingsRepository: { find: vi.fn().mockResolvedValue([]) },
			globalEventService: { publishInternalEvent: vi.fn() },
			userEntityService: { isLocalUser: () => false },
			queueService: { createUnfollowJob: vi.fn() },
			chatService,
		}) as UserSuspendService;
		return { service, chatService };
	}

	test('suspending runs the chat cleanup', async () => {
		const f = createSuspendService();

		await f.service.suspend(member as never, { id: 'moderator' } as never);

		await vi.waitFor(() => expect(f.chatService.handleUserSuspended).toHaveBeenCalledWith(member));
	});

	test('a failed chat cleanup does not stop the rest of the suspension', async () => {
		const f = createSuspendService();
		f.chatService.handleUserSuspended.mockRejectedValue(new Error('database'));

		await f.service.suspend(member as never, { id: 'moderator' } as never);

		await vi.waitFor(() => expect((f.service as never as { queueService: { createUnfollowJob: ReturnType<typeof vi.fn> } }).queueService.createUnfollowJob).toHaveBeenCalled());
	});

	test('lifting the suspension brings nothing back', async () => {
		const f = createSuspendService();

		await f.service.unsuspend(member as never, { id: 'moderator' } as never);

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.chatService.handleUserSuspended).not.toHaveBeenCalled();
	});
});

describe('the unread marks of a suspended account\'s messages', () => {
	test('go away, as the conversation they point at is no longer shown', async () => {
		const pipeline = { del: vi.fn().mockReturnThis(), srem: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) };
		const service = Object.assign(Object.create(ChatService.prototype), {
			chatMessagesRepository: { createQueryBuilder: () => ({ select() { return this; }, where() { return this; }, andWhere() { return this; }, getRawMany: async () => [{ toUserId: 'reader' }] }) },
			chatRoomMembershipsRepository: { findBy: vi.fn().mockResolvedValue([]) },
			userEntityService: { isRemoteUser: () => false },
			redisClient: { pipeline: () => pipeline },
		}) as ChatService;

		await service.handleUserSuspended({ id: 'suspended', host: null } as never);

		expect(pipeline.del).toHaveBeenCalledWith('newUserChatMessageExists:reader:suspended');
		expect(pipeline.srem).toHaveBeenCalledWith('newChatMessagesExists:reader', 'user:suspended');
	});
});

describe('messages from a suspended author', () => {
	const hidden = 'SELECT 1 FROM "user" "author" WHERE "author"."id" = "message"."fromUserId" AND "author"."isSuspended"';

	function createService() {
		const conditions: string[] = [];
		const builder = {
			andWhere(condition: unknown) { if (typeof condition === 'string') conditions.push(condition); return this; },
			where() { return this; }, orderBy() { return this; }, take() { return this; }, setParameter() { return this; }, setParameters() { return this; },
			leftJoinAndSelect() { return this; }, select() { return this; }, getQuery: () => 'query', getParameters: () => ({}), getMany: async () => [], getOne: async () => null,
		};
		const service = Object.assign(Object.create(ChatService.prototype), {
			queryService: { makePaginationQuery: () => builder },
			chatMessagesRepository: { createQueryBuilder: () => builder },
			chatRoomMembershipsRepository: { findBy: async () => [{ roomId: 'r1' }], createQueryBuilder: () => builder },
			chatRoomsRepository: { findBy: async () => [], createQueryBuilder: () => builder },
			mutingsRepository: { createQueryBuilder: () => builder },
		}) as ChatService;
		return { service, conditions };
	}

	test.each([
		['a conversation', (service: ChatService) => service.userTimeline('me', 'other', 10)],
		['a room', (service: ChatService) => service.roomTimeline('r1', 10)],
		['the list of conversations', (service: ChatService) => service.userHistory('me', 1)],
		['the list of rooms', (service: ChatService) => service.roomHistory('me', 1)],
		['a search', (service: ChatService) => service.searchMessages('me', 'text', 10, {})],
		['a search within a conversation', (service: ChatService) => service.searchMessages('me', 'text', 10, { userId: 'other' })],
		['a search within a room', (service: ChatService) => service.searchMessages('me', 'text', 10, { roomId: 'r1' })],
	])('are left out of %s', async (_name, run) => {
		const f = createService();

		await run(f.service);

		expect(f.conditions.some(condition => condition.includes(hidden))).toBe(true);
	});

	function createShow(options: { suspended: boolean; moderator: boolean }) {
		const message = { id: 'm1', fromUserId: 'author', toUserId: 'me' };
		const service = {
			checkChatAvailability: vi.fn(),
			findMessageById: vi.fn().mockResolvedValue(message),
			isFromSuspendedUser: vi.fn().mockResolvedValue(options.suspended),
		};
		const roleService = { isModerator: vi.fn().mockResolvedValue(options.moderator) };
		const entityService = { packMessageDetailed: vi.fn().mockResolvedValue(message) };
		return new ShowEndpoint(service as never, roleService as never, entityService as never);
	}

	test('cannot be opened directly', async () => {
		await expect(createShow({ suspended: true, moderator: false }).exec({ messageId: 'm1' }, { id: 'me' } as never, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_MESSAGE' });
	});

	test('stay open to a moderator handling the account', async () => {
		await expect(createShow({ suspended: true, moderator: true }).exec({ messageId: 'm1' }, { id: 'moderator' } as never, null, null)).resolves.toMatchObject({ id: 'm1' });
	});

	test('from an active author can be opened', async () => {
		await expect(createShow({ suspended: false, moderator: false }).exec({ messageId: 'm1' }, { id: 'me' } as never, null, null)).resolves.toMatchObject({ id: 'm1' });
	});
});

describe('a message from another server to a suspended account', () => {
	test('is skipped rather than retried', async () => {
		const actor = { id: 'remote-user', uri: 'https://remote.test/users/remote-user', host: 'remote.test', isSuspended: false };
		const recipient = { id: 'local-user', uri: 'https://local.test/users/local', host: null };
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			chatService: { assertCanSendToUser: vi.fn().mockRejectedValue(new ChatMessageRecipientSuspendedError('recipient is suspended')) },
			chatMessagesRepository: { findOneBy: vi.fn().mockResolvedValue(null) },
			redisClient: { get: vi.fn().mockResolvedValue(null) },
			utilityService: { extractDbHost: (uri: string) => new URL(uri).host, punyHost: (uri: string) => new URL(uri).host },
			apMfmService: { htmlToMfm: (html: string) => html },
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			apPersonService: { resolvePerson: vi.fn().mockResolvedValue(recipient) },
			roleService: { getUserPolicies: vi.fn().mockResolvedValue({ chatAvailability: 'available' }) },
			userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null },
		}) as never as { createChatMessage: (...args: unknown[]) => Promise<string> };

		await expect(inbox.createChatMessage({}, actor, { id: 'https://remote.test/chat/messages/m1', type: 'Note', attributedTo: actor.uri, to: [recipient.uri], content: 'hello', _misskey_talk: true }, { type: 'Create' })).resolves.toBe('skip: recipient is suspended');
	});
});

describe('joining a room of an owner this server has cut off', () => {
	const invitation = { id: 'invitation', roomId: 'room1', userId: 'joiner' };
	const remoteOwner = remoteUser('owner');
	const room = { id: 'room1', ownerId: remoteOwner.id, isArchived: false };

	function createJoinService(owner: object, refused = false) {
		const transaction = vi.fn();
		const service = Object.assign(Object.create(ChatService.prototype), {
			chatRoomInvitationsRepository: { findOneBy: vi.fn().mockResolvedValue(invitation) },
			chatRoomsRepository: { findOneBy: vi.fn().mockResolvedValue(room) },
			usersRepository: { findOneBy: vi.fn().mockResolvedValue(owner) },
			hostPolicyService: { isRefusedRemoteHost: vi.fn().mockResolvedValue(refused) },
			db: { transaction },
		}) as ChatService;
		return { service, transaction };
	}

	test.each([
		['suspended', { ...remoteOwner, isSuspended: true }, false],
		['on a refused server', remoteOwner, true],
	])('is refused for an owner %s, who would never hear of it', async (_name, owner, refused) => {
		const f = createJoinService(owner, refused);

		await expect(f.service.joinToRoom('joiner', 'room1')).rejects.toBeInstanceOf(ChatRoomAccessError);

		expect(f.transaction).not.toHaveBeenCalled();
	});
});
