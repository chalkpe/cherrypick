/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatChannelError, isChatChannelUri, normalizeChatChannelName, parseChatChannels, validChatChannelRefRanges } from '@/core/chat-room-channels.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';

const roomUri = 'https://owner.test/chat/rooms/one';
const channelUri = `${roomUri}/channels/selected`;
const room = { id: 'one', ownerId: 'owner', uri: roomUri, hasChannels: true } as MiChatRoom;

function referenceService() {
	return Object.assign(Object.create(ChatRoomChannelService.prototype), {
		config: { url: 'https://local.test' },
		db: {
			manager: {
				findBy: async () => [{ id: 'selected', roomId: room.id, uri: channelUri }],
				findOneBy: async () => ({ id: 'owner', host: 'owner.test' }),
			},
		},
	}) as ChatRoomChannelService;
}

describe('채널 이름과 원격 목록', () => {
	test('앞뒤 공백만 제거하고 중복이나 문자를 제한하지 않는다', () => {
		expect(normalizeChatChannelName('  A #한글 / 😀  ')).toBe('A #한글 / 😀');
		expect(normalizeChatChannelName('😀'.repeat(128))).toHaveLength(256);
		expect(() => normalizeChatChannelName('😀'.repeat(129))).toThrow(ChatChannelError);
		expect(() => normalizeChatChannelName('  ')).toThrow(ChatChannelError);
	});

	test('원격의 더 큰 이름과 동명이름을 자르거나 합치지 않는다', () => {
		const channels = [{ id: channelUri, name: '긴'.repeat(129) }, { id: `${roomUri}/channels/second`, name: '긴'.repeat(129) }];

		expect(parseChatChannels({ _misskey_chatChannels: channels, _misskey_chatLegacyChannel: null }, roomUri)?.channels).toEqual(channels);
	});

	test.each([
		{ channels: [] },
		{ channels: [{ id: 'https://other.test/chat/rooms/one/channels/selected', name: 'other' }] },
		{ channels: [{ id: channelUri, name: 'first' }, { id: channelUri, name: 'duplicate' }] },
		{ channels: [{ id: channelUri, name: '' }] },
	])('잘못된 전체 목록을 거부한다: $channels', ({ channels }) => {
		expect(parseChatChannels({ _misskey_chatChannels: channels, _misskey_chatLegacyChannel: null }, roomUri)).toBeNull();
	});

	test('legacy 포인터는 현재 목록 안의 ID이거나 null이어야 한다', () => {
		expect(parseChatChannels({ _misskey_chatChannels: [{ id: channelUri, name: 'general' }], _misskey_chatLegacyChannel: `${roomUri}/channels/missing` }, roomUri)).toBeNull();
		expect(isChatChannelUri(roomUri, `${channelUri}/nested`)).toBe(false);
	});
});

describe('본문 구간으로 선택한 채널 참조', () => {
	test('본문 공백을 정리하면 UTF-16 참조 위치도 같이 옮긴다', async () => {
		const service = referenceService();

		const refs = await service.localRefs(room, '  😀 #이름  ', [{ channelId: 'selected', start: 5, length: 3 }]);

		expect(refs).toEqual([{ channelId: 'selected', uri: channelUri, start: 3, length: 3 }]);
	});

	test('16개를 넘는 참조도 본문 길이 안이면 모두 보존한다', async () => {
		const service = referenceService();
		const text = '#가 '.repeat(32).trim();
		const refs = Array.from({ length: 32 }, (_, i) => ({ channelId: 'selected', start: i * 3, length: 2 }));

		expect(await service.localRefs(room, text, refs)).toHaveLength(32);
	});

	test('겹치거나 본문 밖인 참조는 거부하고 선택하지 않은 #글자는 참조를 만들지 않는다', async () => {
		const service = referenceService();

		expect(validChatChannelRefRanges([{ start: 0, length: 4 }, { start: 2, length: 2 }], '#가#나')).toBe(false);
		expect(validChatChannelRefRanges([{ start: 0, length: 100 }], '#가')).toBe(false);
		expect(await service.localRefs(room, '#일반글자', [])).toEqual([]);
	});

	test('원격의 잘못된 참조만 버리고 다른 그룹 URI를 연결하지 않는다', async () => {
		const service = referenceService();

		expect(await service.remoteRefs(room, '#가', [{ id: 'https://other.test/channels/one', start: 0, length: 2 }])).toEqual([]);
		expect(await service.remoteRefs(room, '#가', [{ id: channelUri, start: -1, length: 2 }])).toEqual([]);
	});
});
