/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteCleanupProtectionNotification1794531297191 {
    name = 'NoteCleanupProtectionNotification1794531297191';

    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "note_cleanup_rule" ADD "protectionNotified" boolean NOT NULL DEFAULT false');
    }

    async down(queryRunner) {
        await queryRunner.query('ALTER TABLE "note_cleanup_rule" DROP COLUMN "protectionNotified"');
    }
}
