/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageFileIds1793778835307 {
	name = 'ChatMessageFileIds1793778835307'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "fileIds" character varying(32) array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`UPDATE "chat_message" SET "fileIds" = ARRAY["fileId"] WHERE "fileId" IS NOT NULL`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP CONSTRAINT "FK_fd0f9a4879430239715ad4f8e2a"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "fileId"`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "fileId" character varying(32)`);
		// The older column holds one file and refers to it, so it takes the first attachment that still exists.
		await queryRunner.query(`
			UPDATE "chat_message" SET "fileId" = (
				SELECT "file"."id" FROM unnest("chat_message"."fileIds") WITH ORDINALITY AS "attached"("id", "position")
				JOIN "drive_file" "file" ON "file"."id" = "attached"."id"
				ORDER BY "attached"."position" LIMIT 1
			) WHERE cardinality("fileIds") > 0
		`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD CONSTRAINT "FK_fd0f9a4879430239715ad4f8e2a" FOREIGN KEY ("fileId") REFERENCES "drive_file"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "fileIds"`);
	}
}
