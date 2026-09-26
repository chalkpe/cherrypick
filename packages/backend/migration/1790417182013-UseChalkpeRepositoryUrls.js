/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UseChalkpeRepositoryUrls1790417182013 {
    name = 'UseChalkpeRepositoryUrls1790417182013'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "repositoryUrl" SET DEFAULT 'https://github.com/chalkpe/cherrypick'`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT 'https://github.com/chalkpe/cherrypick/issues/new'`);
        await queryRunner.query(`UPDATE "meta" SET "repositoryUrl" = 'https://github.com/chalkpe/cherrypick' WHERE "repositoryUrl" = 'https://github.com/kokonect-link/cherrypick'`);
        await queryRunner.query(`UPDATE "meta" SET "feedbackUrl" = 'https://github.com/chalkpe/cherrypick/issues/new' WHERE "feedbackUrl" = 'https://github.com/kokonect-link/cherrypick/issues/new'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`UPDATE "meta" SET "feedbackUrl" = 'https://github.com/kokonect-link/cherrypick/issues/new' WHERE "feedbackUrl" = 'https://github.com/chalkpe/cherrypick/issues/new'`);
        await queryRunner.query(`UPDATE "meta" SET "repositoryUrl" = 'https://github.com/kokonect-link/cherrypick' WHERE "repositoryUrl" = 'https://github.com/chalkpe/cherrypick'`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT 'https://github.com/kokonect-link/cherrypick/issues/new'`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "repositoryUrl" SET DEFAULT 'https://github.com/kokonect-link/cherrypick'`);
    }
}
