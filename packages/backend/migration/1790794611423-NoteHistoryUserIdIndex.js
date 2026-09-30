/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteHistoryUserIdIndex1790794611423 {
	name = 'NoteHistoryUserIdIndex1790794611423';

	async up(queryRunner) {
		await queryRunner.query('CREATE INDEX "IDX_95a9f7f6939a5cd4ec5d84979a" ON "note_history" ("userId") ');
	}

	async down(queryRunner) {
		await queryRunner.query('DROP INDEX "public"."IDX_95a9f7f6939a5cd4ec5d84979a"');
	}
}
