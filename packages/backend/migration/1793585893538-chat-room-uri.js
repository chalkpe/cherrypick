/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomUri1793585893538 {
	name = 'ChatRoomUri1793585893538'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "uri" character varying(512)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "uri"`);
	}
}
