/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';

export type NoteDeleteDeliveryChannel = 'followers' | 'direct' | 'relay';

// 노트·사용자·영수증 삭제가 미완료 의무를 함께 지우지 않도록 FK를 두지 않는다.
@Entity('note_delete_delivery')
@Index('IDX_note_delete_delivery_retry', ['nextAttemptAt', 'claimUntil'])
@Index('IDX_note_delete_delivery_owner', ['ownerUserId'])
export class MiNoteDeleteDelivery {
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_note_delete_delivery' })
	public receiptNoteId: string;

	@PrimaryColumn('varchar', { length: 16, primaryKeyConstraintName: 'PK_note_delete_delivery' })
	public channel: NoteDeleteDeliveryChannel;

	@PrimaryColumn('varchar', { length: 64, primaryKeyConstraintName: 'PK_note_delete_delivery' })
	public targetKey: string;

	@Column(id())
	public ownerUserId: string;

	@Column('text', { nullable: true })
	public endpoint: string | null;

	@Column('boolean', { nullable: true })
	public isSharedInbox: boolean | null;

	@Column('varchar', { length: 32, nullable: true })
	public relayId: string | null;

	@Column('varchar', { length: 16, nullable: true })
	public payloadRef: 'activity' | 'relaySigned' | null;

	@Column('varchar', { length: 32, default: 'pending' })
	public state: 'pending' | 'running' | 'delivered' | 'skipped' | 'permanentFailed';

	@Column('integer', { default: 0 })
	public generation: number;

	@Column('integer', { default: 0 })
	public attempts: number;

	@Column('integer', { default: 0 })
	public claimVersion: number;

	@Column('varchar', { length: 128, nullable: true })
	public claimToken: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public claimUntil: Date | null;

	@Column('timestamp with time zone')
	public nextAttemptAt: Date;

	@Column('varchar', { length: 128, nullable: true })
	public lastErrorCode: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public settledAt: Date | null;
}
