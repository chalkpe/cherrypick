/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { UserMutingService } from '@/core/UserMutingService.js';
import type { MiChatMessage, MiChatRoom, MiMuting, MiUser } from '@/models/_.js';
import { meets } from './chat-repository-match.js';
import { memoryRedis } from './chat-unread-redis.js';
import { chatTransactions } from './chat-transactions.js';

type FixtureUser = { id: string; host: string | null; isSuspended: boolean; chatScope: string; inbox?: string; sharedInbox?: string | null; uri?: string };

/** Members on two other servers, for what has to reach them. Neither follows anyone here. */
function remoteUser(id: string, host: string): FixtureUser {
	return { id, host, isSuspended: false, chatScope: 'everyone', inbox: `https://${host}/users/${id}/inbox`, sharedInbox: null, uri: `https://${host}/users/${id}` };
}

export function chatUnreadFixture({ remoteMembers = false } = {}) {
	const reader: FixtureUser = { id: 'reader', host: null, isSuspended: false, chatScope: 'everyone' };
	const violet: FixtureUser = { id: 'violet', host: null, isSuspended: false, chatScope: 'everyone' };
	const amber: FixtureUser = { id: 'amber', host: null, isSuspended: false, chatScope: 'everyone' };
	const cobalt = remoteUser('cobalt', 'remote.test');
	const dahlia = remoteUser('dahlia', 'third.test');
	const users = [reader, violet, amber, cobalt, dahlia];
	let roomPresent = true;
	const room = { id: 'room1', ownerId: violet.id, isArchived: false, isMutedByOwner: false };
	const messages: Partial<MiChatMessage>[] = [];
	const memberships = [{ userId: reader.id, isMuted: false }, { userId: amber.id, isMuted: false }];
	if (remoteMembers) memberships.push({ userId: cobalt.id, isMuted: false }, { userId: dahlia.id, isMuted: false });
	const delivered: { actorId: string; type: string; inbox: string; jobId: string }[] = [];
	const mutings: Pick<MiMuting, 'id' | 'muterId' | 'muteeId'>[] = [];
	const main = vi.fn();
	const push = vi.fn();
	const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), succ: vi.fn(), debug: vi.fn() };
	const withAuthor = (row: Partial<MiChatMessage>) => ({ ...row, fromUser: users.find(user => user.id === row.fromUserId) });
	const matching = (where: Record<string, unknown> | Record<string, unknown>[]) => messages.filter(row => [where].flat().some(condition => meets(withAuthor(row), condition)));
	let noticeGate: Promise<void> = Promise.resolve();
	let nextId = 0;

	const mutingsRepository = {
		insert: async (muting: Pick<MiMuting, 'id' | 'muterId' | 'muteeId'>) => { mutings.push(muting); },
		delete: async (where: Record<string, unknown>) => {
			for (const muting of mutings.filter(row => meets(row, where))) mutings.splice(mutings.indexOf(muting), 1);
		},
		findBy: async (where: Record<string, unknown>) => mutings.filter(row => meets(row, where)),
		existsBy: async (where: Record<string, unknown>) => mutings.some(row => meets(row, where)),
	};

	const chatService = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		redisClient: memoryRedis(),
		logger,
		mutingsRepository,
		usersRepository: {
			findOneBy: async ({ id }: { id: string }) => users.find(user => user.id === id) ?? null,
			findOneByOrFail: async ({ id }: { id: string }) => users.find(user => user.id === id)!,
			findBy: async (where: Record<string, unknown>) => users.filter(row => meets(row, where)),
			existsBy: async (where: Record<string, unknown>) => users.some(row => meets(row, where)),
			update: async () => undefined,
		},
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
			// The account as sent to its owner, cut down to the one field these tests read.
			pack: async (userId: string) => ({ id: userId, hasUnreadChatMessages: await chatService.hasUnreadMessages(userId) }),
		},
		idService: { gen: () => `message${++nextId}`, parse: () => ({ date: new Date(0) }) },
		chatMessagesRepository: {
			insertOne: async (message: Partial<MiChatMessage>) => {
				if (messages.some(stored => stored.id === message.id)) throw new Error('duplicate message id in fixture');
				messages.push(message);
				return message;
			},
			delete: async (id: string | Record<string, unknown>) => {
				for (const message of messages.filter(row => typeof id === 'string' ? row.id === id : meets(row, id))) messages.splice(messages.indexOf(message), 1);
			},
			findOneBy: async ({ id }: { id: string }) => messages.find(message => message.id === id) ?? null,
			existsBy: async (where: Record<string, unknown> | Record<string, unknown>[]) => matching(where).length > 0,
			findOne: async ({ where }: { where: Record<string, unknown> | Record<string, unknown>[] }) => matching(where).sort((a, b) => b.id!.localeCompare(a.id!))[0] ?? null,
			find: async ({ where }: { where: Record<string, unknown> | Record<string, unknown>[] }) => matching(where).sort((a, b) => b.id!.localeCompare(a.id!)),
			findBy: async (where: Record<string, unknown> | Record<string, unknown>[]) => matching(where),
			update: async (id: string, values: Partial<MiChatMessage>) => { Object.assign(messages.find(message => message.id === id)!, values); },
			createQueryBuilder: () => {
				let alias = '';
				let authorId = '';
				return {
					select(_expression: string, selected: string) { alias = selected; return this; },
					where(_expression: string, parameters: { authorId?: string }) { authorId = parameters.authorId ?? ''; return this; },
					andWhere() { return this; },
					getRawMany: async () => alias === 'roomId'
						? [...new Set(messages.filter(message => message.fromUserId === authorId && message.toRoomId != null).map(message => message.toRoomId))].map(roomId => ({ roomId }))
						: [{ toUserId: reader.id }],
				};
			},
		},
		chatApprovalsRepository: {
			createQueryBuilder: () => ({ where() { return this; }, orWhere() { return this; }, take() { return this; }, getMany: async () => [] }),
			insertOne: async () => undefined,
		},
		chatRoomsRepository: {
			findOneBy: async () => roomPresent ? room : null,
			findOne: async () => roomPresent ? { ...room, owner: violet } : null,
			delete: async () => { roomPresent = false; },
			findBy: async ({ ownerId }: { ownerId: string }) => roomPresent && room.ownerId === ownerId ? [room] : [],
			update: async (where: { id: string; ownerId: string }, values: { isMutedByOwner: boolean }) => {
				if (!roomPresent || where.id !== room.id || where.ownerId !== room.ownerId) return { affected: 0 };
				Object.assign(room, values);
				return { affected: 1 };
			},
		},
		apRendererService: {
			renderChatMessage: async () => ({ type: 'ChatMessage' }),
			renderChatRoomDelete: () => ({ type: 'Delete' }),
			renderChatDelete: () => ({ type: 'Delete' }),
			renderChatRoomActivityRelay: () => ({ type: 'Announce' }),
			renderRemove: () => ({ type: 'Remove' }),
			genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
			addContext: (activity: unknown) => activity,
		},
		queueService: {
			// Each delivery is a job of its own on the queue. Its ID is what a caller can wait on.
			deliver: async (actor: { id: string }, activity: { type: string }, inbox: string) => {
				const jobId = `deliver${delivered.length + 1}`;
				delivered.push({ actorId: actor.id, type: activity.type, inbox, jobId });
				return { id: jobId };
			},
		},
		db: chatTransactions({
			findOne: async () => roomPresent ? room : null,
			delete: async (_entity: unknown, where: { userId: string }) => {
				const index = memberships.findIndex(member => member.userId === where.userId);
				if (index === -1) return { affected: 0 };
				memberships.splice(index, 1);
				return { affected: 1 };
			},
			existsBy: async (_entity: unknown, where: Record<string, unknown>) => matching(where).length > 0,
		}),
		chatRoomMembershipsRepository: {
			findBy: async (where: { userId?: string }) => memberships
				.filter(member => where.userId == null || member.userId === where.userId)
				.map(member => ({ ...member, roomId: room.id })),
			findOneBy: async ({ userId }: { userId: string }) => memberships.find(member => member.userId === userId) ?? null,
		},
		chatRoomInvitationsRepository: { findBy: async () => [] },
		chatRosterService: { markRoomDeletedFor: vi.fn(), forgetAccepted: vi.fn() },
		liveKitService: { deleteRoom: async () => undefined, removeParticipant: async () => undefined, identityOf: (user: { id: string }) => user.id },
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		chatEntityService: {
			packMessageLiteFor1on1: async (message: unknown) => message,
			packMessageLiteForRoom: async (message: unknown) => message,
			packMessageDetailed: async (message: unknown) => {
				await noticeGate;
				return message;
			},
		},
		globalEventService: { publishChatUserStream: vi.fn(), publishChatRoomStream: vi.fn(), publishMainStream: main },
		pushNotificationService: { pushNotification: push },
	}) as ChatService;

	const deleteAccountService = Object.assign(Object.create(DeleteAccountService.prototype), {
		meta: { rootUserId: 'root' },
		usersRepository: { findOneByOrFail: async ({ id }: { id: string }) => ({ ...users.find(user => user.id === id)!, username: id }), update: async () => undefined },
		userEntityService: { isLocalUser: () => false },
		queueService: { createDeleteAccountJob: vi.fn() },
		globalEventService: { publishInternalEvent: vi.fn() },
		chatService,
	}) as DeleteAccountService;

	const userMutingService = Object.assign(Object.create(UserMutingService.prototype), {
		mutingsRepository,
		idService: { gen: () => `muting${++nextId}` },
		cacheService: { userMutingsCache: { refresh: async () => undefined } },
		chatService,
	}) as UserMutingService;

	return {
		reader: reader as unknown as MiUser,
		violet: violet as unknown as MiUser,
		amber: amber as unknown as MiUser,
		cobalt: cobalt as unknown as MiUser,
		dahlia: dahlia as unknown as MiUser,
		room: room as unknown as MiChatRoom & { isMutedByOwner: boolean },
		roomPresent: () => roomPresent,
		delivered,
		logger,
		chatService,
		userMutingService,
		deleteAccountService,
		redis: (chatService as unknown as { redisClient: ReturnType<typeof memoryRedis> }).redisClient,
		/** The message as stored, for the calls that take one. */
		stored: (text: string) => messages.find(message => message.text === text) as MiChatMessage,
		mutings: mutings as MiMuting[],
		push,
		memberships,
		messages,
		users,
		/** What the reader's open screens were told, in order. */
		told: (userId = reader.id) => main.mock.calls.filter(([to]) => to === userId).map(([, type]) => type as string),
		accountSent: () => main.mock.calls.filter(([userId, type]) => userId === reader.id && type === 'meUpdated').map(([, , account]) => account as { hasUnreadChatMessages: boolean }),
		/** Holds the delayed notice at the point where it has decided to notify and is preparing what to send. */
		holdNotice: () => {
			let release!: () => void;
			noticeGate = new Promise<void>(resolve => { release = resolve; });
			return release;
		},
	};
}
