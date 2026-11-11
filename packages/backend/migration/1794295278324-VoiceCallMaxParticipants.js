/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class VoiceCallMaxParticipants1794295278324 {
	name = 'VoiceCallMaxParticipants1794295278324';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallMaxParticipants" integer NOT NULL DEFAULT 10`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallLivekitSource" character varying(16) NOT NULL DEFAULT 'yaml'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallLivekitUrl" character varying(2048)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallLivekitApiKey" character varying(512)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallLivekitApiSecret" character varying(512)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "voiceCallPreferRelay" boolean`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallPreferRelay"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallLivekitApiSecret"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallLivekitApiKey"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallLivekitUrl"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallLivekitSource"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "voiceCallMaxParticipants"`);
	}
}
