/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageDice1794406606731 {
	name = 'ChatMessageDice1794406606731';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "chat_message" ADD "dice" jsonb');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "chat_message" DROP COLUMN "dice"');
	}
}
