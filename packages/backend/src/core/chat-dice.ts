/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { SchemaType } from '@/misc/json-schema.js';

export const DICE_ENGINE = '@dice-roller/rpg-dice-roller';
export const DICE_ENGINE_VERSION = '5.5.1';
export const DICE_MAX_NOTATION_BYTES = 512;
export const DICE_MAX_OUTPUT_BYTES = 12288;
export const DICE_MAX_RANDOM_DRAWS = 1024;
export const DICE_TIMEOUT_MS = 3000;

export const chatDiceResultSchema = {
	type: 'object',
	optional: false, nullable: false,
	additionalProperties: false,
	properties: {
		version: { type: 'number', optional: false, nullable: false, minimum: 1, maximum: 1 },
		engine: { type: 'string', optional: false, nullable: false, enum: [DICE_ENGINE] },
		engineVersion: { type: 'string', optional: false, nullable: false, maxLength: 32 },
		notation: { type: 'string', optional: false, nullable: false, minLength: 1, maxLength: DICE_MAX_NOTATION_BYTES },
		total: { type: 'number', optional: false, nullable: false, minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
		output: { type: 'string', optional: false, nullable: false, minLength: 1, maxLength: DICE_MAX_OUTPUT_BYTES },
	},
} as const;

export type ChatDiceResult = SchemaType<typeof chatDiceResultSchema>;

export class ChatDiceError extends Error {
	constructor(public readonly reason: 'invalid' | 'limit' | 'busy') {
		super(`dice ${reason}`);
	}
}

export function createChatDiceApiErrors(ids: { invalid: string; limit: string; busy: string }) {
	return {
		diceInvalid: { message: 'Invalid dice notation.', code: 'DICE_INVALID', id: ids.invalid },
		diceLimit: { message: 'The dice roll exceeds the execution limits.', code: 'DICE_LIMIT', id: ids.limit },
		diceBusy: { message: 'Dice rolling is busy. Please try again later.', code: 'DICE_BUSY', id: ids.busy },
	} as const;
}

export function chatDiceNotation(text: string | null | undefined): string | null {
	const command = text?.trim();
	if (command == null || !/^\/dice(?:\s|$)/.test(command)) return null;
	return command.slice(5).trim() || '1d6';
}

export function assertChatDiceNotation(notation: string): void {
	if (Buffer.byteLength(notation) > DICE_MAX_NOTATION_BYTES) throw new ChatDiceError('limit');
	// 엔진 5.5.1의 Comment 규칙과 같은 영역만 깊이 계산에서 제외하고, 원문은 그대로 엔진에 넘긴다.
	// 숫자식의 괄호는 엔진의 파싱 결과에서 사라지므로 깊이는 원문에서 검사한다.
	const expression = notation.replace(/\/\*[\s\S]*?\*\/|\[[^\]]*\]|(?:\/\/|#)[^\n\r\u2028\u2029]*/g, '');
	let depth = 0;
	// 문법은 엔진이 해석하고, 이 순회는 파서의 자원 사용 깊이만 제한한다.
	for (const character of expression) {
		if ('({'.includes(character)) depth++;
		if (')}'.includes(character)) depth = Math.max(0, depth - 1);
		if (depth > 32) throw new ChatDiceError('limit');
	}
}

export function parseChatDiceResult(value: unknown): ChatDiceResult | null {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const keys = Object.keys(value);
	if (keys.length !== 6 || !keys.every(key => Object.hasOwn(chatDiceResultSchema.properties, key))) return null;
	const v = value as Record<string, unknown>;
	if (v.version !== 1 || v.engine !== DICE_ENGINE) return null;
	if (typeof v.engineVersion !== 'string' || v.engineVersion.length > 32 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v.engineVersion)) return null;
	if (typeof v.notation !== 'string' || v.notation.length === 0 || !v.notation.isWellFormed() || v.notation.includes('\0') || Buffer.byteLength(v.notation) > DICE_MAX_NOTATION_BYTES) return null;
	if (typeof v.total !== 'number' || !Number.isFinite(v.total) || Math.abs(v.total) > Number.MAX_SAFE_INTEGER) return null;
	if (typeof v.output !== 'string' || v.output.length === 0 || !v.output.isWellFormed() || v.output.includes('\0') || Buffer.byteLength(v.output) > DICE_MAX_OUTPUT_BYTES) return null;
	const result: ChatDiceResult = { version: 1, engine: DICE_ENGINE, engineVersion: v.engineVersion, notation: v.notation, total: v.total, output: v.output };
	return Buffer.byteLength(JSON.stringify(result)) <= 16384 ? result : null;
}
