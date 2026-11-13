/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomChannel } from '@/models/ChatRoomChannel.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import type { ChatRoomChannelsRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { chatRoomUriForOwner } from '@/core/activitypub/misc/chat-payloads.js';
import { ChatChannelError, chatChannelUri, isChatChannelUri, MAX_CHAT_ROOM_CHANNELS, normalizeChatChannelName, validChatChannelRefRanges } from '@/core/chat-room-channels.js';
import type { ChatChannelRef, RemoteChatChannels } from '@/core/chat-room-channels.js';

@Injectable()
export class ChatRoomChannelService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		@Inject(DI.chatRoomChannelsRepository) private channels: ChatRoomChannelsRepository,
		private idService: IdService,
		private fetchInstanceMetadataService: FetchInstanceMetadataService,
	) {}

	public list(roomId: string): Promise<MiChatRoomChannel[]> {
		return this.channels.find({ where: { roomId }, order: { position: 'ASC', id: 'ASC' } });
	}

	public async memberRoom(userId: string, roomId: string): Promise<MiChatRoom> {
		const room = await this.db.manager.findOneBy(MiChatRoom, { id: roomId });
		if (room == null || (room.ownerId !== userId && !await this.db.manager.existsBy(MiChatRoomMembership, { roomId, userId }))) throw new ChatChannelError('NO_SUCH_ROOM');
		return room;
	}

	public pack(channel: MiChatRoomChannel, room: MiChatRoom) {
		return { id: channel.id, roomId: channel.roomId, name: channel.name, isLegacy: channel.id === room.legacyChannelId };
	}

	private async ownerRoom(manager: EntityManager, userId: string, roomId: string): Promise<MiChatRoom> {
		const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
		if (room == null || room.ownerId !== userId || !await manager.existsBy(MiUser, { id: userId, host: IsNull() })) throw new ChatChannelError('NO_SUCH_ROOM');
		const revision = new Date(Math.max(Date.now(), (room.lastRemoteUpdatedAt?.getTime() ?? 0) + 1));
		await manager.update(MiChatRoom, room.id, { lastRemoteUpdatedAt: revision });
		room.lastRemoteUpdatedAt = revision;
		if (room.isArchived) throw new ChatChannelError('ROOM_IS_ARCHIVED');
		return room;
	}

	public async convert(userId: string, roomId: string): Promise<MiChatRoom> {
		return this.db.transaction(async manager => {
			const room = await this.ownerRoom(manager, userId, roomId);
			if (room.hasChannels) throw new ChatChannelError('ALREADY_CONVERTED');
			const channel = manager.create(MiChatRoomChannel, { id: this.idService.gen(), roomId, name: 'general', position: 0, uri: null });
			await manager.insert(MiChatRoomChannel, channel);
			await manager.update(MiChatMessage, { toRoomId: roomId }, { toRoomChannelId: channel.id });
			await manager.update(MiChatRoom, room.id, { hasChannels: true, legacyChannelId: channel.id });
			return { ...room, hasChannels: true, legacyChannelId: channel.id };
		});
	}

	public async create(userId: string, roomId: string, name: string): Promise<MiChatRoomChannel> {
		const normalized = normalizeChatChannelName(name);
		return this.db.transaction(async manager => {
			const room = await this.ownerRoom(manager, userId, roomId);
			if (!room.hasChannels) throw new ChatChannelError('NO_SUCH_CHANNEL');
			const channels = await manager.findBy(MiChatRoomChannel, { roomId });
			if (channels.length >= MAX_CHAT_ROOM_CHANNELS) throw new ChatChannelError('TOO_MANY_CHANNELS');
			const channel = manager.create(MiChatRoomChannel, { id: this.idService.gen(), roomId, name: normalized, position: Math.max(-1, ...channels.map(c => c.position)) + 1, uri: null });
			await manager.insert(MiChatRoomChannel, channel);
			return channel;
		});
	}

	private async channelRoomId(channelId: string): Promise<string> {
		const channel = await this.channels.findOneBy({ id: channelId });
		if (channel == null) throw new ChatChannelError('NO_SUCH_ROOM');
		return channel.roomId;
	}

	public async rename(userId: string, channelId: string, name: string): Promise<MiChatRoomChannel> {
		const normalized = normalizeChatChannelName(name);
		const roomId = await this.channelRoomId(channelId);
		return this.db.transaction(async manager => {
			await this.ownerRoom(manager, userId, roomId);
			const channel = await manager.findOneBy(MiChatRoomChannel, { id: channelId, roomId });
			if (channel == null) throw new ChatChannelError('NO_SUCH_CHANNEL');
			await manager.update(MiChatRoomChannel, channel.id, { name: normalized });
			return { ...channel, name: normalized };
		});
	}

	public async reorder(userId: string, roomId: string, channelIds: string[]): Promise<MiChatRoomChannel[]> {
		return this.db.transaction(async manager => {
			await this.ownerRoom(manager, userId, roomId);
			const channels = await manager.findBy(MiChatRoomChannel, { roomId });
			if (channels.length === 0 || channelIds.length !== channels.length || new Set(channelIds).size !== channels.length || channelIds.some(id => !channels.some(c => c.id === id))) throw new ChatChannelError('INVALID_CHANNEL_ORDER');
			const ordered = channelIds.map((id, position) => ({ ...channels.find(c => c.id === id)!, position }));
			for (const channel of ordered) await manager.update(MiChatRoomChannel, channel.id, { position: channel.position });
			return ordered;
		});
	}

	public async delete(userId: string, channelId: string): Promise<string> {
		const roomId = await this.channelRoomId(channelId);
		return this.db.transaction(async manager => {
			await this.ownerRoom(manager, userId, roomId);
			if (!await manager.existsBy(MiChatRoomChannel, { id: channelId, roomId })) throw new ChatChannelError('NO_SUCH_CHANNEL');
			if (await manager.countBy(MiChatRoomChannel, { roomId }) <= 1) throw new ChatChannelError('LAST_CHANNEL');
			// 메시지만 CASCADE로 지우며 드라이브 파일과 다른 메시지의 참조 JSON은 보존한다.
			await manager.delete(MiChatRoomChannel, { id: channelId, roomId });
			return roomId;
		});
	}

	public async resolve(room: MiChatRoom, channelId?: string | null, manager = this.db.manager): Promise<string | null> {
		if (!room.hasChannels) {
			if (channelId != null) throw new ChatChannelError('NO_SUCH_CHANNEL');
			return null;
		}
		const id = channelId ?? room.legacyChannelId;
		if (id == null || !await manager.existsBy(MiChatRoomChannel, { id, roomId: room.id })) throw new ChatChannelError('NO_SUCH_CHANNEL');
		return id;
	}

	public async localRefs(room: MiChatRoom, text: string, refs: ChatChannelRef[], manager = this.db.manager, previous?: Pick<MiChatMessage, 'text' | 'channelRefs'>): Promise<ChatChannelRef[]> {
		if (refs.length === 0) return [];
		refs = refs.map(ref => ({ ...ref, start: ref.start - (text.length - text.trimStart().length) }));
		text = text.trim();
		if (!room.hasChannels || !validChatChannelRefRanges(refs, text)) throw new ChatChannelError('INVALID_CHANNEL_REFS');
		const channels = await manager.findBy(MiChatRoomChannel, { roomId: room.id, id: In(refs.map(r => r.channelId)) });
		const roomUri = await this.roomUri(room, manager);
		const oldRefs = [...(previous?.channelRefs ?? [])];
		return refs.map(ref => {
			const channel = channels.find(c => c.id === ref.channelId);
			if (channel != null) return { channelId: channel.id, start: ref.start, length: ref.length, uri: channel.uri ?? chatChannelUri(roomUri, channel.id) };
			const previousText = previous?.text ?? '';
			const oldIndex = oldRefs.findIndex(old => old.channelId === ref.channelId && old.length === ref.length &&
				previousText.slice(old.start, old.start + old.length) === text.slice(ref.start, ref.start + ref.length));
			if (oldIndex < 0) throw new ChatChannelError('INVALID_CHANNEL_REFS');
			const [old] = oldRefs.splice(oldIndex, 1);
			return { channelId: ref.channelId, start: ref.start, length: ref.length, uri: old.uri };
		});
	}

	public async remoteRefs(room: MiChatRoom, text: string, value: unknown, manager = this.db.manager): Promise<ChatChannelRef[]> {
		if (!room.hasChannels || !Array.isArray(value)) return [];
		if (value.some(ref => ref == null || typeof ref !== 'object') || !validChatChannelRefRanges(value, text)) return [];
		const refs = value.map(ref => ({ ...ref, start: ref.start - (text.length - text.trimStart().length) }));
		text = text.trim();
		if (!validChatChannelRefRanges(refs, text)) return [];
		const roomUri = await this.roomUri(room, manager);
		if (refs.some(ref => !isChatChannelUri(roomUri, ref.id))) return [];
		const channels = await manager.findBy(MiChatRoomChannel, { roomId: room.id });
		return refs.flatMap(ref => {
			const channel = channels.find(c => (c.uri ?? chatChannelUri(roomUri, c.id)) === ref.id);
			return channel != null ? [{ channelId: channel.id, start: ref.start, length: ref.length, uri: ref.id }] : [];
		});
	}

	public async roomUri(room: MiChatRoom, manager = this.db.manager): Promise<string> {
		return chatRoomUriForOwner(room, await manager.findOneBy(MiUser, { id: room.ownerId }), this.config.url);
	}

	public async remoteChannel(room: MiChatRoom, value: unknown): Promise<string | null | undefined> {
		if (value == null) return this.resolve(room);
		const roomUri = await this.roomUri(room);
		if (!isChatChannelUri(roomUri, value)) throw new ChatChannelError('NO_SUCH_CHANNEL');
		const channel = (await this.list(room.id)).find(c => (c.uri ?? chatChannelUri(roomUri, c.id)) === value);
		return channel?.id;
	}

	public async federatedFields(room: MiChatRoom, manager = this.db.manager) {
		if (!room.hasChannels) return {};
		const roomUri = await this.roomUri(room, manager);
		const channels = (await manager.find(MiChatRoomChannel, { where: { roomId: room.id }, order: { position: 'ASC', id: 'ASC' } })).map(c => ({ id: c.uri ?? chatChannelUri(roomUri, c.id), name: c.name }));
		const legacy = await manager.findOneBy(MiChatRoomChannel, { id: room.legacyChannelId ?? '', roomId: room.id });
		return { _misskey_chatChannels: channels, _misskey_chatLegacyChannel: legacy != null ? legacy.uri ?? chatChannelUri(roomUri, legacy.id) : null };
	}

	public async snapshot(roomId: string) {
		return this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_read' } });
			return room != null ? { room, fields: await this.federatedFields(room, manager) } : null;
		});
	}

	public async messageFields(message: Pick<MiChatMessage, 'toRoomChannelId' | 'channelRefs'>) {
		if (message.toRoomChannelId == null) return {};
		const channel = await this.channels.findOneBy({ id: message.toRoomChannelId });
		if (channel == null) return {};
		const room = await this.db.manager.findOneByOrFail(MiChatRoom, { id: channel.roomId });
		return {
			channelUri: channel.uri ?? chatChannelUri(await this.roomUri(room), channel.id),
			channelRefs: (message.channelRefs ?? []).filter(ref => ref.uri != null).map(ref => ({ id: ref.uri!, start: ref.start, length: ref.length })),
		};
	}

	public async deliverableTo(host: string | null, message: Pick<MiChatMessage, 'toRoomChannelId'>, room: MiChatRoom): Promise<boolean | null> {
		if (!room.hasChannels || host == null) return true;
		if (message.toRoomChannelId != null && message.toRoomChannelId === room.legacyChannelId) return true;
		return this.fetchInstanceMetadataService.chatRoomChannelsCapability(host);
	}

	// 호출자는 소유자와 revision을 확인하고 그룹 행을 잠근 동일 트랜잭션을 전달한다.
	public async applyRemote(manager: EntityManager, room: MiChatRoom, snapshot: RemoteChatChannels): Promise<MiChatRoom> {
		const previous = await manager.findBy(MiChatRoomChannel, { roomId: room.id });
		const channels: MiChatRoomChannel[] = [];
		for (const [position, remote] of snapshot.channels.entries()) {
			const known = previous.find(c => c.uri === remote.id);
			const channel = manager.create(MiChatRoomChannel, { id: known?.id ?? this.idService.gen(), roomId: room.id, uri: remote.id, name: remote.name, position });
			await manager.save(MiChatRoomChannel, channel);
			channels.push(channel);
		}
		const legacyChannelId = channels.find(c => c.uri === snapshot.legacyChannel)?.id ?? null;
		if (!room.hasChannels) {
			if (legacyChannelId != null) await manager.update(MiChatMessage, { toRoomId: room.id }, { toRoomChannelId: legacyChannelId });
			else await manager.delete(MiChatMessage, { toRoomId: room.id });
		}
		await manager.update(MiChatRoom, room.id, { hasChannels: true, legacyChannelId });
		for (const channel of previous) {
			if (!channels.some(c => c.id === channel.id)) await manager.delete(MiChatRoomChannel, channel.id);
		}
		return { ...room, hasChannels: true, legacyChannelId };
	}
}
