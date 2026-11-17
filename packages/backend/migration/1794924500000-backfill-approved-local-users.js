/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class BackfillApprovedLocalUsers1794924500000 {
	name = 'BackfillApprovedLocalUsers1794924500000'

	async up(queryRunner) {
		// 가입 승인 흐름을 거친 계정은 signupReason이 채워져 있다(빈 문자열 포함).
		// signupReason이 없는 로컬 계정은 승인 기능 도입 전부터 있던 계정이므로 승인 상태로 채운다.
		await queryRunner.query(`UPDATE "user" SET "approved" = true WHERE "host" IS NULL AND "approved" = false AND "signupReason" IS NULL`);
	}

	async down(queryRunner) {
		// 백필한 행을 구분할 수 없으므로 되돌리지 않는다.
	}
}
