/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AddNodeinfoVersionToInstance1790851937316 {
    name = 'AddNodeinfoVersionToInstance1790851937316';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "instance" ADD "nodeinfoVersion" character varying(8)');
        await queryRunner.query('COMMENT ON COLUMN "instance"."nodeinfoVersion" IS \'The newest NodeInfo schema version the Instance provides.\'');
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query('ALTER TABLE "instance" DROP COLUMN "nodeinfoVersion"');
    }
};
