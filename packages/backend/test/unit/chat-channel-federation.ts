/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import type { IObject, IPost } from '@/core/activitypub/type.js';
import type { MiChatMessage, MiChatRoom, MiUser } from '@/models/_.js';

const roomUri = 'https://owner.test/chat/rooms/room';
const general = { id: 'general-local', roomId: 'room', uri: `${roomUri}/channels/general`, name: '이름 변경', position: 1 };
const other = { id: 'other-local', roomId: 'room', uri: `${roomUri}/channels/other`, name: '같은 이름', position: 0 };
const room = { id: 'room', ownerId: 'owner', uri: roomUri, hasChannels: true, legacyChannelId: general.id } as MiChatRoom;

function channelService() {
	const channels = [general, other];
	const manager = {
		existsBy: async (_entity: unknown, where: { id: string; roomId: string }) => channels.some(channel => channel.id === where.id && channel.roomId === where.roomId),
		findOneBy: async () => ({ id: 'owner', host: 'owner.test' }),
	};
	return Object.assign(Object.create(ChatRoomChannelService.prototype), {
		config: { url: 'https://local.test' },
		db: { manager },
		channels: { find: async () => channels },
		fetchInstanceMetadataService: { chatRoomChannelsCapability: async (host: string) => host === 'new.test' },
	}) as ChatRoomChannelService;
}

type ChannelReceiver = {
	resolveChatMessageChannel(room: MiChatRoom, object: IPost, options?: { isLastAttempt?: boolean }): Promise<string | null>;
};

function receiver(ownerHost: string | null = 'owner.test') {
	const requestSync = vi.fn();
	const service = Object.assign(Object.create(ApInboxService.prototype), {
		chatRoomChannelService: channelService(),
		usersRepository: { findOneBy: async () => ({ id: 'owner', host: ownerHost }) },
		chatRosterService: { requestSync },
	}) as ChannelReceiver;
	return { service, requestSync };
}

describe('원격 메시지의 채널 귀속', () => {
	test('채널 미지정은 이름과 순서에 관계없이 legacy ID만 사용한다', async () => {
		const { service } = receiver();

		expect(await service.resolveChatMessageChannel(room, {} as IPost)).toBe(general.id);
		await expect(service.resolveChatMessageChannel({ ...room, legacyChannelId: null }, {} as IPost)).rejects.toBeInstanceOf(ChatMessageAccessError);
	});

	test('원격 URI로 로컬 번호가 다른 채널을 찾는다', async () => {
		const { service } = receiver();

		expect(await service.resolveChatMessageChannel(room, { _misskey_chatChannel: other.uri } as IPost)).toBe(other.id);
	});

	test('다른 그룹의 채널은 동기화하지 않고 영구 거부한다', async () => {
		const { service, requestSync } = receiver();

		await expect(service.resolveChatMessageChannel(room, { _misskey_chatChannel: 'https://owner.test/chat/rooms/other/channels/other' } as IPost)).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(requestSync).not.toHaveBeenCalled();
	});

	test('소유 서버는 없는 채널을 만들거나 재시도하지 않는다', async () => {
		const { service, requestSync } = receiver(null);

		await expect(service.resolveChatMessageChannel(room, { _misskey_chatChannel: `${roomUri}/channels/missing` } as IPost)).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(requestSync).not.toHaveBeenCalled();
	});

	test('전환이나 채널 통지가 늦은 사본은 명단 동기화 뒤 유계 재시도한다', async () => {
		const { service, requestSync } = receiver();
		const note = { _misskey_chatChannel: `${roomUri}/channels/missing` } as IPost;

		await expect(service.resolveChatMessageChannel({ ...room, hasChannels: false }, note)).rejects.toThrow('chat room channel is not ready');
		expect(requestSync).toHaveBeenCalledWith(expect.objectContaining({ id: room.id }), 'channels');
		await expect(service.resolveChatMessageChannel(room, note, { isLastAttempt: true })).rejects.toBeInstanceOf(ChatMessageAccessError);
	});
});

type MessageDelivery = {
	deliverToRemoteUsers(actor: MiUser, users: MiUser[], activity: IObject, message: MiChatMessage): Promise<void>;
};

describe('채널 메시지의 구버전 배달 경계', () => {
	test.each(['Create', 'Update', 'Delete', 'EmojiReact', 'Undo', 'Announce'])('%s를 지원 여부 확인이 필요한 배달로 예약한다', async type => {
		const actor = { id: 'actor', host: null } as MiUser;
		const peers = ['old.test', 'new.test', 'unknown.test'].map(host => ({ id: host, host, inbox: `https://${host}/inbox` } as MiUser));
		const deliver = vi.fn();
		const deliverWithCapability = vi.fn();
		const service = Object.assign(Object.create(ChatService.prototype), {
			chatRoomsRepository: { findOneBy: async () => room },
			chatRoomChannelService: { deliverWithCapability },
			apRendererService: { addContext: (value: unknown) => value },
			userEntityService: { isRemoteUser: (user: MiUser) => user.host != null },
			queueService: { deliver },
		}) as MessageDelivery;
		const message = { toRoomId: room.id, toRoomChannelId: other.id } as MiChatMessage;

		await service.deliverToRemoteUsers(actor, peers, { type }, message);

		expect(deliverWithCapability.mock.calls.map(call => [call[2], call[4]])).toEqual(peers.map(peer => [peer.inbox, peer.host]));
		deliver.mockClear();
		await service.deliverToRemoteUsers(actor, peers, { type }, { ...message, toRoomChannelId: general.id });
		expect(deliver).toHaveBeenCalledTimes(3);
		expect(deliver.mock.calls.every(call => call[4] == null)).toBe(true);
	});
});

test('구버전 채널이 삭제된 방에서 채널 없는 메시지를 구버전 메시지로 취급하지 않는다', async () => {
	const actor = { id: 'actor', host: null } as MiUser;
	const peer = { id: 'peer', host: 'old.test', inbox: 'https://old.test/inbox' } as MiUser;
	const deliver = vi.fn();
	const service = Object.assign(Object.create(ChatService.prototype), {
		chatRoomsRepository: { findOneBy: async () => ({ ...room, legacyChannelId: null }) },
		chatRoomChannelService: { deliverWithCapability: deliver },
		apRendererService: { addContext: (value: unknown) => value },
		userEntityService: { isRemoteUser: () => true },
		queueService: { deliver },
	}) as MessageDelivery;
	await service.deliverToRemoteUsers(actor, [peer], { type: 'Create' }, { toRoomId: room.id, toRoomChannelId: null } as MiChatMessage);
	expect(deliver.mock.calls[0][4]).toBe('old.test');
});
