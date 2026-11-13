/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserMove1794574416544 {
	name = 'UserMove1794574416544'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "user_move" ("id" character varying(32) NOT NULL, "srcUserId" character varying(32) NOT NULL, "dstUserId" character varying(32) NOT NULL, CONSTRAINT "PK_55655c47cfedc271cf51be35b64" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_9f977af4dd8ace5e8877b736cd" ON "user_move" ("dstUserId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_176f34db2f729cbbfa92eec61c" ON "user_move" ("srcUserId", "dstUserId")`);
		await queryRunner.query(`ALTER TABLE "user_move" ADD CONSTRAINT "FK_69ba70a18899dcaef42282b4517" FOREIGN KEY ("srcUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "user_move" ADD CONSTRAINT "FK_9f977af4dd8ace5e8877b736cd5" FOREIGN KEY ("dstUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_move" DROP CONSTRAINT "FK_9f977af4dd8ace5e8877b736cd5"`);
		await queryRunner.query(`ALTER TABLE "user_move" DROP CONSTRAINT "FK_69ba70a18899dcaef42282b4517"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_176f34db2f729cbbfa92eec61c"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_9f977af4dd8ace5e8877b736cd"`);
		await queryRunner.query(`DROP TABLE "user_move"`);
	}
}
