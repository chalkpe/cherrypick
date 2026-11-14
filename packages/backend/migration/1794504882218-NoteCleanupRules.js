/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Table, TableIndex, TableForeignKey } from 'typeorm';

export class NoteCleanupRules1794504882218 {
	name = 'NoteCleanupRules1794504882218';

	async up(queryRunner) {
		await queryRunner.createTable(new Table({ name: 'note_cleanup_rule', columns: [
			{ name: 'id', type: 'varchar', length: '32', isPrimary: true },
			{ name: 'userId', type: 'varchar', length: '32' },
			{ name: 'name', type: 'varchar', length: '128' },
			{ name: 'defaultName', type: 'varchar', length: '16', isNullable: true },
			{ name: 'action', type: 'varchar', length: '8' },
			{ name: 'enabled', type: 'boolean', default: true },
			{ name: 'automatic', type: 'boolean', default: false },
			{ name: 'automaticConfirmed', type: 'boolean', default: false },
			{ name: 'condition', type: 'jsonb' },
			{ name: 'lastError', type: 'jsonb', isNullable: true },
			{ name: 'legacy', type: 'varchar', length: '16', isNullable: true },
		] }));
		await queryRunner.createIndex('note_cleanup_rule', new TableIndex({ columnNames: ['userId', 'id'] }));
		await queryRunner.createForeignKey('note_cleanup_rule', new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'user', referencedColumnNames: ['id'], onDelete: 'CASCADE' }));
		await queryRunner.createTable(new Table({ name: 'note_cleanup_state', columns: [
			{ name: 'userId', type: 'varchar', length: '32', isPrimary: true },
			{ name: 'migrated', type: 'boolean', default: false },
			{ name: 'keepDriveFiles', type: 'boolean', default: true },
			{ name: 'cursor', type: 'varchar', length: '32', isNullable: true },
			{ name: 'lastRunAt', type: 'timestamp with time zone', default: "'1970-01-01 00:00:00+00'" },
		] }));
		await queryRunner.createIndex('note_cleanup_state', new TableIndex({ columnNames: ['lastRunAt'] }));
		await queryRunner.createForeignKey('note_cleanup_state', new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'user', referencedColumnNames: ['id'], onDelete: 'CASCADE' }));
		// 기존 활성 설정은 보호 범위를 추가하지 않고 그대로 옮긴다.
		await queryRunner.query(`INSERT INTO note_cleanup_state ("userId", migrated) SELECT id, true FROM "user" WHERE host IS NULL`);
		// 이전 처리기는 기간이 null이거나 0 이하이면 지우지 않았으므로 양수 기간만 지우기 규칙으로 옮긴다.
		// integer 열끼리 곱하면 24856일 이상에서 integer 범위를 넘어 이관 전체가 실패하므로 bigint로 계산한다.
		await queryRunner.query(`INSERT INTO note_cleanup_rule (id, "userId", name, action, enabled, automatic, "automaticConfirmed", condition, legacy, "defaultName")
			SELECT md5('cleanup-age-' || id), id, '기간이 지난 내 글', 'delete', true, true, true,
			jsonb_build_object('type', 'age', 'operator', 'gt', 'seconds', "autoDeleteNotesAfterDays"::bigint * 86400), 'age', 'age'
			FROM "user" WHERE host IS NULL AND "autoDeleteNotesAfterDays" > 0`);
		await queryRunner.query(`INSERT INTO note_cleanup_rule (id, "userId", name, action, enabled, automatic, "automaticConfirmed", condition, legacy, "defaultName")
			SELECT md5('cleanup-favorite-' || id), id, '내가 즐겨찾기한 내 글', 'keep', "autoDeleteKeepFavorites", false, false,
			'{"type":"flag","field":"favorite","value":true}'::jsonb, 'favorite', 'favorite'
			FROM "user" WHERE host IS NULL`);
	}

	async down(queryRunner) {
		await queryRunner.dropTable('note_cleanup_state');
		await queryRunner.dropTable('note_cleanup_rule');
	}
}
