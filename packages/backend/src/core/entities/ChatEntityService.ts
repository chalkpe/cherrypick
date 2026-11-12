/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { MiUser, MiDriveFile, ChatMessagesRepository, MiChatMessage, ChatRoomsRepository, MiChatRoom, MiChatRoomInvitation, ChatRoomInvitationsRepository, MiChatRoomMembership, ChatRoomMembershipsRepository, UsersRepository, ChatRoomChannelsRepository } from '@/models/_.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { Packed } from '@/misc/json-schema.js';
import type { } from '@/models/Blocking.js';
import { bindThis } from '@/decorators.js';
import { parseChatDiceResult } from '@/core/chat-dice.js';
import { ChatRoomIconEntityService } from './ChatRoomIconEntityService.js';
import { IdService } from '@/core/IdService.js';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { UserEntityService } from './UserEntityService.js';
import { DriveFileEntityService } from './DriveFileEntityService.js';

@Injectable()
export class ChatEntityService {
	constructor(
		@Inject(DI.chatMessagesRepository)
		private chatMessagesRepository: ChatMessagesRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomInvitationsRepository)
		private chatRoomInvitationsRepository: ChatRoomInvitationsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private userEntityService: UserEntityService,
		private driveFileEntityService: DriveFileEntityService,
		private customEmojiService: CustomEmojiService,
		private idService: IdService,
		private chatRoomNotificationService: ChatRoomNotificationService,
		private chatRoomIconEntityService: ChatRoomIconEntityService,

		@Inject(DI.chatRoomChannelsRepository)
		private chatRoomChannelsRepository: ChatRoomChannelsRepository,
	) {
	}

	private async packMessageChannel(message: MiChatMessage) {
		const channel = message.toRoomChannelId != null ? await this.chatRoomChannelsRepository.findOneBy({ id: message.toRoomChannelId, roomId: message.toRoomId! }) : null;
		return {
			toRoomChannelId: message.toRoomChannelId ?? null,
			toRoomChannel: channel != null ? { id: channel.id, name: channel.name } : null,
			channelRefs: message.deletedAt != null ? [] : (message.channelRefs ?? []).map(({ channelId, start, length }) => ({ channelId, start, length })),
		};
	}

	/** A file can be gone by now, as nothing refers to it by a foreign key. `fileId` and `file` are for clients from before there could be several. */
	private async packMessageFiles(message: MiChatMessage, packedFiles?: Map<MiDriveFile['id'], Packed<'DriveFile'> | null>) {
		let files: Packed<'DriveFile'>[] = [];
		if (message.deletedAt == null) {
			const packed = packedFiles ?? await this.driveFileEntityService.packManyByIdsMap(message.fileIds);
			files = message.fileIds.map(id => packed.get(id)).filter(file => file != null);
		}
		return {
			fileId: files[0]?.id ?? null,
			file: files[0] ?? null,
			fileIds: files.map(file => file.id),
			files,
		};
	}

	@bindThis
	public async packMessageDetailed(
		src: MiChatMessage['id'] | MiChatMessage,
		me?: { id: MiUser['id'] },
		options?: {
			_hint_?: {
				packedFiles?: Map<MiDriveFile['id'], Packed<'DriveFile'> | null>;
				packedUsers?: Map<MiChatMessage['id'], Packed<'UserLite'>>;
				packedRooms?: Map<MiChatMessage['toRoomId'], Packed<'ChatRoom'> | null>;
			};
		},
	): Promise<Packed<'ChatMessage'>> {
		const packedUsers = options?._hint_?.packedUsers;
		const packedFiles = options?._hint_?.packedFiles;
		const packedRooms = options?._hint_?.packedRooms;

		const message = typeof src === 'object' ? src : await this.chatMessagesRepository.findOneByOrFail({ id: src });
		const deleted = message.deletedAt != null;

		// userは削除されている可能性があるのでnull許容
		const reactions: { user: Packed<'UserLite'> | null; reaction: string; }[] = [];

		if (!deleted) {
			for (const record of message.reactions) {
				const [userId, reaction] = record.split('/');
				reactions.push({
					user: packedUsers?.get(userId) ?? (await this.userEntityService.pack(userId).catch(() => null)),
					reaction,
				});
			}
		}

		// Get fromUser host for emoji URL resolution
		const fromUser = message.fromUser ?? await this.usersRepository.findOneBy({ id: message.fromUserId });
		const fromUserHost = fromUser?.host ?? null;

		// Populate emoji URLs - only for remote users, like notes do
		const emojis = !deleted && fromUserHost != null
			? await this.customEmojiService.populateEmojis(message.emojis, fromUserHost)
			: undefined;

		return {
			id: message.id,
			createdAt: this.idService.parse(message.id).date.toISOString(),
			editedAt: message.editedAt?.toISOString() ?? null,
			deletedAt: message.deletedAt?.toISOString() ?? null,
			text: deleted ? null : message.text,
			dice: deleted ? null : parseChatDiceResult(message.dice),
			fromUserId: message.fromUserId,
			fromUser: packedUsers?.get(message.fromUserId) ?? (await this.userEntityService.pack(message.fromUser ?? message.fromUserId, me)),
			toUserId: message.toUserId,
			toUser: message.toUserId ? (packedUsers?.get(message.toUserId) ?? (await this.userEntityService.pack(message.toUser ?? message.toUserId, me))) : undefined,
			toRoomId: message.toRoomId,
			...(await this.packMessageChannel(message)),
			toRoom: message.toRoomId ? (packedRooms?.get(message.toRoomId) ?? (await this.packRoom(message.toRoom ?? message.toRoomId, me))) : undefined,
			...(await this.packMessageFiles(message, packedFiles)),
			reactions: deleted ? [] : reactions.filter((r): r is { user: Packed<'UserLite'>; reaction: string; } => r.user != null),
			emojis: emojis,
		};
	}

	@bindThis
	public async packMessagesDetailed(
		messages: MiChatMessage[],
		me: { id: MiUser['id'] },
	) {
		if (messages.length === 0) return [];

		const excludeMe = (x: MiUser | string) => {
			if (typeof x === 'string') {
				return x !== me.id;
			} else {
				return x.id !== me.id;
			}
		};

		const users = [
			...messages.map((m) => m.fromUser ?? m.fromUserId).filter(excludeMe),
			...messages.map((m) => m.toUser ?? m.toUserId).filter(x => x != null).filter(excludeMe),
		];

		const reactedUserIds = messages.flatMap(x => x.reactions.map(r => r.split('/')[0]));

		for (const reactedUserId of reactedUserIds) {
			if (!users.some(x => typeof x === 'string' ? x === reactedUserId : x.id === reactedUserId)) {
				users.push(reactedUserId);
			}
		}

		// TODO: packedUsersに削除されたユーザーもnullとして含める
		const [packedUsers, packedFiles, packedRooms] = await Promise.all([
			this.userEntityService.packMany(users, me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.driveFileEntityService.packManyByIdsMap(messages.flatMap(m => m.fileIds)),
			this.packRooms(messages.map(m => m.toRoom ?? m.toRoomId).filter(x => x != null), me)
				.then(rooms => new Map(rooms.map(r => [r.id, r]))),
		]);

		return Promise.all(messages.map(message => this.packMessageDetailed(message, me, { _hint_: { packedUsers, packedFiles, packedRooms } })));
	}

	@bindThis
	public async packMessageLiteFor1on1(
		src: MiChatMessage['id'] | MiChatMessage,
		options?: {
			_hint_?: {
				packedFiles: Map<MiDriveFile['id'], Packed<'DriveFile'> | null>;
			};
		},
	): Promise<Packed<'ChatMessageLiteFor1on1'>> {
		const packedFiles = options?._hint_?.packedFiles;

		const message = typeof src === 'object' ? src : await this.chatMessagesRepository.findOneByOrFail({ id: src });
		const deleted = message.deletedAt != null;

		const reactions: { reaction: string; }[] = [];

		if (!deleted) {
			for (const record of message.reactions) {
				const [, reaction] = record.split('/');
				reactions.push({
					reaction,
				});
			}
		}

		// Get fromUser host for emoji URL resolution
		const fromUser = message.fromUser ?? await this.usersRepository.findOneBy({ id: message.fromUserId });
		const fromUserHost = fromUser?.host ?? null;

		// Populate emoji URLs - only for remote users, like notes do
		const emojis = !deleted && fromUserHost != null
			? await this.customEmojiService.populateEmojis(message.emojis, fromUserHost)
			: undefined;

		return {
			id: message.id,
			createdAt: this.idService.parse(message.id).date.toISOString(),
			editedAt: message.editedAt?.toISOString() ?? null,
			deletedAt: message.deletedAt?.toISOString() ?? null,
			text: deleted ? null : message.text,
			dice: deleted ? null : parseChatDiceResult(message.dice),
			fromUserId: message.fromUserId,
			toUserId: message.toUserId!,
			...(await this.packMessageFiles(message, packedFiles)),
			reactions,
			emojis: emojis,
		};
	}

	@bindThis
	public async packMessagesLiteFor1on1(
		messages: MiChatMessage[],
	) {
		if (messages.length === 0) return [];

		const [packedFiles] = await Promise.all([
			this.driveFileEntityService.packManyByIdsMap(messages.flatMap(m => m.fileIds)),
		]);

		return Promise.all(messages.map(message => this.packMessageLiteFor1on1(message, { _hint_: { packedFiles } })));
	}

	@bindThis
	public async packMessageLiteForRoom(
		src: MiChatMessage['id'] | MiChatMessage,
		options?: {
			_hint_?: {
				packedFiles: Map<MiDriveFile['id'], Packed<'DriveFile'> | null>;
				packedUsers: Map<MiUser['id'], Packed<'UserLite'>>;
			};
		},
	): Promise<Packed<'ChatMessageLiteForRoom'>> {
		const packedFiles = options?._hint_?.packedFiles;
		const packedUsers = options?._hint_?.packedUsers;

		const message = typeof src === 'object' ? src : await this.chatMessagesRepository.findOneByOrFail({ id: src });
		const deleted = message.deletedAt != null;

		// userは削除されている可能性があるのでnull許容
		const reactions: { user: Packed<'UserLite'> | null; reaction: string; }[] = [];

		if (!deleted) {
			for (const record of message.reactions) {
				const [userId, reaction] = record.split('/');
				reactions.push({
					user: packedUsers?.get(userId) ?? (await this.userEntityService.pack(userId).catch(() => null)),
					reaction,
				});
			}
		}

		// Get fromUser host for emoji URL resolution
		const fromUser = message.fromUser ?? await this.usersRepository.findOneBy({ id: message.fromUserId });
		const fromUserHost = fromUser?.host ?? null;

		// Populate emoji URLs - only for remote users, like notes do
		const emojis = !deleted && fromUserHost != null
			? await this.customEmojiService.populateEmojis(message.emojis, fromUserHost)
			: undefined;

		return {
			id: message.id,
			createdAt: this.idService.parse(message.id).date.toISOString(),
			editedAt: message.editedAt?.toISOString() ?? null,
			deletedAt: message.deletedAt?.toISOString() ?? null,
			text: deleted ? null : message.text,
			dice: deleted ? null : parseChatDiceResult(message.dice),
			fromUserId: message.fromUserId,
			fromUser: packedUsers?.get(message.fromUserId) ?? (await this.userEntityService.pack(message.fromUser ?? message.fromUserId)),
			toRoomId: message.toRoomId!,
			...(await this.packMessageChannel(message)),
			...(await this.packMessageFiles(message, packedFiles)),
			reactions: deleted ? [] : reactions.filter((r): r is { user: Packed<'UserLite'>; reaction: string; } => r.user != null),
			emojis: emojis,
		};
	}

	@bindThis
	public async packMessagesLiteForRoom(
		messages: MiChatMessage[],
	) {
		if (messages.length === 0) return [];

		const users = messages.map(x => x.fromUser ?? x.fromUserId);
		const reactedUserIds = messages.flatMap(x => x.reactions.map(r => r.split('/')[0]));

		for (const reactedUserId of reactedUserIds) {
			if (!users.some(x => typeof x === 'string' ? x === reactedUserId : x.id === reactedUserId)) {
				users.push(reactedUserId);
			}
		}

		const [packedUsers, packedFiles] = await Promise.all([
			this.userEntityService.packMany(users)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.driveFileEntityService.packManyByIdsMap(messages.flatMap(m => m.fileIds)),
		]);

		return Promise.all(messages.map(message => this.packMessageLiteForRoom(message, { _hint_: { packedFiles, packedUsers } })));
	}

	@bindThis
	public async packRoomIcon(room: MiChatRoom, owner?: Pick<Packed<'UserLite'>, 'host'>) {
		return this.chatRoomIconEntityService.pack(room, false, owner);
	}

	@bindThis
	public async packRoom(
		src: MiChatRoom['id'] | MiChatRoom,
		me?: { id: MiUser['id'] },
		options?: {
			_hint_?: {
				packedOwners: Map<MiChatRoom['id'], Packed<'UserLite'>>;
				myMemberships?: Map<MiChatRoom['id'], MiChatRoomMembership | null | undefined>;
				myInvitations?: Map<MiChatRoom['id'], MiChatRoomInvitation | null | undefined>;
			};
		},
	): Promise<Packed<'ChatRoom'>> {
		const room = typeof src === 'object' ? src : await this.chatRoomsRepository.findOneByOrFail({ id: src });

		const membership = me && me.id !== room.ownerId ? (options?._hint_?.myMemberships?.get(room.id) ?? (await this.chatRoomMembershipsRepository.findOneBy({ roomId: room.id, userId: me.id }))) : null;
		const invitation = me && me.id !== room.ownerId ? (options?._hint_?.myInvitations?.get(room.id) ?? (await this.chatRoomInvitationsRepository.findOneBy({ roomId: room.id, userId: me.id }))) : null;
		const owner = options?._hint_?.packedOwners.get(room.ownerId) ?? (await this.userEntityService.pack(room.owner ?? room.ownerId, me));

		return {
			id: room.id,
			createdAt: this.idService.parse(room.id).date.toISOString(),
			...await this.packRoomIcon(room, owner),
			name: room.name,
			description: room.description,
			ownerId: room.ownerId,
			owner,
			isMuted: me != null ? (await this.chatRoomNotificationService.settings(me.id, room.id)).notificationLevel === 'none' : false,
			...(me != null && (me.id === room.ownerId || membership != null) ? { notificationLevel: (await this.chatRoomNotificationService.settings(me.id, room.id)).notificationLevel } : {}),
			invitationExists: invitation != null,
			isArchived: room.isArchived,
			hasChannels: room.hasChannels ?? false,
			legacyChannelId: me != null && (me.id === room.ownerId || membership != null) ? room.legacyChannelId ?? null : null,
		};
	}

	@bindThis
	public async packRooms(
		rooms: (MiChatRoom | MiChatRoom['id'])[],
		me: { id: MiUser['id'] },
	) {
		if (rooms.length === 0) return [];

		const _rooms = rooms.filter((room): room is MiChatRoom => typeof room !== 'string');
		if (_rooms.length !== rooms.length) {
			_rooms.push(
				...(await this.chatRoomsRepository.find({
					where: {
						id: In(rooms.filter((room): room is string => typeof room === 'string')),
					},
					relations: { owner: true },
				})),
			);
		}

		const owners = _rooms.map(x => x.owner ?? x.ownerId);

		const [packedOwners, myMemberships, myInvitations] = await Promise.all([
			this.userEntityService.packMany(owners, me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.chatRoomMembershipsRepository.find({
				where: {
					roomId: In(_rooms.map(x => x.id)),
					userId: me.id,
				},
			}).then(memberships => new Map(_rooms.map(r => [r.id, memberships.find(m => m.roomId === r.id)]))),
			this.chatRoomInvitationsRepository.find({
				where: {
					roomId: In(_rooms.map(x => x.id)),
					userId: me.id,
				},
			}).then(invitations => new Map(_rooms.map(r => [r.id, invitations.find(i => i.roomId === r.id)]))),
		]);

		return Promise.all(_rooms.map(room => this.packRoom(room, me, { _hint_: { packedOwners, myMemberships, myInvitations } })));
	}

	@bindThis
	public async packRoomInvitation(
		src: MiChatRoomInvitation['id'] | MiChatRoomInvitation,
		me: { id: MiUser['id'] },
		options?: {
			_hint_?: {
				packedRooms: Map<MiChatRoomInvitation['roomId'], Packed<'ChatRoom'>>;
				packedUsers: Map<MiChatRoomInvitation['id'], Packed<'UserLite'>>;
			};
		},
	): Promise<Packed<'ChatRoomInvitation'>> {
		const invitation = typeof src === 'object' ? src : await this.chatRoomInvitationsRepository.findOneByOrFail({ id: src });

		return {
			id: invitation.id,
			createdAt: this.idService.parse(invitation.id).date.toISOString(),
			roomId: invitation.roomId,
			room: options?._hint_?.packedRooms.get(invitation.roomId) ?? (await this.packRoom(invitation.room ?? invitation.roomId, me)),
			userId: invitation.userId,
			user: options?._hint_?.packedUsers.get(invitation.userId) ?? (await this.userEntityService.pack(invitation.user ?? invitation.userId, me)),
		};
	}

	@bindThis
	public async packRoomInvitations(
		invitations: MiChatRoomInvitation[],
		me: { id: MiUser['id'] },
	) {
		if (invitations.length === 0) return [];

		return Promise.all(invitations.map(invitation => this.packRoomInvitation(invitation, me)));
	}

	@bindThis
	public async packRoomMembership(
		src: MiChatRoomMembership['id'] | MiChatRoomMembership,
		me: { id: MiUser['id'] },
		options?: {
			populateUser?: boolean;
			populateRoom?: boolean;
			_hint_?: {
				packedRooms: Map<MiChatRoomMembership['roomId'], Packed<'ChatRoom'>>;
				packedUsers: Map<MiChatRoomMembership['id'], Packed<'UserLite'>>;
			};
		},
	): Promise<Packed<'ChatRoomMembership'>> {
		const membership = typeof src === 'object' ? src : await this.chatRoomMembershipsRepository.findOneByOrFail({ id: src });

		return {
			id: membership.id,
			createdAt: this.idService.parse(membership.id).date.toISOString(),
			userId: membership.userId,
			user: options?.populateUser ? (options._hint_?.packedUsers.get(membership.userId) ?? (await this.userEntityService.pack(membership.user ?? membership.userId, me))) : undefined,
			roomId: membership.roomId,
			room: options?.populateRoom ? (options._hint_?.packedRooms.get(membership.roomId) ?? (await this.packRoom(membership.room ?? membership.roomId, me))) : undefined,
		};
	}

	@bindThis
	public async packRoomMemberships(
		memberships: MiChatRoomMembership[],
		me: { id: MiUser['id'] },
		options: {
			populateUser?: boolean;
			populateRoom?: boolean;
		} = {},
	) {
		if (memberships.length === 0) return [];

		const users = memberships.map(x => x.user ?? x.userId);
		const rooms = memberships.map(x => x.room ?? x.roomId);

		const [packedUsers, packedRooms] = await Promise.all([
			this.userEntityService.packMany(users, me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.packRooms(rooms, me)
				.then(rooms => new Map(rooms.map(r => [r.id, r]))),
		]);

		return Promise.all(memberships.map(membership => this.packRoomMembership(membership, me, { ...options, _hint_: { packedUsers, packedRooms } })));
	}
}
