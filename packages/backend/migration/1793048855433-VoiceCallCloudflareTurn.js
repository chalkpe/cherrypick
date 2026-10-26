/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class VoiceCallCloudflareTurn1793048855433 {
	name = 'VoiceCallCloudflareTurn1793048855433';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallCloudflareTurnKeyId" character varying(128)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallCloudflareTurnApiToken" character varying(512)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallCloudflareTurnApiToken"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallCloudflareTurnKeyId"`);
	}
}
