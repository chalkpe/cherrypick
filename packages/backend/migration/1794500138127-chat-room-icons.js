/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomIcons1794500138127 {
    name = 'ChatRoomIcons1794500138127';

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "chat_room" ADD "iconId" character varying(32), ADD "iconUrl" character varying(1024), ADD "iconBlurhash" character varying(128), ADD "iconDecorations" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`CREATE INDEX "IDX_b82a401d0a64a11d112677a401" ON "chat_room" ("iconId")`);
        await queryRunner.query(`ALTER TABLE "chat_room" ADD CONSTRAINT "FK_b82a401d0a64a11d112677a401c" FOREIGN KEY ("iconId") REFERENCES "drive_file"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "chat_room" DROP CONSTRAINT "FK_b82a401d0a64a11d112677a401c"`);
        await queryRunner.query(`DROP INDEX "IDX_b82a401d0a64a11d112677a401"`);
        await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "iconDecorations", DROP COLUMN "iconBlurhash", DROP COLUMN "iconUrl", DROP COLUMN "iconId"`);
    }
}
