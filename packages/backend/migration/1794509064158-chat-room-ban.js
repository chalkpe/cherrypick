/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomBan1794509064158 {
	name = 'ChatRoomBan1794509064158'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "chat_room_ban" ("id" character varying(32) NOT NULL, "roomId" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, CONSTRAINT "PK_9135adb11e9c6c4d616e9b735ca" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_fb781fe03b11d631cad059a94e" ON "chat_room_ban" ("userId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9e2fc568ec67c3cb393236a78c" ON "chat_room_ban" ("roomId", "userId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_ban" ADD CONSTRAINT "FK_271f9113bc20626b405d7fcb4a2" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_ban" ADD CONSTRAINT "FK_fb781fe03b11d631cad059a94ef" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_ban" DROP CONSTRAINT "FK_fb781fe03b11d631cad059a94ef"`);
		await queryRunner.query(`ALTER TABLE "chat_room_ban" DROP CONSTRAINT "FK_271f9113bc20626b405d7fcb4a2"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_9e2fc568ec67c3cb393236a78c"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_fb781fe03b11d631cad059a94e"`);
		await queryRunner.query(`DROP TABLE "chat_room_ban"`);
	}
}
