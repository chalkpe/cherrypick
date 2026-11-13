/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteDeleteReceipt1794517809021 {
	name = 'NoteDeleteReceipt1794517809021';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "note_delete_receipt" (
			"noteId" varchar(32) NOT NULL,
			"userId" varchar(32) NOT NULL,
			"deletedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"quiet" boolean NOT NULL,
			"snapshot" jsonb NOT NULL,
			"effects" jsonb NOT NULL DEFAULT '{}',
			"attempts" integer NOT NULL DEFAULT 0,
			"nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"claimUntil" TIMESTAMP WITH TIME ZONE,
			"claimToken" varchar(128),
			"claimVersion" integer NOT NULL DEFAULT 0,
			"lastErrorCode" varchar(128),
			"completedAt" TIMESTAMP WITH TIME ZONE,
			CONSTRAINT "PK_note_delete_receipt" PRIMARY KEY ("noteId")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_note_delete_receipt_user" ON "note_delete_receipt" ("userId")`);
		await queryRunner.query(`CREATE INDEX "IDX_note_delete_receipt_retry" ON "note_delete_receipt" ("nextAttemptAt", "claimUntil")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "note_delete_receipt"`);
	}
}
