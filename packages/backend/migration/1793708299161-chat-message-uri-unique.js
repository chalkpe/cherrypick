/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatMessageUriUnique1793708299161 {
	name = 'ChatMessageUriUnique1793708299161'

	async up(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_f10847101444176c7fc3748b5f"`);
		// Keep every message. A later copy of the same URI only loses the URI that it shares with the oldest one.
		await queryRunner.query(`
			UPDATE "chat_message" SET "uri" = NULL WHERE "id" IN (
				SELECT "id" FROM (
					SELECT "id", ROW_NUMBER() OVER (PARTITION BY "uri" ORDER BY "id") AS "position"
					FROM "chat_message" WHERE "uri" IS NOT NULL
				) AS "numbered" WHERE "position" > 1
			)
		`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f10847101444176c7fc3748b5f" ON "chat_message" ("uri") `);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_f10847101444176c7fc3748b5f"`);
		await queryRunner.query(`CREATE INDEX "IDX_f10847101444176c7fc3748b5f" ON "chat_message" ("uri") `);
	}
}
