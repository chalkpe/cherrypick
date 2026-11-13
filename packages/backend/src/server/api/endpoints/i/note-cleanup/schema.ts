/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const ruleInputProperties = {
	name: { type: 'string', minLength: 1, maxLength: 128 },
	action: { type: 'string', enum: ['keep', 'delete'] },
	condition: { type: 'object', additionalProperties: true },
	enabled: { type: 'boolean' },
	automatic: { type: 'boolean' },
	confirmed: { type: 'boolean' },
	previewToken: { type: 'string', maxLength: 64 },
} as const;
export const ruleIdsProperty = { type: 'array', minItems: 1, maxItems: 34, uniqueItems: true, items: { type: 'string', format: 'misskey:id' } } as const;
