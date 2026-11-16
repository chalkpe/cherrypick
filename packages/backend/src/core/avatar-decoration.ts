/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiUser } from '@/models/User.js';

export const avatarDecorationsSchema = { type: 'array', maxItems: 16, items: {
	type: 'object',
	properties: {
		id: { type: 'string', format: 'misskey:id' },
		angle: { type: 'number', nullable: true, maximum: 0.5, minimum: -0.5 },
		flipH: { type: 'boolean', nullable: true },
		offsetX: { type: 'number', nullable: true, maximum: 0.25, minimum: -0.25 },
		offsetY: { type: 'number', nullable: true, maximum: 0.25, minimum: -0.25 },
		scale: { type: 'number', nullable: true, maximum: 1.5, minimum: 0.5 },
		opacity: { type: 'number', nullable: true, maximum: 1, minimum: 0.1 },
	},
	required: ['id'],
} } as const;

export function normalizeAvatarDecoration(d: { [K in keyof MiUser['avatarDecorations'][number]]: MiUser['avatarDecorations'][number][K] | null } & { id: string }): Required<MiUser['avatarDecorations'][number]> {
	return { id: d.id, angle: d.angle ?? 0, flipH: d.flipH ?? false, offsetX: d.offsetX ?? 0, offsetY: d.offsetY ?? 0, scale: d.scale ?? 1, opacity: d.opacity ?? 1 };
}

export function usableAvatarDecorationIds(decorations: { id: string; roleIdsThatCanBeUsedThisDecoration: string[] }[], roles: { id: string }[], allRoles: { id: string }[]): string[] {
	return decorations.filter(d => d.roleIdsThatCanBeUsedThisDecoration.filter(id => allRoles.some(r => r.id === id)).length === 0 || roles.some(r => d.roleIdsThatCanBeUsedThisDecoration.includes(r.id))).map(d => d.id);
}
