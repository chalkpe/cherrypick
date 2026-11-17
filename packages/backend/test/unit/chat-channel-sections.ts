/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { chatChannelDisplayOrder, chatSectionUri, isChatSectionUri, normalizeChatSectionName, parseChatChannelSections } from '@/core/chat-room-channels.js';

describe('채널 섹션 연합 필드 해석', () => {
	const roomUri = 'https://remote.test/chat/rooms/room1';
	const channelUris = new Set([`${roomUri}/channels/c1`, `${roomUri}/channels/c2`, `${roomUri}/channels/c3`]);
	const sectionUri = `${roomUri}/sections/s1`;

	function section(overrides: Record<string, unknown> = {}) {
		return { id: sectionUri, name: '운영', channels: [`${roomUri}/channels/c1`], ...overrides };
	}

	test('키가 없으면 건드리지 않도록 undefined를 돌려준다', () => {
		expect(parseChatChannelSections(undefined, roomUri, channelUris)).toBeUndefined();
	});

	test('유효한 목록은 순서대로 해석하고 빈 섹션과 빈 목록을 허용한다', () => {
		const parsed = parseChatChannelSections([
			section(),
			{ id: `${roomUri}/sections/s2`, name: '  자료  ', channels: [`${roomUri}/channels/c3`, `${roomUri}/channels/c2`] },
			{ id: `${roomUri}/sections/s3`, name: '빈 묶음', channels: [] },
		], roomUri, channelUris);
		expect(parsed).toEqual([
			{ id: sectionUri, name: '운영', channels: [`${roomUri}/channels/c1`] },
			{ id: `${roomUri}/sections/s2`, name: '  자료  ', channels: [`${roomUri}/channels/c3`, `${roomUri}/channels/c2`] },
			{ id: `${roomUri}/sections/s3`, name: '빈 묶음', channels: [] },
		]);
		expect(parseChatChannelSections([], roomUri, channelUris)).toEqual([]);
	});

	test('배열이 아니거나 상한을 넘는 목록은 무시한다', () => {
		expect(parseChatChannelSections(null, roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections('sections', roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections({ id: sectionUri }, roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections(Array.from({ length: 1025 }, (_, i) => section({ id: `${roomUri}/sections/s${i}` })), roomUri, channelUris)).toBeNull();
	});

	test('섹션 URI가 그룹 주소와 맞지 않거나 서로 겹치면 무시한다', () => {
		expect(parseChatChannelSections([section({ id: `${roomUri}/channels/s1` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: 'https://other.test/chat/rooms/room1/sections/s1' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/a/b` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/a?b` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/a b` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/${'a'.repeat(1024)}` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section(), section()], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: 42 })], roomUri, channelUris)).toBeNull();
	});

	test('이름이 비었거나 받기 한도를 넘으면 무시한다', () => {
		expect(parseChatChannelSections([section({ name: '' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: '   ' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: 42 })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: '가'.repeat(4097) })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: '가'.repeat(4096) })], roomUri, channelUris)).not.toBeNull();
	});

	test('이름이나 URI에 NUL 문자가 있으면 무시한다', () => {
		expect(parseChatChannelSections([section({ name: '\u0000' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: '운영\u0000' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: '운\u0000영' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/s\u00001` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/s1\u0000` })], roomUri, channelUris)).toBeNull();
	});

	test('짝 없는 surrogate가 든 이름이나 URI는 무시한다', () => {
		expect(parseChatChannelSections([section({ name: '운영\ud800' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ name: '\udc00운영' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/s\ud800` })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/\udc00s` })], roomUri, channelUris)).toBeNull();
	});

	test('짝 없는 surrogate URI와 U+FFFD URI가 함께 오면 무시한다', () => {
		expect(parseChatChannelSections([
			{ id: `${roomUri}/sections/s\ud800`, name: 'first', channels: [] },
			{ id: `${roomUri}/sections/s\ufffd`, name: 'second', channels: [] },
		], roomUri, channelUris)).toBeNull();
	});

	test('글자 수는 맞아도 UTF-8로 1024바이트를 넘는 URI는 무시한다', () => {
		const suffix = Array.from({ length: 940 }, (_, i) => String.fromCodePoint(0x800 + i)).join('');
		const uri = `${roomUri}/sections/${suffix}`;

		expect(uri.length).toBeLessThanOrEqual(1024);
		expect(Buffer.byteLength(uri)).toBeGreaterThan(2700);
		expect(parseChatChannelSections([section({ id: uri })], roomUri, channelUris)).toBeNull();
	});

	test('URI는 UTF-8 1024바이트까지 받고 하나 넘으면 무시한다', () => {
		// 접두 46바이트 + 3바이트 글자 326개 = 1024바이트
		const within = `${roomUri}/sections/${'ࠀ'.repeat(326)}`;
		const over = `${roomUri}/sections/${'ࠀ'.repeat(326)}a`;

		expect(Buffer.byteLength(within)).toBe(1024);
		expect(Buffer.byteLength(over)).toBe(1025);
		expect(parseChatChannelSections([section({ id: within })], roomUri, channelUris)).not.toBeNull();
		expect(parseChatChannelSections([section({ id: over })], roomUri, channelUris)).toBeNull();
	});

	test('올바른 surrogate pair(이모지)가 든 URI와 이름은 받는다', () => {
		expect(parseChatChannelSections([section({ id: `${roomUri}/sections/s😀`, name: '묶음 😀' })], roomUri, channelUris)).toEqual([
			{ id: `${roomUri}/sections/s😀`, name: '묶음 😀', channels: [`${roomUri}/channels/c1`] },
		]);
	});

	test('목록에 없는 채널이나 두 섹션에 걸친 채널이 있으면 무시한다', () => {
		expect(parseChatChannelSections([section({ channels: [`${roomUri}/channels/missing`] })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ channels: ['https://other.test/chat/rooms/room1/channels/c1'] })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ channels: 'c1' })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ channels: [42] })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section(), { id: `${roomUri}/sections/s2`, name: '둘째', channels: [`${roomUri}/channels/c1`] }], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([section({ channels: [`${roomUri}/channels/c1`, `${roomUri}/channels/c1`] })], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections([null], roomUri, channelUris)).toBeNull();
		expect(parseChatChannelSections(['section'], roomUri, channelUris)).toBeNull();
	});

	test('섹션 URI 헬퍼는 채널 URI와 같은 모양으로 판별한다', () => {
		expect(chatSectionUri(roomUri, 's1')).toBe(sectionUri);
		expect(isChatSectionUri(roomUri, sectionUri)).toBe(true);
		expect(isChatSectionUri(roomUri, `${roomUri}/channels/s1`)).toBe(false);
		expect(isChatSectionUri(roomUri, null)).toBe(false);
		expect(isChatSectionUri(roomUri, `${roomUri}/sections/s\u00001`)).toBe(false);
	});

	test('섹션 URI 헬퍼는 UTF-8 바이트 한도와 짝 없는 surrogate를 거르고 이모지는 받는다', () => {
		expect(isChatSectionUri(roomUri, `${roomUri}/sections/${'ࠀ'.repeat(326)}`)).toBe(true);
		expect(isChatSectionUri(roomUri, `${roomUri}/sections/${'ࠀ'.repeat(326)}a`)).toBe(false);
		expect(isChatSectionUri(roomUri, `${roomUri}/sections/s\ud800`)).toBe(false);
		expect(isChatSectionUri(roomUri, `${roomUri}/sections/\udc00s`)).toBe(false);
		expect(isChatSectionUri(roomUri, `${roomUri}/sections/s😀`)).toBe(true);
	});
});

describe('섹션 이름 정규화', () => {
	test('앞뒤 공백을 제거하고 NUL이 없는 이름은 그대로 받는다', () => {
		expect(normalizeChatSectionName('  운영  ')).toBe('운영');
		expect(normalizeChatSectionName('A #한글 / 😀')).toBe('A #한글 / 😀');
	});

	test('NUL 문자가 든 이름은 잘못된 이름으로 거부한다', () => {
		for (const name of ['\u0000', '운영\u0000', '운\u0000영', '  운\u0000영  ']) {
			expect(() => normalizeChatSectionName(name)).toThrow(expect.objectContaining({ reason: 'INVALID_SECTION_NAME' }));
		}
	});

	test('짝 없는 surrogate가 든 이름은 잘못된 이름으로 거부한다', () => {
		for (const name of ['운영\ud800', '\udc00운영', '운\ud800영']) {
			expect(() => normalizeChatSectionName(name)).toThrow(expect.objectContaining({ reason: 'INVALID_SECTION_NAME' }));
		}
	});
});

describe('채널 섹션 표시 순서', () => {
	const channels = [
		{ id: 'u1', sectionId: null },
		{ id: 'a1', sectionId: 'sa' },
		{ id: 'u2', sectionId: null },
		{ id: 'b1', sectionId: 'sb' },
		{ id: 'a2', sectionId: 'sa' },
	];

	test('섹션 없는 채널이 맨 위이고 섹션 순서대로 묶는다', () => {
		expect(chatChannelDisplayOrder(channels, ['sa', 'sb']).map(channel => channel.id)).toEqual(['u1', 'u2', 'a1', 'a2', 'b1']);
		expect(chatChannelDisplayOrder(channels, ['sb', 'sa']).map(channel => channel.id)).toEqual(['u1', 'u2', 'b1', 'a1', 'a2']);
	});

	test('섹션이 없으면 입력 순서를 그대로 유지한다', () => {
		const flat = [{ id: 'u1', sectionId: null }, { id: 'u2', sectionId: null }];
		expect(chatChannelDisplayOrder(flat, []).map(channel => channel.id)).toEqual(['u1', 'u2']);
	});

	test('빈 섹션은 순서에 자리를 차지하지 않는다', () => {
		expect(chatChannelDisplayOrder(channels, ['empty', 'sa', 'sb']).map(channel => channel.id)).toEqual(['u1', 'u2', 'a1', 'a2', 'b1']);
	});
});
