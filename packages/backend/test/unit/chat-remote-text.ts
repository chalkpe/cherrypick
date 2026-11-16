/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import {
	ChatChannelError,
	isChatChannelUri,
	isStorableText,
	normalizeChatChannelName,
	parseChatChannels,
} from '@/core/chat-room-channels.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatRoomHistorySyncProcessorService } from '@/queue/processors/ChatRoomHistorySyncProcessorService.js';
import { parseChatHistoryItem } from '@/core/activitypub/misc/chat-history.js';
import type { ChatHistoryItemContext } from '@/core/activitypub/misc/chat-history.js';
import type { IPost } from '@/core/activitypub/type.js';
import type { MiChatRoom } from '@/models/_.js';

const roomUri = 'https://owner.example/chat/rooms/room1';
const high = '\ud800';
const low = '\udc00';

// 총 UTF-8 바이트가 정확히 bytes가 되도록 접두 뒤를 채운다.
function uriOfBytes(bytes: number, filler = 'a'): string {
	const prefix = `${roomUri}/channels/`;
	const size = Buffer.byteLength(filler);
	const rest = bytes - Buffer.byteLength(prefix);
	return prefix + filler.repeat(Math.floor(rest / size)) + 'a'.repeat(rest % size);
}

describe('저장할 수 있는 원격 문자열', () => {
	test.each([
		['일반 글자', 'channel', true],
		['빈 문자열', '', true],
		['올바른 surrogate pair(이모지)', '채널 😀', true],
		['NUL', 'a\u0000b', false],
		['문자열 끝의 NUL', 'ab\u0000', false],
		['짝 없는 high surrogate', `a${high}`, false],
		['짝 없는 low surrogate', `${low}a`, false],
		['순서가 뒤집힌 surrogate', `${low}${high}`, false],
		['high surrogate 뒤에 일반 글자', `${high}a`, false],
	])('%s', (_name, value, expected) => {
		expect(isStorableText(value)).toBe(expected);
	});

	test('UTF-8 바이트 상한은 상한 값까지 받고 하나 넘으면 거른다', () => {
		expect(isStorableText('a'.repeat(1024), 1024)).toBe(true);
		expect(isStorableText('a'.repeat(1025), 1024)).toBe(false);
		// 한 글자가 3바이트: 341자는 1023바이트, 342자는 1026바이트
		expect(isStorableText('ࠀ'.repeat(341), 1024)).toBe(true);
		expect(isStorableText('ࠀ'.repeat(342), 1024)).toBe(false);
		// 이모지는 4바이트: 256개는 1024바이트
		expect(isStorableText('😀'.repeat(256), 1024)).toBe(true);
		expect(isStorableText('😀'.repeat(257), 1024)).toBe(false);
	});
});

describe('받은 채널 주소와 이름', () => {
	test('1024바이트 안쪽 주소는 받고 1025바이트부터는 거른다', () => {
		expect(isChatChannelUri(roomUri, uriOfBytes(1024))).toBe(true);
		expect(isChatChannelUri(roomUri, uriOfBytes(1025))).toBe(false);
		expect(isChatChannelUri(roomUri, uriOfBytes(1024, 'ࠀ'))).toBe(true);
	});

	test('글자 수는 맞아도 UTF-8로 1024바이트를 넘는 주소는 거른다', () => {
		const suffix = Array.from({ length: 940 }, (_, i) => String.fromCodePoint(0x800 + i)).join('');
		const uri = `${roomUri}/channels/${suffix}`;

		expect(uri.length).toBeLessThanOrEqual(1024);
		expect(Buffer.byteLength(uri)).toBeGreaterThan(2700);
		expect(isChatChannelUri(roomUri, uri)).toBe(false);
	});

	test.each([
		['NUL', `${roomUri}/channels/a\u0000b`],
		['짝 없는 high surrogate', `${roomUri}/channels/a${high}`],
		['짝 없는 low surrogate', `${roomUri}/channels/${low}a`],
	])('%s가 든 주소는 거른다', (_name, uri) => {
		expect(isChatChannelUri(roomUri, uri)).toBe(false);
	});

	test('이모지 pair가 든 주소는 받는다', () => {
		expect(isChatChannelUri(roomUri, `${roomUri}/channels/a😀`)).toBe(true);
	});

	function group(channels: unknown, legacy: unknown = null) {
		return { _misskey_chatChannels: channels, _misskey_chatLegacyChannel: legacy };
	}
	const id = (name: string) => `${roomUri}/channels/${name}`;

	test('올바른 목록은 이모지 이름과 함께 받는다', () => {
		expect(parseChatChannels(group([{ id: id('a'), name: '😀 채널' }], id('a')), roomUri)?.channels).toEqual([{ id: id('a'), name: '😀 채널' }]);
	});

	test.each([
		['NUL 이름', [{ id: id('a'), name: 'a\u0000' }]],
		['짝 없는 high surrogate 이름', [{ id: id('a'), name: `a${high}` }]],
		['짝 없는 low surrogate 이름', [{ id: id('a'), name: `${low}a` }]],
		['NUL 주소', [{ id: id('a\u0000'), name: 'a' }]],
		['짝 없는 surrogate 주소', [{ id: id(`a${high}`), name: 'a' }]],
		['목록 가운데 하나만 잘못된 항목', [{ id: id('a'), name: 'a' }, { id: id('b'), name: `b${high}` }]],
	])('%s가 있으면 목록 필드 전체를 무시한다', (_name, channels) => {
		expect(parseChatChannels(group(channels), roomUri)).toBeNull();
	});

	test('짝 없는 surrogate 두 주소가 같은 값으로 합쳐지는 목록은 받지 않는다', () => {
		expect(parseChatChannels(group([{ id: id(`s${high}`), name: 'first' }, { id: id('s�'), name: 'second' }]), roomUri)).toBeNull();
	});
});

describe('로컬 채널 이름', () => {
	test.each([
		['NUL', 'a\u0000b'],
		['짝 없는 high surrogate', `a${high}`],
		['짝 없는 low surrogate', `${low}a`],
	])('%s는 INVALID_CHANNEL_NAME으로 거부한다', (_name, value) => {
		expect(() => normalizeChatChannelName(value)).toThrow(ChatChannelError);
		try {
			normalizeChatChannelName(value);
		} catch (err) {
			expect((err as ChatChannelError).reason).toBe('INVALID_CHANNEL_NAME');
		}
	});

	test('이모지 이름은 받는다', () => {
		expect(normalizeChatChannelName('  😀  ')).toBe('😀');
	});
});

describe('받은 글의 채널 참조와 채널 지정', () => {
	const room = { id: 'room', ownerId: 'owner', uri: roomUri, hasChannels: true, legacyChannelId: 'general' } as MiChatRoom;
	const service = Object.assign(Object.create(ChatRoomChannelService.prototype), {
		config: { url: 'https://local.test' },
		db: { manager: { findOneBy: async () => ({ id: 'owner', host: 'owner.example' }), findBy: async () => [] } },
		channels: { find: async () => [] },
	}) as ChatRoomChannelService;

	test.each([
		['NUL', `${roomUri}/channels/a\u0000`],
		['짝 없는 surrogate', `${roomUri}/channels/a${high}`],
		['긴 다중 바이트', `${roomUri}/channels/${'ࠀ'.repeat(500)}`],
	])('%s가 든 참조는 목록 전체를 버린다', async (_name, uri) => {
		expect(await service.remoteRefs(room, '#채널', [{ id: uri, start: 0, length: 3 }])).toEqual([]);
	});

	test('올바른 참조는 받는다', async () => {
		expect(await service.remoteRefs(room, '#채널', [{ id: `${roomUri}/channels/ok`, start: 0, length: 3 }])).toEqual([{ channelId: 'ok', start: 0, length: 3, uri: `${roomUri}/channels/ok` }]);
	});

	test('저장할 수 없는 채널 주소의 글은 채널 없음으로 거부한다', async () => {
		await expect(service.remoteChannel(room, `${roomUri}/channels/a\u0000`)).rejects.toBeInstanceOf(ChatChannelError);
		await expect(service.remoteChannel(room, `${roomUri}/channels/a${low}`)).rejects.toBeInstanceOf(ChatChannelError);
	});
});

describe('받은 과거 기록 글', () => {
	const now = Date.parse('2026-11-13T00:00:00.000Z');
	const context: ChatHistoryItemContext = {
		roomUri,
		now,
		hostOf: uri => {
			try {
				return new URL(uri).host.toLowerCase();
			} catch {
				return null;
			}
		},
		isLocalHost: host => host === 'here.example',
		isSafeTime: time => time > Date.parse('2000-01-01T00:00:00.000Z'),
		text: note => typeof note._misskey_content === 'string' ? note._misskey_content : null,
	};
	const note = (overrides: Record<string, unknown> = {}) => ({
		id: 'https://member.example/chat/messages/m1',
		type: 'Note',
		attributedTo: 'https://member.example/users/u1',
		_misskey_content: 'hello',
		_misskey_talk: true,
		published: '2026-11-01T00:00:00.000Z',
		context: roomUri,
		_misskey_chatRoom: roomUri,
		...overrides,
	}) as IPost;
	const parse = (value: unknown) => parseChatHistoryItem(value, context);

	test('올바른 글은 이모지 본문과 작성자 이름을 그대로 받는다', () => {
		const item = parse(note({ _misskey_content: '😀', _misskey_chatAuthor: { name: '이름😀', username: 'u1', host: 'member.example' } }));

		expect(item).toMatchObject({ text: '😀', author: { name: '이름😀', username: 'u1' } });
	});

	test.each([
		['NUL 글 주소', { id: 'https://member.example/chat/messages/a\u0000' }, 'invalid id'],
		['짝 없는 surrogate 글 주소', { id: `https://member.example/chat/messages/a${high}` }, 'invalid id'],
		['NUL 작성자 주소', { attributedTo: 'https://member.example/users/a\u0000' }, 'no author'],
		['짝 없는 surrogate 작성자 주소', { attributedTo: `https://member.example/users/a${low}` }, 'no author'],
		['NUL 본문', { _misskey_content: 'a\u0000b' }, 'invalid text'],
		['짝 없는 surrogate 본문', { _misskey_content: `a${high}` }, 'invalid text'],
	])('%s는 그 글만 버린다', (_name, overrides, reason) => {
		expect(parse(note(overrides))).toEqual({ skip: reason });
	});

	test.each([
		['NUL 이름', { name: 'a\u0000', username: 'u1', host: 'member.example' }],
		['짝 없는 surrogate 이름', { name: `a${high}`, username: 'u1', host: 'member.example' }],
		['NUL 사용자명', { name: 'a', username: 'u\u0000', host: 'member.example' }],
		['짝 없는 surrogate 사용자명', { name: 'a', username: `u${low}`, host: 'member.example' }],
	])('%s가 든 작성자 정보는 글은 받고 정보만 버린다', (_name, author) => {
		expect(parse(note({ _misskey_chatAuthor: author }))).toMatchObject({ text: 'hello', author: null });
	});

	test('저장할 수 없는 리액션 항목만 버린다', () => {
		const item = parse(note({
			_misskey_chatReactions: [
				{ actor: 'https://other.example/users/a', reaction: '👍' },
				{ actor: 'https://other.example/users/a\u0000', reaction: '👍' },
				{ actor: `https://other.example/users/b${high}`, reaction: '👍' },
				{ actor: 'https://other.example/users/c', reaction: 'x\u0000' },
				{ actor: 'https://other.example/users/d', reaction: `x${low}` },
				{ actor: 'https://other.example/users/e', reaction: ':smile:' },
			],
		}));

		expect('skip' in item ? [] : item.reactions.map(r => r.actor)).toEqual(['https://other.example/users/a', 'https://other.example/users/e']);
	});
});

describe('받은 과거 기록 글의 이모지 이름', () => {
	test('저장할 수 없는 이름은 조회에서 빼고 올바른 이름만 찾는다', async () => {
		const findBy = vi.fn(async (_where: unknown) => []);
		const service = Object.assign(Object.create(ChatRoomHistorySyncProcessorService.prototype), {
			emojisRepository: { findBy },
		}) as unknown as { confirmedEmojis(note: IPost, host: string, run: unknown): Promise<string[]> };
		const tags = [':smile:', ':a\u0000b:', `:c${high}:`, ':d😀:'].map(name => ({ type: 'Emoji', name }));

		await service.confirmedEmojis({ tag: tags } as unknown as IPost, 'member.example', { checkedEmojis: new Set() });

		const where = findBy.mock.calls[0][0] as { name: { value: string[] } };
		expect(where.name.value).toEqual(['smile', 'd😀']);
	});
});
