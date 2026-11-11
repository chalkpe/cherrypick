/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { DiceRoll, NumberGenerator } from '@dice-roller/rpg-dice-roller';
import { assertChatDiceNotation, ChatDiceError, DICE_ENGINE, DICE_ENGINE_VERSION, DICE_MAX_RANDOM_DRAWS, parseChatDiceResult } from './chat-dice.js';

let draws = 0;
// 공식 engine.next() 인터페이스를 사용하고, 난수원 실패 시 전체 계산을 실패시킨다.
NumberGenerator.generator.engine = {
	next() {
		if (++draws > DICE_MAX_RANDOM_DRAWS) throw new ChatDiceError('limit');
		try {
			return randomBytes(4).readInt32LE(0);
		} catch {
			throw new ChatDiceError('busy');
		}
	},
};

process.once('message', (notation: unknown) => {
	try {
		if (typeof notation !== 'string') throw new ChatDiceError('invalid');
		assertChatDiceNotation(notation);
		const roll = new DiceRoll(notation);
		// export/toJSON은 min/max를 추가로 계산하므로 사용하지 않는다.
		const result = parseChatDiceResult({ version: 1, engine: DICE_ENGINE, engineVersion: DICE_ENGINE_VERSION, notation: roll.notation, total: roll.total, output: roll.output });
		if (result == null) throw new ChatDiceError('limit');
		process.send?.({ result }, () => process.disconnect?.());
	} catch (err) {
		process.send?.({ error: err instanceof ChatDiceError ? err.reason : 'invalid' }, () => process.disconnect?.());
	}
});
