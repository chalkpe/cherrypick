/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomChannelSections1794700000000 {
	name = 'ChatRoomChannelSections1794700000000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "chat_room_channel_section" ("id" character varying(32) NOT NULL, "roomId" character varying(32) NOT NULL, "name" character varying(4096) NOT NULL, "position" integer NOT NULL, "uri" character varying(1024), CONSTRAINT "PK_24e15ad2223e49e9a39ad122049" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_cec417134852417a28cdf1ef6b" ON "chat_room_channel_section" ("roomId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4b10382a08e8120e508aebd1f8" ON "chat_room_channel_section" ("uri")`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel" ADD "sectionId" character varying(32)`);
		await queryRunner.query(`CREATE INDEX "IDX_506391e9e4e260e462f017de72" ON "chat_room_channel" ("sectionId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel_section" ADD CONSTRAINT "FK_cec417134852417a28cdf1ef6b3" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel" ADD CONSTRAINT "FK_506391e9e4e260e462f017de72d" FOREIGN KEY ("sectionId") REFERENCES "chat_room_channel_section"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_channel" DROP CONSTRAINT "FK_506391e9e4e260e462f017de72d"`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel_section" DROP CONSTRAINT "FK_cec417134852417a28cdf1ef6b3"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_506391e9e4e260e462f017de72"`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel" DROP COLUMN "sectionId"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_4b10382a08e8120e508aebd1f8"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_cec417134852417a28cdf1ef6b"`);
		await queryRunner.query(`DROP TABLE "chat_room_channel_section"`);
	}
}
