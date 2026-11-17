/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class CallRecordingSettings1794416788916 {
	name = 'CallRecordingSettings1794416788916';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "allowRecording" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallMaxRecordingConversions" integer NOT NULL DEFAULT 2`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallMaxRecordingConversions"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "allowRecording"`);
	}
}
