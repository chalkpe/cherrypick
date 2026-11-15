/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomMutedByOwner1794488088343 {
	name = 'ChatRoomMutedByOwner1794488088343'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "isMutedByOwner" boolean NOT NULL DEFAULT false`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "isMutedByOwner"`);
	}
}
