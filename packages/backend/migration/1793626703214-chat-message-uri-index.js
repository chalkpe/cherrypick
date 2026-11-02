/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageUriIndex1793626703214 {
	name = 'ChatMessageUriIndex1793626703214'

	async up(queryRunner) {
		await queryRunner.query(`CREATE INDEX "IDX_f10847101444176c7fc3748b5f" ON "chat_message" ("uri") `);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_f10847101444176c7fc3748b5f"`);
	}
}
