/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { parseRecordingEvent, recordingDeliveryWindowMs, recordingRetentionSeconds } from './recording-event.js';

const now = Date.parse('2026-11-13T00:00:00Z');
const event = { id: '070d4100-0123-4321-a123-012345678901', identity: 'https://remote.test/users/r1', recording: true, updatedAt: now };

test.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects an invalid or unbounded delivery window %s', deliveryWindowMs => {
	expect(parseRecordingEvent({ ...event, deliveryWindowMs }, now)).toBeNull();
});

test('preserves an owner-declared longer delivery budget instead of a fixed fourteen-day cutoff', () => {
	const value = { ...event, updatedAt: now - 30 * 86_400_000, deliveryWindowMs: 60 * 86_400_000 };

	expect(parseRecordingEvent(value, now)).toEqual(value);
});

test('rejects a future timestamp whose combined retention would exceed the Redis TTL bound', () => {
	const value = { ...event, updatedAt: now + 300_000, deliveryWindowMs: 2_146_860_717_000 };

	expect(parseRecordingEvent(value, now)).toBeNull();
});

test('expires the event before its deduplication entry can disappear', () => {
	const value = { ...event, deliveryWindowMs: 1000 };

	expect(parseRecordingEvent(value, now + 605_111_000, 1)).toEqual(value);
	expect(parseRecordingEvent(value, now + 605_111_001, 1)).toBeNull();
});

test('covers the default automatic retries and one retained-job retry opportunity at each queue', () => {
	expect(recordingDeliveryWindowMs(12)).toBe(744_689_000);
	expect(recordingDeliveryWindowMs(8)).toBe(622_629_000);
	expect(recordingRetentionSeconds(744_689_000, 8)).toBe(1_367_619);
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects an unsupported queue retry count %s', attempts => {
	expect(() => recordingDeliveryWindowMs(attempts)).toThrow(RangeError);
});
