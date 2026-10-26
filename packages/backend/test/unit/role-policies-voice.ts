/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { DEFAULT_POLICIES } from '@/core/RoleService.js';
import { packedRolePoliciesSchema } from '@/models/json-schema/role.js';

test('allows voice calls and screen sharing by default', () => {
	expect(DEFAULT_POLICIES.canVoiceCall).toBe(true);
	expect(DEFAULT_POLICIES.canScreenShare).toBe(true);
});

test('exposes the voice policies in the role policy schema', () => {
	const properties = packedRolePoliciesSchema.properties as Record<string, unknown>;
	expect(properties.canVoiceCall).toEqual({ type: 'boolean', optional: false, nullable: false });
	expect(properties.canScreenShare).toEqual({ type: 'boolean', optional: false, nullable: false });
});
