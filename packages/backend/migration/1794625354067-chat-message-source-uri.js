/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageSourceUri1794625354067 {
	name = 'ChatMessageSourceUri1794625354067'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "sourceUri" character varying(512)`);
		await queryRunner.query(`CREATE INDEX "IDX_295f714a60324ebde009cc8b96" ON "chat_message" ("sourceUri")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_295f714a60324ebde009cc8b96"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "sourceUri"`);
	}
}