/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiUser, MiDriveFile, ChatMessagesRepository, MiChatMessage, ChatRoomsRepository, MiChatRoom, MiChatRoomInvitation, ChatRoomInvitationsRepository, MiChatRoomMembership, ChatRoomMembershipsRepository, MiChatRoomBan, UsersRepository, ChatRoomChannelsRepository } from '@/models/_.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { Packed } from '@/misc/json-schema.js';
import type { } from '@/models/Blocking.js';
import { bindThis } from '@/decorators.js';
import { parseChatDiceResult } from '@/core/chat-dice.js';
import { chatReplyPreviewText, findReplyTargetsByUri, isReplyTargetInConversation, isReplyTargetInScope } from '@/core/chat-reply.js';
import type { ChatReplyScope } from '@/core/chat-reply.js';
import { canReadRoomTimeline } from '@/core/chat-room-access.js';
import { ChatRoomIconEntityService } from './ChatRoomIconEntityService.js';
import { IdService } from '@/core/IdService.js';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserEntityService } from './UserEntityService.js';
import { DriveFileEntityService } from './DriveFileEntityService.js';

/** 묶음 포장에서 답장 원문을 한 번에 읽어 둔 결과 */
type ReplyHints = {
	targets: Map<MiChatMessage['id'], MiChatMessage | null>;
	authors: Map<MiUser['id'], MiUser>;
	/** 보는 사람이 지금 접근할 수 있는 그룹. 보는 사람이 없으면 null(확인하지 않음). */
	readableRooms: Set<MiChatRoom['id']> | null;
};

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
		private roleService: RoleService,

		@Inject(DI.chatRoomChannelsRepository)
		private chatRoomChannelsRepository: ChatRoomChannelsRepository,

		@Inject(DI.config)
		private config: Config,
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

	/**
	 * 그룹 메시지의 작성자 계정이 없어졌거나 지워졌으면 과거 기록용 작성자 정보만 내준다. 계정이 아니므로 fromUser는 null이다.
	 * 일대일 메시지는 계정과 함께 지워지므로 해당하지 않는다.
	 */
	private archivedAuthorOf(message: MiChatMessage, fromUser: MiUser | null): { name: string | null; username: string | null; host: string | null } | null {
		if (message.toRoomId == null) return null;
		if (fromUser == null) {
			const archived = message.archivedAuthor;
			return archived != null && (archived.name != null || archived.username != null) ? { name: archived.name, username: archived.username, host: archived.host } : null;
		}
		return fromUser.isDeleted ? { name: fromUser.name, username: fromUser.username, host: fromUser.host } : null;
	}

	private hasArchivedAuthor(message: MiChatMessage, fromUser: MiUser | null): boolean {
		return message.toRoomId != null && (fromUser == null || fromUser.isDeleted);
	}

	private replyScopeOf(message: MiChatMessage): ChatReplyScope | null {
		if (message.toRoomId != null) return { kind: 'room', roomId: message.toRoomId, channelId: message.toRoomChannelId ?? null };
		return message.fromUserId != null && message.toUserId != null ? { kind: 'user', userIds: [message.fromUserId, message.toUserId] } : null;
	}

	/**
	 * 묶음으로 포장할 글들의 원문, 원문 작성자, 보는 사람의 그룹 접근 여부를 한꺼번에 읽는다.
	 * 글마다 따로 조회하지 않게 하며, 연합으로 받아 id를 모르는 답장만 주소로 다시 찾는다.
	 */
	private async loadReplyHints(messages: MiChatMessage[], me?: { id: MiUser['id'] }): Promise<ReplyHints> {
		const pending = messages.filter(m => m.deletedAt == null && (m.replyToId != null || m.replyToUri != null));
		const hints: ReplyHints = { targets: new Map(), authors: new Map(), readableRooms: me != null ? new Set() : null };
		if (pending.length === 0) return hints;

		const ids = [...new Set(pending.map(m => m.replyToId).filter((x): x is string => x != null))];
		const byId = ids.length > 0 ? await this.chatMessagesRepository.findBy({ id: In(ids) }) : [];
		const idMap = new Map(byId.map(t => [t.id, t]));

		// 연합으로 받아 id를 모르는 답장은 주소로 한꺼번에 다시 찾는다.
		const byAddress = await findReplyTargetsByUri(this.chatMessagesRepository, pending.flatMap(m => {
			const scope = m.replyToId == null ? this.replyScopeOf(m) : null;
			return scope != null ? [{ key: m.id, uri: m.replyToUri!, scope }] : [];
		}), this.config.url);

		for (const message of pending) {
			hints.targets.set(message.id, message.replyToId != null ? idMap.get(message.replyToId) ?? null : byAddress.get(message.id) ?? null);
		}

		const authorIds = [...new Set([...hints.targets.values()].map(t => t?.fromUserId).filter((x): x is string => x != null))];
		if (authorIds.length > 0) {
			hints.authors = new Map((await this.usersRepository.findBy({ id: In(authorIds) })).map(u => [u.id, u]));
		}

		if (me != null && hints.readableRooms != null) {
			const roomIds = [...new Set(pending.map(m => m.toRoomId).filter((x): x is string => x != null))];
			if (roomIds.length > 0) {
				const [memberships, rooms] = await Promise.all([
					this.chatRoomMembershipsRepository.findBy({ userId: me.id, roomId: In(roomIds) }),
					this.chatRoomsRepository.findBy({ id: In(roomIds) }),
				]);
				// 접근 기준은 그룹 타임라인 읽기 권한과 같은 함수를 쓴다.
				const memberRoomIds = new Set(memberships.map(m => m.roomId));
				for (const room of rooms) if (canReadRoomTimeline(room, me.id, memberRoomIds, false)) hints.readableRooms.add(room.id);
				if (hints.readableRooms.size < roomIds.length && await this.roleService.isModerator(me)) {
					for (const room of rooms) if (canReadRoomTimeline(room, me.id, memberRoomIds, true)) hints.readableRooms.add(room.id);
				}
			}
		}

		return hints;
	}

	/**
	 * 답장 말풍선에 싣는 원문 미리보기. 저장된 원문 기록에서만 만들고, 지워졌거나 같은 대화가 아니면 내용 없이 지워진 것으로 알린다.
	 * 원문 작성자 정지 여부는 목록 조회가 이미 숨기는 규칙과 같게 보고, 보는 사람이 지금 그룹에 접근할 수 없으면 원문 내용을 내주지 않는다.
	 */
	private async packReply(message: MiChatMessage, me: { id: MiUser['id'] } | undefined, withAuthor: boolean, hints: ReplyHints, packedUsers?: Map<MiUser['id'], Packed<'UserLite'>>) {
		if ((message.replyToId == null && message.replyToUri == null) || message.deletedAt != null) return { replyToId: null, reply: null };
		const scope = this.replyScopeOf(message);
		// 연합으로 받아 원문 id를 아직 모르는 답장은 저장된 글에서 주소로 다시 찾는다. 아직 없으면 인용 없이 보인다.
		const target = hints.targets.get(message.id) ?? null;
		if (message.replyToId == null && (target == null || scope == null || !isReplyTargetInConversation(target, scope))) return { replyToId: null, reply: null };
		const replyToId = target?.id ?? message.replyToId!;
		const unavailable = { replyToId, reply: { id: replyToId, isDeleted: true, text: null, fileCount: 0, fromUserId: null, fromUser: null, archivedAuthor: null } };

		if (target == null || scope == null || !isReplyTargetInScope(target, scope)) return unavailable;
		if (message.toRoomId != null && hints.readableRooms != null && !hints.readableRooms.has(message.toRoomId)) return unavailable;

		const author = target.fromUserId != null ? hints.authors.get(target.fromUserId) ?? null : null;
		if (author?.isSuspended) return unavailable;

		return {
			replyToId,
			reply: {
				id: target.id,
				isDeleted: false,
				text: chatReplyPreviewText(target.text),
				fileCount: target.fileIds.length + (target.unavailableFileCount ?? 0),
				fromUserId: target.fromUserId,
				fromUser: withAuthor && !this.hasArchivedAuthor(target, author) ? packedUsers?.get(target.fromUserId!) ?? await this.userEntityService.pack(author ?? target.fromUserId!, me) : null,
				archivedAuthor: this.archivedAuthorOf(target, author),
			},
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
				replyHints?: ReplyHints;
			};
			/** 알림처럼 원문 미리보기를 쓰지 않는 용도에서는 답장 정보를 싣지 않는다. */
			omitReply?: boolean;
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
		const fromUser = message.fromUser ?? (message.fromUserId != null ? await this.usersRepository.findOneBy({ id: message.fromUserId }) : null);
		const fromUserHost = fromUser?.host ?? message.archivedAuthor?.host ?? null;

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
			fromUser: this.hasArchivedAuthor(message, fromUser) ? null : packedUsers?.get(message.fromUserId!) ?? (await this.userEntityService.pack(fromUser ?? message.fromUserId!, me)),
			archivedAuthor: this.archivedAuthorOf(message, fromUser),
			unavailableFileCount: message.unavailableFileCount ?? 0,
			toUserId: message.toUserId,
			toUser: message.toUserId ? (packedUsers?.get(message.toUserId) ?? (await this.userEntityService.pack(message.toUser ?? message.toUserId, me))) : undefined,
			toRoomId: message.toRoomId,
			...(await this.packMessageChannel(message)),
			...(options?.omitReply ? {} : await this.packReply(message, me, true, options?._hint_?.replyHints ?? await this.loadReplyHints([message], me), packedUsers)),
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
			...messages.map((m) => m.fromUser ?? m.fromUserId).filter(x => x != null).filter(excludeMe),
			...messages.map((m) => m.toUser ?? m.toUserId).filter(x => x != null).filter(excludeMe),
		];

		const reactedUserIds = messages.flatMap(x => x.reactions.map(r => r.split('/')[0]));

		for (const reactedUserId of reactedUserIds) {
			if (!users.some(x => typeof x === 'string' ? x === reactedUserId : x.id === reactedUserId)) {
				users.push(reactedUserId);
			}
		}

		const replyHints = await this.loadReplyHints(messages, me);
		for (const authorId of replyHints.authors.keys()) {
			if (authorId !== me.id && !users.some(x => typeof x === 'string' ? x === authorId : x.id === authorId)) users.push(authorId);
		}

		// TODO: packedUsersに削除されたユーザーもnullとして含める
		const [packedUsers, packedFiles, packedRooms] = await Promise.all([
			this.userEntityService.packMany(users, me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.driveFileEntityService.packManyByIdsMap(messages.flatMap(m => m.fileIds)),
			this.packRooms(messages.map(m => m.toRoom ?? m.toRoomId).filter(x => x != null), me)
				.then(rooms => new Map(rooms.map(r => [r.id, r]))),
		]);

		return Promise.all(messages.map(message => this.packMessageDetailed(message, me, { _hint_: { packedUsers, packedFiles, packedRooms, replyHints } })));
	}

	@bindThis
	public async packMessageLiteFor1on1(
		src: MiChatMessage['id'] | MiChatMessage,
		options?: {
			_hint_?: {
				packedFiles: Map<MiDriveFile['id'], Packed<'DriveFile'> | null>;
				replyHints?: ReplyHints;
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
		// 일대일 메시지는 작성자 계정과 함께 지워지므로 작성자가 항상 있다
		const fromUser = message.fromUser ?? await this.usersRepository.findOneBy({ id: message.fromUserId! });
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
			fromUserId: message.fromUserId!,
			toUserId: message.toUserId!,
			...(await this.packReply(message, undefined, false, options?._hint_?.replyHints ?? await this.loadReplyHints([message]))),
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

		const [packedFiles, replyHints] = await Promise.all([
			this.driveFileEntityService.packManyByIdsMap(messages.flatMap(m => m.fileIds)),
			this.loadReplyHints(messages),
		]);

		return Promise.all(messages.map(message => this.packMessageLiteFor1on1(message, { _hint_: { packedFiles, replyHints } })));
	}

	@bindThis
	public async packMessageLiteForRoom(
		src: MiChatMessage['id'] | MiChatMessage,
		options?: {
			_hint_?: {
				packedFiles: Map<MiDriveFile['id'], Packed<'DriveFile'> | null>;
				packedUsers: Map<MiUser['id'], Packed<'UserLite'>>;
				replyHints?: ReplyHints;
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
		const fromUser = message.fromUser ?? (message.fromUserId != null ? await this.usersRepository.findOneBy({ id: message.fromUserId }) : null);
		const fromUserHost = fromUser?.host ?? message.archivedAuthor?.host ?? null;

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
			fromUser: this.hasArchivedAuthor(message, fromUser) ? null : packedUsers?.get(message.fromUserId!) ?? (await this.userEntityService.pack(fromUser ?? message.fromUserId!)),
			archivedAuthor: this.archivedAuthorOf(message, fromUser),
			unavailableFileCount: message.unavailableFileCount ?? 0,
			toRoomId: message.toRoomId!,
			...(await this.packMessageChannel(message)),
			...(await this.packReply(message, undefined, true, options?._hint_?.replyHints ?? await this.loadReplyHints([message]), packedUsers)),
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

		const users = messages.map(x => x.fromUser ?? x.fromUserId).filter(x => x != null);
		const reactedUserIds = messages.flatMap(x => x.reactions.map(r => r.split('/')[0]));

		for (const reactedUserId of reactedUserIds) {
			if (!users.some(x => typeof x === 'string' ? x === reactedUserId : x.id === reactedUserId)) {
				users.push(reactedUserId);
			}
		}

		const replyHints = await this.loadReplyHints(messages);
		for (const authorId of replyHints.authors.keys()) {
			if (!users.some(x => typeof x === 'string' ? x === authorId : x.id === authorId)) users.push(authorId);
		}

		const [packedUsers, packedFiles] = await Promise.all([
			this.userEntityService.packMany(users)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.driveFileEntityService.packManyByIdsMap(messages.flatMap(m => m.fileIds)),
		]);

		return Promise.all(messages.map(message => this.packMessageLiteForRoom(message, { _hint_: { packedFiles, packedUsers, replyHints } })));
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
			allowRecording: room.allowRecording,
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

	@bindThis
	public async packRoomBans(
		bans: MiChatRoomBan[],
		me: { id: MiUser['id'] },
	): Promise<Packed<'ChatRoomBan'>[]> {
		if (bans.length === 0) return [];

		const packedUsers = new Map((await this.userEntityService.packMany(bans.map(ban => ban.user ?? ban.userId), me)).map(user => [user.id, user]));

		return bans.flatMap(ban => {
			const user = packedUsers.get(ban.userId);
			// 그 사이 삭제된 계정은 금지 기록도 함께 지워진다.
			if (user == null) return [];
			return [{
				id: ban.id,
				createdAt: this.idService.parse(ban.id).date.toISOString(),
				roomId: ban.roomId,
				userId: ban.userId,
				user,
			}];
		});
	}
}
