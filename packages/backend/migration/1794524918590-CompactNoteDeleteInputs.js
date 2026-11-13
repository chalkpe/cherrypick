/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class CompactNoteDeleteInputs1794524918590 {
	name = 'CompactNoteDeleteInputs1794524918590';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_delete_delivery"
			ALTER COLUMN "endpoint" DROP NOT NULL,
			ALTER COLUMN "isSharedInbox" DROP NOT NULL,
			ALTER COLUMN "payloadRef" DROP NOT NULL`);
	}

	async down(queryRunner) {
		// 원본 입력을 재생성하지 않는다. 요약이 보존된 종료 행만 제거한다.
		// 미완료·불명확한 null 입력은 NOT NULL 복원 실패로 전체 transaction에 남긴다.
		await queryRunner.query(`LOCK TABLE "note_delete_delivery" IN ACCESS EXCLUSIVE MODE`);
		await queryRunner.query(`DELETE FROM "note_delete_delivery" AS delivery
			USING "note_delete_receipt" AS receipt
			WHERE delivery."receiptNoteId" = receipt."noteId" AND delivery."ownerUserId" = receipt."userId"
			AND delivery."state" IN ('delivered', 'skipped', 'permanentFailed') AND delivery."settledAt" IS NOT NULL
			AND ((receipt."completedAt" IS NOT NULL AND receipt."snapshot" @> '{"version":2,"state":"settled"}'::jsonb)
				OR receipt."snapshot" @> '{"version":3,"state":"delivery_settled","delivery":null}'::jsonb)
			AND receipt."effects"->'activityPub'->'summary'->>'unfinished' = '0'
			AND delivery."endpoint" IS NULL AND delivery."isSharedInbox" IS NULL AND delivery."payloadRef" IS NULL`);
		await queryRunner.query(`ALTER TABLE "note_delete_delivery"
			ALTER COLUMN "endpoint" SET NOT NULL,
			ALTER COLUMN "isSharedInbox" SET NOT NULL,
			ALTER COLUMN "payloadRef" SET NOT NULL`);
	}
}
