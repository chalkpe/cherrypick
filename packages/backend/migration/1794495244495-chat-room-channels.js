/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomChannels1794495244495 {
	name = 'ChatRoomChannels1794495244495'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "chat_room_channel" ("id" character varying(32) NOT NULL, "roomId" character varying(32) NOT NULL, "name" character varying(4096) NOT NULL, "position" integer NOT NULL, "uri" character varying(1024), CONSTRAINT "PK_db99e1e402176e963f5310f7149" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_d08d8cea6a472825ac68b5d1b4" ON "chat_room_channel" ("roomId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_36039bf4fdfc6d1dc4b8fe7f5e" ON "chat_room_channel" ("uri")`);
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "hasChannels" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "legacyChannelId" character varying(32)`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "toRoomChannelId" character varying(32)`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "channelRefs" jsonb NOT NULL DEFAULT '[]'`);
		await queryRunner.query(`ALTER TABLE "instance" ADD "supportsChatRoomChannels" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`CREATE INDEX "IDX_f51b5536f74aeb33e4bee12a65" ON "chat_message" ("toRoomChannelId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel" ADD CONSTRAINT "FK_d08d8cea6a472825ac68b5d1b48" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room" ADD CONSTRAINT "FK_0ac48f0c35f798a91675ec8131a" FOREIGN KEY ("legacyChannelId") REFERENCES "chat_room_channel"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD CONSTRAINT "FK_f51b5536f74aeb33e4bee12a65f" FOREIGN KEY ("toRoomChannelId") REFERENCES "chat_room_channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" DROP CONSTRAINT "FK_f51b5536f74aeb33e4bee12a65f"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP CONSTRAINT "FK_0ac48f0c35f798a91675ec8131a"`);
		await queryRunner.query(`ALTER TABLE "chat_room_channel" DROP CONSTRAINT "FK_d08d8cea6a472825ac68b5d1b48"`);
		await queryRunner.query(`DROP INDEX "IDX_f51b5536f74aeb33e4bee12a65"`);
		await queryRunner.query(`ALTER TABLE "instance" DROP COLUMN "supportsChatRoomChannels"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "channelRefs"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "toRoomChannelId"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "legacyChannelId"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "hasChannels"`);
		await queryRunner.query(`DROP TABLE "chat_room_channel"`);
	}
}
