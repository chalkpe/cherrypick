/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type RelayProvider = {
	id: string; origin: string;
	enabled: boolean; validated: boolean; deleted?: boolean; credentialVersion?: string;
};
import type { ScreenShareLimits } from './screen-share-limits.js';

export type RelayCapacity = { protocolVersion?: number; enabled?: boolean; accepting: boolean; maxSlots: number; reservedSlots: number; remainingSlots: number; remainingRooms: number; allowScreenShare?: boolean; mediaProvider?: string; screenShareLimits?: ScreenShareLimits; capabilities?: { cancelPending?: boolean; includeIceServers?: boolean } };
export function relayCapability(providers: { enabled: boolean; validated: boolean }[]): boolean {
	return providers.some(provider => provider.enabled && provider.validated);
}
export function rankProviders<T extends { id: string; enabled: boolean; validated: boolean; capacity: RelayCapacity }>(providers: T[], slots: number, random: () => number = Math.random): T[] {
	return providers.filter(p => p.enabled && p.validated && p.capacity.accepting && p.capacity.remainingSlots >= slots && p.capacity.remainingRooms > 0)
		.map(provider => ({ provider, tie: random() })).sort((a, b) => a.provider.capacity.reservedSlots / a.provider.capacity.maxSlots - b.provider.capacity.reservedSlots / b.provider.capacity.maxSlots || a.tie - b.tie).map(p => p.provider);
}
