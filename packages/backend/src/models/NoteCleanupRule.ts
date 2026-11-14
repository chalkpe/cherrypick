/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { CleanupCondition } from '@/core/NoteCleanupCondition.js';
import { MiUser } from './User.js';
import { id } from './util/id.js';

@Entity('note_cleanup_rule')
@Index(['userId', 'id'])
export class MiNoteCleanupRule {
	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public userId: string;

	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' })
	@JoinColumn()
	public user: MiUser | null;

	@Column('varchar', { length: 128 })
	public name: string;

	// 제품 생성 이름의 출처이며 사용자가 이름을 명시하면 null로 지운다.
	@Column('varchar', { length: 16, nullable: true })
	public defaultName: 'pinned' | 'favorite' | 'clip' | 'selfReaction' | 'age' | null;

	@Column('varchar', { length: 8 })
	public action: 'keep' | 'delete';

	@Column('boolean', { default: true })
	public enabled: boolean;

	@Column('boolean', { default: false })
	public automatic: boolean;

	@Column('boolean', { default: false })
	public automaticConfirmed: boolean;

	@Column('jsonb')
	public condition: CleanupCondition;

	// 사용자가 고칠 수 있는 참조·조건 오류만 저장한다. 일시 장애는 저장하지 않고 작업 재시도로 넘긴다.
	@Column('jsonb', { nullable: true })
	public lastError: { ruleId: string; code: string; path: string; message: string; referenceType?: string; referenceId?: string } | null;

	// 현재 오류에 대한 보호 실패 통지 접수 여부. 오류가 바뀌거나 해결되면 false로 돌아가 새 오류를 한 번 통지한다.
	@Column('boolean', { default: false })
	public protectionNotified: boolean;

	@Column('varchar', { length: 16, nullable: true })
	public legacy: 'age' | 'favorite' | null;
}

@Entity('note_cleanup_state')
export class MiNoteCleanupState {
	@PrimaryColumn(id())
	public userId: string;

	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' })
	@JoinColumn()
	public user: MiUser | null;

	// 지운 노트의 첨부 파일을 드라이브에 남길지. 끄면 다른 곳에서 쓰지 않는 파일만 지운다.
	@Column('boolean', { default: true })
	public keepDriveFiles: boolean;

	@Column({ ...id(), nullable: true })
	public cursor: string | null;

	@Index()
	@Column('timestamp with time zone', { default: () => "'1970-01-01 00:00:00+00'" })
	public lastRunAt: Date;

	// 수동 정리 요청의 대기 마커. 완료·종료 실패 때 지우고, 일시 실패·예산 대기는 커서를 남겨 다음 회차가 잇는다.
	@Column('jsonb', { nullable: true })
	public manualRequest: { ruleIds: string[]; cursor: string | null } | null;
}
