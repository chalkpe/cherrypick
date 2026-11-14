/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomNotifications1794499858879 {
	name = 'ChatRoomNotifications1794499858879'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "chat_room_user_settings" ("userId" character varying(32) NOT NULL, "roomId" character varying(32) NOT NULL, "notificationLevel" character varying(16) NOT NULL DEFAULT 'all', "channelOverrides" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_6d3ab0d24dd656876c3271cf4f9" PRIMARY KEY ("userId", "roomId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_2e14d7e96efeae2911139e7e14" ON "chat_room_user_settings" ("roomId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_user_settings" ADD CONSTRAINT "FK_175cda836b9a3c4a1f41f725187" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_user_settings" ADD CONSTRAINT "FK_2e14d7e96efeae2911139e7e148" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "messageSequence" bigint NOT NULL DEFAULT 0`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "roomMessageSequence" bigint`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "mentionedUserIds" character varying(32) array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`ALTER TABLE "chat_room_user_settings" ADD "membershipId" character varying(32)`);
		await queryRunner.query(`CREATE INDEX "IDX_e55b3b1f5ce26cd844625bb943" ON "chat_room_user_settings" ("membershipId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_user_settings" ADD CONSTRAINT "FK_e55b3b1f5ce26cd844625bb9439" FOREIGN KEY ("membershipId") REFERENCES "chat_room_membership"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`INSERT INTO "chat_room_user_settings" ("userId", "roomId", "membershipId", "notificationLevel", "channelOverrides") SELECT "userId", "roomId", "id", 'none', '{}' FROM "chat_room_membership" WHERE "isMuted" = true`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "mentionedUserIds"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "roomMessageSequence"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "messageSequence"`);
		await queryRunner.query(`DROP TABLE "chat_room_user_settings"`);
	}
}
