/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChocoChannelColor1792217918286 {
	name = 'ChocoChannelColor1792217918286';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "channel" ALTER COLUMN "color" SET DEFAULT '#eab1b7'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "channel" ALTER COLUMN "color" SET DEFAULT '#ffbcdc'`);
	}
}
