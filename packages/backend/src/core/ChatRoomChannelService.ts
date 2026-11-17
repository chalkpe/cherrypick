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
import { MiChatRoomChannelSection } from '@/models/ChatRoomChannelSection.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import type { ChatRoomChannelsRepository, ChatRoomChannelSectionsRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { QueueService } from '@/core/QueueService.js';
import type { IActivity } from '@/core/activitypub/type.js';
import type { ThinUser } from '@/queue/types.js';
import { chatRoomUriForOwner } from '@/core/activitypub/misc/chat-payloads.js';
import { ChatChannelError, chatChannelDisplayOrder, chatChannelUri, chatSectionUri, isChatChannelUri, MAX_CHAT_ROOM_CHANNELS, MAX_CHAT_ROOM_SECTIONS, normalizeChatChannelName, normalizeChatSectionName, validChatChannelRefRanges } from '@/core/chat-room-channels.js';
import type { ChatChannelRef, RemoteChatChannels, RemoteChatChannelSection } from '@/core/chat-room-channels.js';

@Injectable()
export class ChatRoomChannelService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.config) private config: Config,
		@Inject(DI.chatRoomChannelsRepository) private channels: ChatRoomChannelsRepository,
		@Inject(DI.chatRoomChannelSectionsRepository) private sections: ChatRoomChannelSectionsRepository,
		private idService: IdService,
		private fetchInstanceMetadataService: FetchInstanceMetadataService,
		private queueService: QueueService,
	) {}

	public list(roomId: string): Promise<MiChatRoomChannel[]> {
		return this.channels.find({ where: { roomId }, order: { position: 'ASC', id: 'ASC' } });
	}

	public listSections(roomId: string): Promise<MiChatRoomChannelSection[]> {
		return this.sections.find({ where: { roomId }, order: { position: 'ASC', id: 'ASC' } });
	}

	public async memberRoom(userId: string, roomId: string): Promise<MiChatRoom> {
		const room = await this.db.manager.findOneBy(MiChatRoom, { id: roomId });
		if (room == null || (room.ownerId !== userId && !await this.db.manager.existsBy(MiChatRoomMembership, { roomId, userId }))) throw new ChatChannelError('NO_SUCH_ROOM');
		return room;
	}

	public pack(channel: MiChatRoomChannel, room: MiChatRoom) {
		return { id: channel.id, roomId: channel.roomId, name: channel.name, isLegacy: channel.id === room.legacyChannelId, sectionId: channel.sectionId };
	}

	public packSection(section: MiChatRoomChannelSection) {
		return { id: section.id, roomId: section.roomId, name: section.name };
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

	public async create(userId: string, roomId: string, name: string, sectionId?: string | null): Promise<MiChatRoomChannel> {
		const normalized = normalizeChatChannelName(name);
		return this.db.transaction(async manager => {
			const room = await this.ownerRoom(manager, userId, roomId);
			if (!room.hasChannels) throw new ChatChannelError('NO_SUCH_CHANNEL');
			const channels = await manager.findBy(MiChatRoomChannel, { roomId });
			if (channels.length >= MAX_CHAT_ROOM_CHANNELS) throw new ChatChannelError('TOO_MANY_CHANNELS');
			if (sectionId != null && !await manager.existsBy(MiChatRoomChannelSection, { id: sectionId, roomId })) throw new ChatChannelError('NO_SUCH_SECTION');
			const channel = manager.create(MiChatRoomChannel, { id: this.idService.gen(), roomId, name: normalized, position: Math.max(-1, ...channels.map(c => c.position)) + 1, uri: null, sectionId: sectionId ?? null });
			await manager.insert(MiChatRoomChannel, channel);
			// 새 채널은 소속(섹션 또는 섹션 없음) 묶음의 맨 아래에 놓이도록 화면 순서로 다시 매긴다.
			const renumbered = await this.renumberChannels(manager, roomId);
			return renumbered.find(c => c.id === channel.id) ?? channel;
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
			// 받은 순서는 소속을 바꾸지 않고 소속별 상대 순서로만 적용한다. 섹션을 모르는 화면이 불러도 섹션이 깨지지 않는다.
			const rank = new Map(channelIds.map((id, index) => [id, index]));
			const sections = await manager.find(MiChatRoomChannelSection, { where: { roomId }, order: { position: 'ASC', id: 'ASC' } });
			const ranked = [...channels].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
			return this.applyDisplayOrder(manager, chatChannelDisplayOrder(ranked, sections.map(section => section.id)));
		});
	}

	public async arrange(userId: string, roomId: string, ungrouped: string[], sectionOrders: { sectionId: string; channelIds: string[] }[]): Promise<MiChatRoomChannel[]> {
		return this.db.transaction(async manager => {
			await this.ownerRoom(manager, userId, roomId);
			const channels = await manager.findBy(MiChatRoomChannel, { roomId });
			const sections = await manager.findBy(MiChatRoomChannelSection, { roomId });
			const allChannelIds = [...ungrouped, ...sectionOrders.flatMap(order => order.channelIds)];
			const allSectionIds = sectionOrders.map(order => order.sectionId);
			if (channels.length === 0 || allChannelIds.length !== channels.length || new Set(allChannelIds).size !== channels.length || allChannelIds.some(id => !channels.some(c => c.id === id)) ||
				allSectionIds.length !== sections.length || new Set(allSectionIds).size !== sections.length || allSectionIds.some(id => !sections.some(s => s.id === id))) throw new ChatChannelError('INVALID_CHANNEL_ORDER');
			const byId = new Map(channels.map(channel => [channel.id, channel]));
			const ordered = [
				...ungrouped.map(id => ({ ...byId.get(id)!, sectionId: null })),
				...sectionOrders.flatMap(order => order.channelIds.map(id => ({ ...byId.get(id)!, sectionId: order.sectionId }))),
			];
			for (const [position, order] of sectionOrders.entries()) await manager.update(MiChatRoomChannelSection, order.sectionId, { position });
			for (const channel of ordered) {
				if (byId.get(channel.id)!.sectionId !== channel.sectionId) await manager.update(MiChatRoomChannel, channel.id, { sectionId: channel.sectionId });
			}
			return this.applyDisplayOrder(manager, ordered);
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

	public async createSection(userId: string, roomId: string, name: string): Promise<MiChatRoomChannelSection> {
		const normalized = normalizeChatSectionName(name);
		return this.db.transaction(async manager => {
			const room = await this.ownerRoom(manager, userId, roomId);
			if (!room.hasChannels) throw new ChatChannelError('NO_SUCH_SECTION');
			const sections = await manager.findBy(MiChatRoomChannelSection, { roomId });
			if (sections.length >= MAX_CHAT_ROOM_SECTIONS) throw new ChatChannelError('TOO_MANY_SECTIONS');
			const section = manager.create(MiChatRoomChannelSection, { id: this.idService.gen(), roomId, name: normalized, position: Math.max(-1, ...sections.map(s => s.position)) + 1, uri: null });
			await manager.insert(MiChatRoomChannelSection, section);
			return section;
		});
	}

	private async sectionRoomId(sectionId: string): Promise<string> {
		const section = await this.sections.findOneBy({ id: sectionId });
		if (section == null) throw new ChatChannelError('NO_SUCH_SECTION');
		return section.roomId;
	}

	public async renameSection(userId: string, sectionId: string, name: string): Promise<MiChatRoomChannelSection> {
		const normalized = normalizeChatSectionName(name);
		const roomId = await this.sectionRoomId(sectionId);
		return this.db.transaction(async manager => {
			await this.ownerRoom(manager, userId, roomId);
			const section = await manager.findOneBy(MiChatRoomChannelSection, { id: sectionId, roomId });
			if (section == null) throw new ChatChannelError('NO_SUCH_SECTION');
			await manager.update(MiChatRoomChannelSection, section.id, { name: normalized });
			return { ...section, name: normalized };
		});
	}

	public async deleteSection(userId: string, sectionId: string): Promise<string> {
		const roomId = await this.sectionRoomId(sectionId);
		return this.db.transaction(async manager => {
			await this.ownerRoom(manager, userId, roomId);
			if (!await manager.existsBy(MiChatRoomChannelSection, { id: sectionId, roomId })) throw new ChatChannelError('NO_SUCH_SECTION');
			// 안의 채널은 섹션 없는 채널로 남긴다. 섹션에 속한 채널은 늘 섹션 없는 채널보다 아래에 있으므로
			// 풀려난 채널은 position 순서대로 섹션 없는 채널 묶음의 맨 아래에 놓인다.
			await manager.update(MiChatRoomChannel, { sectionId }, { sectionId: null });
			await manager.delete(MiChatRoomChannelSection, { id: sectionId, roomId });
			await this.renumberChannels(manager, roomId);
			return roomId;
		});
	}

	// 화면 순서(섹션 없는 채널 → 섹션 순서대로)대로 채널 position을 다시 매긴다.
	private async applyDisplayOrder(manager: EntityManager, ordered: MiChatRoomChannel[]): Promise<MiChatRoomChannel[]> {
		const channels = ordered.map((channel, position) => ({ ...channel, position }));
		for (const channel of channels) await manager.update(MiChatRoomChannel, channel.id, { position: channel.position });
		return channels;
	}

	private async renumberChannels(manager: EntityManager, roomId: string): Promise<MiChatRoomChannel[]> {
		const channels = await manager.find(MiChatRoomChannel, { where: { roomId }, order: { position: 'ASC', id: 'ASC' } });
		const sections = await manager.find(MiChatRoomChannelSection, { where: { roomId }, order: { position: 'ASC', id: 'ASC' } });
		return this.applyDisplayOrder(manager, chatChannelDisplayOrder(channels, sections.map(section => section.id)));
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
		return refs.map(ref => {
			const channel = channels.find(c => (c.uri ?? chatChannelUri(roomUri, c.id)) === ref.id);
			// 채널 행이 삭제되었어도 같은 그룹의 유효한 URI면 삭제된 대상으로 참조를 보존한다.
			const channelId = channel?.id ?? ref.id.slice(`${roomUri}/channels/`.length);
			return { channelId, start: ref.start, length: ref.length, uri: ref.id };
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
		const channels = await manager.find(MiChatRoomChannel, { where: { roomId: room.id }, order: { position: 'ASC', id: 'ASC' } });
		const sections = await manager.find(MiChatRoomChannelSection, { where: { roomId: room.id }, order: { position: 'ASC', id: 'ASC' } });
		const legacy = await manager.findOneBy(MiChatRoomChannel, { id: room.legacyChannelId ?? '', roomId: room.id });
		return {
			_misskey_chatChannels: channels.map(c => ({ id: c.uri ?? chatChannelUri(roomUri, c.id), name: c.name })),
			_misskey_chatLegacyChannel: legacy != null ? legacy.uri ?? chatChannelUri(roomUri, legacy.id) : null,
			_misskey_chatChannelSections: sections.map(section => ({
				id: section.uri ?? chatSectionUri(roomUri, section.id),
				name: section.name,
				channels: channels.filter(c => c.sectionId === section.id).map(c => c.uri ?? chatChannelUri(roomUri, c.id)),
			})),
		};
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

	public async deliverWithCapability(user: ThinUser, activity: IActivity, inbox: string, shared: boolean, host: string): Promise<void> {
		const capability = await this.fetchInstanceMetadataService.chatRoomChannelsCapability(host);
		if (capability === true) await this.queueService.deliver(user, activity, inbox, shared);
		else if (capability == null) await this.queueService.createChatChannelDeliverJob(user, activity, inbox, shared, host);
	}

	public async deliverableTo(host: string | null, message: Pick<MiChatMessage, 'toRoomChannelId'>, room: MiChatRoom): Promise<boolean | null> {
		if (!room.hasChannels || host == null) return true;
		if (message.toRoomChannelId != null && message.toRoomChannelId === room.legacyChannelId) return true;
		return this.fetchInstanceMetadataService.chatRoomChannelsCapability(host);
	}

	// 호출자는 소유자와 revision을 확인하고 그룹 행을 잠근 동일 트랜잭션을 전달한다.
	// sections가 undefined면 섹션 필드가 없는 것이고, null이면 검증에서 탈락한 것이다. 둘 다 지금 섹션을 유지한다.
	public async applyRemote(manager: EntityManager, room: MiChatRoom, snapshot: RemoteChatChannels, sections?: RemoteChatChannelSection[] | null): Promise<MiChatRoom> {
		const previous = await manager.findBy(MiChatRoomChannel, { roomId: room.id });
		const channels: MiChatRoomChannel[] = [];
		for (const [position, remote] of snapshot.channels.entries()) {
			const known = previous.find(c => c.uri === remote.id);
			const channel = manager.create(MiChatRoomChannel, { id: known?.id ?? this.idService.gen(), roomId: room.id, uri: remote.id, name: remote.name, position, sectionId: known?.sectionId ?? null });
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
		await this.applyRemoteSections(manager, room.id, channels, sections);
		return { ...room, hasChannels: true, legacyChannelId };
	}

	private async applyRemoteSections(manager: EntityManager, roomId: string, channels: MiChatRoomChannel[], sections: RemoteChatChannelSection[] | null | undefined): Promise<void> {
		if (sections != null) {
			const previous = await manager.findBy(MiChatRoomChannelSection, { roomId });
			const kept: MiChatRoomChannelSection[] = [];
			for (const [position, remote] of sections.entries()) {
				const known = previous.find(section => section.uri === remote.id);
				const section = manager.create(MiChatRoomChannelSection, { id: known?.id ?? this.idService.gen(), roomId, uri: remote.id, name: remote.name, position });
				await manager.save(MiChatRoomChannelSection, section);
				kept.push(section);
			}
			for (const section of previous) {
				if (!kept.some(s => s.id === section.id)) await manager.delete(MiChatRoomChannelSection, section.id);
			}
			const sectionOf = new Map<string, string>();
			for (const remote of sections) {
				const section = kept.find(s => s.uri === remote.id)!;
				for (const channelUri of remote.channels) sectionOf.set(channelUri, section.id);
			}
			for (const channel of channels) {
				const sectionId = sectionOf.get(channel.uri!) ?? null;
				if (channel.sectionId !== sectionId) await manager.update(MiChatRoomChannel, channel.id, { sectionId });
				channel.sectionId = sectionId;
			}
		}
		// 섹션 필드가 없거나 잘못됐어도 채널 순서는 지금 섹션 상태의 화면 순서를 따른다.
		await this.renumberChannels(manager, roomId);
	}
}
