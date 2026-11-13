/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { CleanupCondition } from '@/core/NoteCleanupCondition.js';
import { MiUser } from './User.js';
import { id } from './util/id.js';

// 자료 오류는 실패한 페이지의 노트 ID를 항상 기록한다. 참조 오류는 남아 있던 자료 오류의 범위를 이어받을 수 있다.
export type NoteCleanupRecovery = { source: 'reference'; noteIds?: string[] } | { source: 'data'; noteIds: string[] };

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

	@Column('jsonb', { nullable: true })
	public lastError: { ruleId: string; code: string; path: string; message: string; referenceType?: string; referenceId?: string; userActionable: boolean; recovery: NoteCleanupRecovery } | null;

	// 오류 발생 세대와 최초 통지 접수 상태는 오류 본문과 별도로 보관한다. pendingSince는 저장 확인의 세대 기준 시각이다.
	@Column('jsonb', { nullable: true })
	public protectionNotification: { generation: number; identity: string | null; status: 'pending' | 'accepted' | 'suppressed' | 'resolved'; pendingSince?: number } | null;

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

	@Column('boolean', { default: false })
	public migrated: boolean;

	@Column({ ...id(), nullable: true })
	public cursor: string | null;

	@Index()
	@Column('timestamp with time zone', { default: () => "'1970-01-01 00:00:00+00'" })
	public lastRunAt: Date;

	@Column('varchar', { length: 64, nullable: true })
	public previewToken: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public previewAt: Date | null;
}
