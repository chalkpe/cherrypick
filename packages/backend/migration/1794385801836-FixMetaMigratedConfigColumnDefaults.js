/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 공식 Misskey에서 설정 이관 시 남은 DEFAULT를 엔티티와 맞춘다. 기존 행의 값은 바꾸지 않는다.
 * CherryPick의 기존 이관 migration은 세 DEFAULT를 모두 true로 만들었으므로, 되돌릴 때도 그 값을 보존한다.
 */
export class FixMetaMigratedConfigColumnDefaults1794385801836 {
    name = 'FixMetaMigratedConfigColumnDefaults1794385801836'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "proxyRemoteFiles" SET DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "signToActivityPubGet" SET DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "allowExternalApRedirect" SET DEFAULT true`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "allowExternalApRedirect" SET DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "signToActivityPubGet" SET DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "proxyRemoteFiles" SET DEFAULT true`);
    }
}
