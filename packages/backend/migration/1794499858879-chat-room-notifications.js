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
		await queryRunner.query(`CREATE TABLE "chat_room_unread" ("userId" character varying(32) NOT NULL, "messageId" character varying(32) NOT NULL, "roomId" character varying(32) NOT NULL, "sequence" bigint NOT NULL, "isMention" boolean NOT NULL DEFAULT false, "notificationSent" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_02702aefd644b8459e9b3f24167" PRIMARY KEY ("userId", "messageId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_f52f42a2ee599a4cf2d95f0d61" ON "chat_room_unread" ("userId", "roomId")`);
		await queryRunner.query(`CREATE INDEX "IDX_ecf23aceb8fbe27a3a27159bb2" ON "chat_room_unread" ("messageId")`);
		await queryRunner.query(`CREATE INDEX "IDX_0f2a9554033d980455bffbd457" ON "chat_room_unread" ("roomId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_unread" ADD CONSTRAINT "FK_cc6dc11de8b6add0f49f4a8b235" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_unread" ADD CONSTRAINT "FK_0f2a9554033d980455bffbd4572" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_unread" ADD CONSTRAINT "FK_ecf23aceb8fbe27a3a27159bb2c" FOREIGN KEY ("messageId") REFERENCES "chat_message"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "messageSequence" bigint NOT NULL DEFAULT 0`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "roomMessageSequence" bigint`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "mentionedUserIds" character varying(32) array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`ALTER TABLE "chat_room_user_settings" ADD "membershipId" character varying(32)`);
		await queryRunner.query(`CREATE INDEX "IDX_e55b3b1f5ce26cd844625bb943" ON "chat_room_user_settings" ("membershipId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_user_settings" ADD CONSTRAINT "FK_e55b3b1f5ce26cd844625bb9439" FOREIGN KEY ("membershipId") REFERENCES "chat_room_membership"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_unread" ADD "membershipId" character varying(32)`);
		await queryRunner.query(`CREATE INDEX "IDX_cf9643acc17a17abe14a7bb82b" ON "chat_room_unread" ("membershipId")`);
		await queryRunner.query(`ALTER TABLE "chat_room_unread" ADD CONSTRAINT "FK_cf9643acc17a17abe14a7bb82b5" FOREIGN KEY ("membershipId") REFERENCES "chat_room_membership"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`INSERT INTO "chat_room_user_settings" ("userId", "roomId", "membershipId", "notificationLevel", "channelOverrides") SELECT "userId", "roomId", "id", 'none', '{}' FROM "chat_room_membership" WHERE "isMuted" = true`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "mentionedUserIds"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "roomMessageSequence"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "messageSequence"`);
		await queryRunner.query(`DROP TABLE "chat_room_unread"`);
		await queryRunner.query(`DROP TABLE "chat_room_user_settings"`);
	}
}
