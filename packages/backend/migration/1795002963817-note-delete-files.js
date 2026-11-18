/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteDeleteFiles1795002963817 {
	name = 'NoteDeleteFiles1795002963817';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "autoDeleteNoteFiles" boolean NOT NULL DEFAULT false`);
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "user_profile" DROP COLUMN "autoDeleteNoteFiles"');
	}
}
