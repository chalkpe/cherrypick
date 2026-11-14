/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatAuthorRetention1794579800799 {
	name = 'ChatAuthorRetention1794579800799'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "iconFileId" character varying(32)`);
		await queryRunner.query(`UPDATE "chat_room" SET "iconFileId" = "iconId"`);
		await queryRunner.query(`CREATE INDEX "IDX_5def33f6e2395072f366f3c1d6" ON "chat_room" ("iconFileId")`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "directFromUserId" character varying(32)`);
		await queryRunner.query(`UPDATE "chat_message" SET "directFromUserId" = "fromUserId" WHERE "toRoomId" IS NULL`);
		await queryRunner.query(`UPDATE "chat_message" m SET "archivedAuthor" = jsonb_build_object('uri', COALESCE(u."uri", '/users/' || u."id"), 'username', u."username", 'name', u."name", 'host', u."host") FROM "user" u WHERE m."toRoomId" IS NOT NULL AND m."fromUserId" = u."id" AND m."archivedAuthor" IS NULL`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP CONSTRAINT "FK_79a26e7a4d9afa5e4fc05f134ed"`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD CONSTRAINT "FK_79a26e7a4d9afa5e4fc05f134ed" FOREIGN KEY ("fromUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD CONSTRAINT "FK_3d29b5e7abe1a6b7f0fa4128739" FOREIGN KEY ("directFromUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`CREATE INDEX "IDX_3d29b5e7abe1a6b7f0fa412873" ON "chat_message" ("directFromUserId")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_3d29b5e7abe1a6b7f0fa412873"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP CONSTRAINT "FK_3d29b5e7abe1a6b7f0fa4128739"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP CONSTRAINT "FK_79a26e7a4d9afa5e4fc05f134ed"`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD CONSTRAINT "FK_79a26e7a4d9afa5e4fc05f134ed" FOREIGN KEY ("fromUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "directFromUserId"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_5def33f6e2395072f366f3c1d6"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "iconFileId"`);
	}
}
