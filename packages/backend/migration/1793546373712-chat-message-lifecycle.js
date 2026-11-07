/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageLifecycle1793546373712 {
	name = 'ChatMessageLifecycle1793546373712'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "editedAt" timestamp with time zone`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "deletedAt" timestamp with time zone`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "deletedAt"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "editedAt"`);
	}
}