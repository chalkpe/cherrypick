/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { CHAT_RECEIVED_MAX_AGE_MS, chatReceivedTime } from '@/misc/chat-received-time.js';

const now = Date.parse('2026-11-15T00:00:00.000Z');

describe('받은 글의 정렬 시각', () => {
	test('범위 안의 쓴 시각은 밀리초까지 그대로 쓴다', () => {
		const published = new Date(now - 1234);
		expect(chatReceivedTime(published, now)).toBe(now - 1234);
	});

	test('쓴 시각이 없으면 도착 시각을 쓴다', () => {
		expect(chatReceivedTime(null, now)).toBe(now);
		expect(chatReceivedTime(undefined, now)).toBe(now);
		expect(chatReceivedTime(new Date(NaN), now)).toBe(now);
	});

	test('미래의 쓴 시각은 도착 시각을 쓴다', () => {
		expect(chatReceivedTime(new Date(now + 1), now)).toBe(now);
		expect(chatReceivedTime(new Date(now + 10 * 365 * 24 * 3600 * 1000), now)).toBe(now);
	});

	test('비정상적으로 먼 과거의 쓴 시각은 허용 기간까지만 쓴다', () => {
		expect(chatReceivedTime(new Date(0), now)).toBe(now - CHAT_RECEIVED_MAX_AGE_MS);
		expect(chatReceivedTime(new Date('1999-12-31T00:00:00.000Z'), now)).toBe(now - CHAT_RECEIVED_MAX_AGE_MS);
	});

	test('같은 도착 시각에 범위를 벗어난 값이 여럿이어도 정렬 순서는 쓴 시각 순서를 해치지 않는다', () => {
		const times = [now - 5000, now - 4000, now + 10_000_000].map(t => chatReceivedTime(new Date(t), now));
		expect(times).toEqual([...times].sort((a, b) => a - b));
	});
});
