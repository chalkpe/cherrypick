/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { buildChatNote, buildChatRoomUpdate } from '@/core/activitypub/misc/chat-payloads.js';
import { packedChatRoomSchema } from '@/models/json-schema/chat-room.js';

const owner = { id: 'owner', host: null };
const baseUrl = 'https://owner.example';
const roomUri = `${baseUrl}/chat/rooms/room`;
const channelUri = `${roomUri}/channels/general`;

describe('채널 연합 표현', () => {
	test('그룹 메시지에 선택한 채널과 본문 구간을 포함한다', () => {
		const options = {
			baseUrl, roomUri, channelUri,
			channelRefs: [{ id: channelUri, start: 0, length: 4 }],
		};

		const note = buildChatNote({ id: 'message', text: '#같은이름' }, owner, [], 'room', options);

		expect(note).toMatchObject({
			_misskey_chatRoom: roomUri,
			_misskey_chatChannel: channelUri,
			_misskey_chatChannelRefs: options.channelRefs,
		});
	});

	test('멤버용 그룹 변경은 순서와 구버전 기본 채널을 포함한다', () => {
		const options = {
			baseUrl,
			channels: [{ id: channelUri, name: '이름 변경' }],
			legacyChannel: channelUri,
		};

		const activity = buildChatRoomUpdate({ id: 'room', name: 'group' }, owner, options);

		expect(activity.object).toMatchObject({
			_misskey_chatChannels: options.channels,
			_misskey_chatLegacyChannel: channelUri,
		});
	});

	test('초대용 그룹 표현은 채널 목록을 공개하지 않는다', () => {
		const activity = buildChatRoomUpdate({ id: 'room', name: 'group' }, owner, { baseUrl });

		expect(activity.object).not.toHaveProperty('_misskey_chatChannels');
	});

	test('기존 그룹 응답에 채널 모드와 기본 채널을 추가한다', () => {
		expect(packedChatRoomSchema.properties).toHaveProperty('hasChannels');
		expect(packedChatRoomSchema.properties).toHaveProperty('legacyChannelId');
	});
});
