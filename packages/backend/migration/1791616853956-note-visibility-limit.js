/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteVisibilityLimit1791616853956 {
	name = 'NoteVisibilityLimit1791616853956';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "noteVisibilityLimit" character varying(16) NOT NULL DEFAULT 'none'`);
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "user_profile" DROP COLUMN "noteVisibilityLimit"');
	}
}
