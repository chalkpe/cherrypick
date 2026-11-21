/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageReply1795228148970 {
	name = 'ChatMessageReply1795228148970';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "replyToId" character varying(32)`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "replyToUri" character varying(512)`);
		await queryRunner.query(`CREATE INDEX "IDX_e87f74fc2f41b80635e686ec4f" ON "chat_message" ("replyToId")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_e87f74fc2f41b80635e686ec4f"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "replyToUri"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "replyToId"`);
	}
}
