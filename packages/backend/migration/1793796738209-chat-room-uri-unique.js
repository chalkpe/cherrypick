/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomUriUnique1793796738209 {
	name = 'ChatRoomUriUnique1793796738209'

	async up(queryRunner) {
		// Rooms are looked up by URI. Until now the number in the URI was the ID of the row, so no two rows can share one.
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5319641e27338da87aa00d3b1d" ON "chat_room" ("uri") `);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_5319641e27338da87aa00d3b1d"`);
	}
}
