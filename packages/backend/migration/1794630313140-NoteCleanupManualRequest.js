/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteCleanupManualRequest1794630313140 {
    name = 'NoteCleanupManualRequest1794630313140';

    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "note_cleanup_state" ADD "manualRequest" jsonb');
    }

    async down(queryRunner) {
        await queryRunner.query('ALTER TABLE "note_cleanup_state" DROP COLUMN "manualRequest"');
    }
}