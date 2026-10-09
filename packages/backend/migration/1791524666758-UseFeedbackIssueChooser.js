/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UseFeedbackIssueChooser1791524666758 {
    name = 'UseFeedbackIssueChooser1791524666758'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT 'https://github.com/chalkpe/cherrypick/issues/new/choose'`);
        await queryRunner.query(`UPDATE "meta" SET "feedbackUrl" = 'https://github.com/chalkpe/cherrypick/issues/new/choose' WHERE "feedbackUrl" = 'https://github.com/chalkpe/cherrypick/issues/new'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`UPDATE "meta" SET "feedbackUrl" = 'https://github.com/chalkpe/cherrypick/issues/new' WHERE "feedbackUrl" = 'https://github.com/chalkpe/cherrypick/issues/new/choose'`);
        await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT 'https://github.com/chalkpe/cherrypick/issues/new'`);
    }
}
