/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomInviteLink1794511405320 {
	name = 'ChatRoomInviteLink1794511405320'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "chat_room_invite_link" ("id" character varying(32) NOT NULL, "roomId" character varying(32) NOT NULL, "code" character varying(64) NOT NULL, CONSTRAINT "PK_bdf9afcefd22261167ea0ceb1c5" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05681221f851600872b4d0476a" ON "chat_room_invite_link" ("roomId") `);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dac94afd376a013b8126939e09" ON "chat_room_invite_link" ("code") `);
		await queryRunner.query(`ALTER TABLE "chat_room_invite_link" ADD CONSTRAINT "FK_05681221f851600872b4d0476a2" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_invite_link" DROP CONSTRAINT "FK_05681221f851600872b4d0476a2"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_dac94afd376a013b8126939e09"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_05681221f851600872b4d0476a"`);
		await queryRunner.query(`DROP TABLE "chat_room_invite_link"`);
	}
}
