/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomHistory1794509496796 {
	name = 'ChatRoomHistory1794509496796'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_message" ALTER COLUMN "fromUserId" DROP NOT NULL`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "archivedAuthor" jsonb`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "importedAt" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`ALTER TABLE "chat_message" ADD "unavailableFileCount" integer NOT NULL DEFAULT 0`);
		await queryRunner.query(`CREATE INDEX "IDX_d31e68c95b2699c91880c70945" ON "chat_message" ("toRoomId", "id") `);
		await queryRunner.query(`CREATE TABLE "chat_room_history_state" ("roomId" character varying(32) NOT NULL, "status" character varying(16) NOT NULL, "nextUri" character varying(2048), "pass" integer NOT NULL DEFAULT 0, "completedAt" TIMESTAMP WITH TIME ZONE, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_c978831f1156c5db701adc6d1fd" PRIMARY KEY ("roomId"))`);
		await queryRunner.query(`ALTER TABLE "chat_room_history_state" ADD CONSTRAINT "FK_c978831f1156c5db701adc6d1fd" FOREIGN KEY ("roomId") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_history_state" DROP CONSTRAINT "FK_c978831f1156c5db701adc6d1fd"`);
		await queryRunner.query(`DROP TABLE "chat_room_history_state"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_d31e68c95b2699c91880c70945"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "unavailableFileCount"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "importedAt"`);
		await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "archivedAuthor"`);
		// 이전 스키마는 작성자 없는 메시지를 담을 수 없다. 계정이 지워진 뒤 보존한 그룹 메시지는 되돌릴 때 지워진다.
		await queryRunner.query(`DELETE FROM "chat_message" WHERE "fromUserId" IS NULL`);
		await queryRunner.query(`ALTER TABLE "chat_message" ALTER COLUMN "fromUserId" SET NOT NULL`);
	}
}
