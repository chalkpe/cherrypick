/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteVoiceCall1793023791092 {
	name = 'RemoteVoiceCall1793023791092';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "enableRemoteVoiceCall" boolean NOT NULL DEFAULT true`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableRemoteVoiceCall"`);
	}
}
