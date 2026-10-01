/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AddSupportsAvatarDecorationsToInstance1790853820624 {
    name = 'AddSupportsAvatarDecorationsToInstance1790853820624';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "instance" ADD "supportsAvatarDecorations" boolean NOT NULL DEFAULT false');
        await queryRunner.query('COMMENT ON COLUMN "instance"."supportsAvatarDecorations" IS \'Whether the Instance advertises avatar decorations in its NodeInfo.\'');
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query('ALTER TABLE "instance" DROP COLUMN "supportsAvatarDecorations"');
    }
};
