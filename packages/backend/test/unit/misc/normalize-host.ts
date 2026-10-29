/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { isHostAllowedByDeliveryTargets } from '@/misc/normalize-host.js';

describe('isHostAllowedByDeliveryTargets', () => {
	test('allows every remote host when no targets are set', () => {
		expect(isHostAllowedByDeliveryTargets(null, 'remote.test')).toBe(true);
	});

	test('always allows local recipients', () => {
		expect(isHostAllowedByDeliveryTargets({ mode: 'include' as const, hosts: ['allowed.test'] }, null)).toBe(true);
	});

	test('matches an exclude entry regardless of case, trailing dot, or port', () => {
		const targets = { mode: 'exclude' as const, hosts: ['EVIL.EXAMPLE.'] };

		expect(isHostAllowedByDeliveryTargets(targets, 'evil.example')).toBe(false);
		expect(isHostAllowedByDeliveryTargets(targets, 'evil.example:8443')).toBe(false);
		expect(isHostAllowedByDeliveryTargets(targets, 'other.example')).toBe(true);
	});

	test('matches an include entry regardless of case, trailing dot, or port', () => {
		const targets = { mode: 'include' as const, hosts: ['allowed.example:8443'] };

		expect(isHostAllowedByDeliveryTargets(targets, 'allowed.example')).toBe(true);
		expect(isHostAllowedByDeliveryTargets(targets, 'other.example')).toBe(false);
	});

	test('fails closed when a target entry is invalid', () => {
		expect(isHostAllowedByDeliveryTargets({ mode: 'exclude' as const, hosts: ['not a host'] }, 'other.example')).toBe(false);
	});

	test('fails closed for malformed delivery targets', () => {
		expect(isHostAllowedByDeliveryTargets({ mode: 'exclude', hosts: undefined } as any, 'other.example')).toBe(false);
		expect(isHostAllowedByDeliveryTargets({ mode: 'unknown', hosts: ['other.example'] } as any, 'allowed.example')).toBe(false);
	});
});
