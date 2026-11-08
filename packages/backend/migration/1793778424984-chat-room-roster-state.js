/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomRosterState1793778424984 {
	name = 'ChatRoomRosterState1793778424984'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "chat_room_roster_state" ("roomId" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, "lastRosterAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastMemberAt" TIMESTAMP WITH TIME ZONE, "acceptedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6089ef79d5429733fec5217a7a7" PRIMARY KEY ("roomId", "userId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_afb99818d36fb80feee2f91df2" ON "chat_room_roster_state" ("userId") `);
		await queryRunner.query(`ALTER TABLE "chat_room_roster_state" ADD CONSTRAINT "FK_a94dcf5eeb15f9cb7d2765e2ce7" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "chat_room_roster_state" ADD CONSTRAINT "FK_afb99818d36fb80feee2f91df23" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_roster_state" DROP CONSTRAINT "FK_afb99818d36fb80feee2f91df23"`);
		await queryRunner.query(`ALTER TABLE "chat_room_roster_state" DROP CONSTRAINT "FK_a94dcf5eeb15f9cb7d2765e2ce7"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_afb99818d36fb80feee2f91df2"`);
		await queryRunner.query(`DROP TABLE "chat_room_roster_state"`);
	}
}
