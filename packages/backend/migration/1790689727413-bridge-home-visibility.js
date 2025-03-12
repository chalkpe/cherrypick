/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class BridgeHomeVisibility1790689727413 {
	name = 'BridgeHomeVisibility1790689727413';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "user_profile" ADD "bridgeHomeVisibility" boolean NOT NULL DEFAULT false');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "user_profile" DROP COLUMN "bridgeHomeVisibility"');
	}
}
