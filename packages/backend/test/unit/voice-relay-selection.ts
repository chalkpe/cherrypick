/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { rankProviders, relayCapability } from '@/core/voice-relay/selection.js';
test('delegated approval enables capability without a local SFU and survives temporary saturation', () => {
 expect(relayCapability([{ enabled: true, validated: true }])).toBe(true);
 expect(relayCapability([{ enabled: true, validated: false }])).toBe(false);
 expect(relayCapability([{ enabled: false, validated: true }])).toBe(false);
});
test('chooses eligible providers by reserved capacity ratio and excludes full or unapproved providers', () => {
 const values = [
 { id: 'small', enabled: true, validated: true, capacity: { accepting: true, maxSlots: 102, reservedSlots: 51, remainingSlots: 51, remainingRooms: 1 } },
 { id: 'large', enabled: true, validated: true, capacity: { accepting: true, maxSlots: 510, reservedSlots: 51, remainingSlots: 459, remainingRooms: 9 } },
 { id: 'full', enabled: true, validated: true, capacity: { accepting: true, maxSlots: 100, reservedSlots: 80, remainingSlots: 20, remainingRooms: 1 } },
 ];
 expect(rankProviders(values, 51, () => 0).map(p => p.id)).toEqual(['large', 'small']);
 expect(rankProviders(values.map(p => ({ ...p, validated: false })), 51)).toEqual([]);
});
