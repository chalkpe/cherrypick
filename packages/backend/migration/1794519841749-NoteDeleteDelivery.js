/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteDeleteDelivery1794519841749 {
	name = 'NoteDeleteDelivery1794519841749';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "note_delete_delivery" (
			"receiptNoteId" varchar(32) NOT NULL,
			"channel" varchar(16) NOT NULL,
			"targetKey" varchar(64) NOT NULL,
			"ownerUserId" varchar(32) NOT NULL,
			"endpoint" text NOT NULL,
			"isSharedInbox" boolean NOT NULL,
			"relayId" varchar(32),
			"payloadRef" varchar(16) NOT NULL,
			"state" varchar(32) NOT NULL DEFAULT 'pending',
			"generation" integer NOT NULL DEFAULT 0,
			"attempts" integer NOT NULL DEFAULT 0,
			"claimVersion" integer NOT NULL DEFAULT 0,
			"claimToken" varchar(128),
			"claimUntil" TIMESTAMP WITH TIME ZONE,
			"nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"lastErrorCode" varchar(128),
			"settledAt" TIMESTAMP WITH TIME ZONE,
			CONSTRAINT "PK_note_delete_delivery" PRIMARY KEY ("receiptNoteId", "channel", "targetKey")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_note_delete_delivery_owner" ON "note_delete_delivery" ("ownerUserId")`);
		await queryRunner.query(`CREATE INDEX "IDX_note_delete_delivery_retry" ON "note_delete_delivery" ("nextAttemptAt", "claimUntil")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "note_delete_delivery"`);
	}
}
