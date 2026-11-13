/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export const cleanupErrorSchema = {
	type: 'object', nullable: false, optional: false,
	properties: {
		ruleId: { type: 'string', optional: false, nullable: false },
		code: { type: 'string', optional: false, nullable: false },
		path: { type: 'string', optional: false, nullable: false },
		message: { type: 'string', optional: false, nullable: false },
		userActionable: { type: 'boolean', optional: false, nullable: false },
		referenceId: { type: 'string', optional: true, nullable: false },
		referenceType: { type: 'string', optional: true, nullable: false },
	},
} as const;
export const cleanupDefaultNameSchema = { type: 'string', enum: ['pinned', 'favorite', 'clip', 'selfReaction', 'age'], optional: false, nullable: true } as const;
export const packedNoteCleanupRuleSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		id: { type: 'string', optional: false, nullable: false },
		name: { type: 'string', optional: false, nullable: false },
		defaultName: cleanupDefaultNameSchema,
		action: { type: 'string', enum: ['keep', 'delete'], optional: false, nullable: false },
		enabled: { type: 'boolean', optional: false, nullable: false },
		automatic: { type: 'boolean', optional: false, nullable: false },
		automaticConfirmed: { type: 'boolean', optional: false, nullable: false },
		condition: { type: 'object', additionalProperties: true, optional: false, nullable: false },
		lastError: { ...cleanupErrorSchema, nullable: true },
		legacy: { type: 'string', enum: ['age', 'favorite'], optional: false, nullable: true },
	},
} as const;
