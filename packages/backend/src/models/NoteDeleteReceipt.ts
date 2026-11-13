/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { MiNote } from './Note.js';
import type { MiUser } from './User.js';
import { id } from './util/id.js';

export type NoteDeleteActorSnapshot = Pick<MiUser, 'id' | 'host'>;
export type NoteDeleteDeleterSnapshot = Pick<MiUser, 'id'>;
export type NoteDeleteAuditNoteSnapshot = Pick<MiNote,
	'id' | 'userId' | 'userHost' | 'uri' | 'text' | 'cw' | 'visibility' | 'localOnly' |
	'replyId' | 'renoteId' | 'replyUserId' | 'replyUserHost' | 'renoteUserId' | 'renoteUserHost' |
	'fileIds' | 'attachedFileTypes' | 'hasPoll' | 'channelId' | 'visibleUserIds' |
	'mentions' | 'mentionedRemoteUsers' | 'tags' | 'emojis' | 'deliveryTargets'> & { updatedAt: string | null };

export type NoteDeleteChartClassification = {
	userHost: MiNote['userHost'];
	hasReply: boolean;
	hasRenote: boolean;
	hasFile: boolean;
};

export type NoteDeleteNoteSnapshot = Pick<MiNote, 'id' | 'userId' | 'visibility'> & NoteDeleteChartClassification;
export type NoteDeleteStreamSnapshot = Pick<MiNote, 'visibleUserIds' | 'mentions' | 'replyUserId'>;

export type NoteDeleteChartTargets = {
	version: 1;
	notes: boolean;
	perUser: string | null;
	instance: string | null;
};

export type NoteDeletePayload = { content: string; digest: string };
export type NoteDeleteDeliveryTarget = { targetKey: string; endpoint: string; isSharedInbox: boolean };
export type NoteDeleteDeliveryPlan = {
	version: 2;
	reason: 'federated' | 'quiet' | 'remote' | 'localOnly';
	followers: NoteDeleteDeliveryTarget[];
	directTargets: NoteDeleteDeliveryTarget[];
	relays: (NoteDeleteDeliveryTarget & { relayId: string })[];
	activity: NoteDeletePayload | null;
	relayUnsigned: NoteDeletePayload | null;
	relaySigned: NoteDeletePayload | null;
};

export type NoteDeleteSnapshot = {
	version: 1;
	actor: NoteDeleteActorSnapshot;
	deleter: NoteDeleteDeleterSnapshot | null;
	author: Pick<MiUser, 'username' | 'host'> | null;
	note: NoteDeleteNoteSnapshot;
	stream: NoteDeleteStreamSnapshot | null;
	auditNote: NoteDeleteAuditNoteSnapshot | null;
	charts: NoteDeleteChartTargets;
	// 삭제 시점의 로컬 의무를 보존한다.
	localPlan?: Record<Exclude<keyof NoteDeleteEffects, 'charts'>, boolean>;
	// 전송 문자열은 JSONB 객체를 다시 직렬화하지 않고 그대로 사용한다.
	delivery: NoteDeleteDeliveryPlan;
};

// 종료 입력은 식별자·결과·fencing을 영수증 열에만 남긴다.
export type NoteDeleteSettledSnapshot = { version: 2; state: 'settled' };
export type NoteDeleteDeliverySettledSnapshot = Omit<NoteDeleteSnapshot, 'version' | 'delivery'> & { version: 3; state: 'delivery_settled'; delivery: null };
export type NoteDeleteLocalSnapshot = NoteDeleteSnapshot | NoteDeleteDeliverySettledSnapshot;
export type RecoverableNoteDeleteReceipt = MiNoteDeleteReceipt & { snapshot: NoteDeleteLocalSnapshot };

export function isDeliverySettledNoteDeleteReceipt(receipt: MiNoteDeleteReceipt): boolean {
	return isSettledNoteDeleteReceipt(receipt) || (receipt.snapshot.version === 3 && receipt.snapshot.state === 'delivery_settled' && receipt.snapshot.delivery === null);
}

export function isSettledNoteDeleteReceipt(receipt: MiNoteDeleteReceipt): boolean {
	return receipt.completedAt != null || (receipt.snapshot.version === 2 && receipt.snapshot.state === 'settled');
}

export type NoteDeleteEffects = Partial<Record<
	'noteStream' | 'notesChart' | 'perUserNotesChart' | 'instanceStats' | 'instanceChart' |
	'search' | 'moderationLog' | 'activityPub' | 'charts',
	{ completedAt: string; bucketAt?: string; outcome?: 'applied' | 'excluded' | 'delivered' | 'skipped' | 'permanentFailed'; summary?: { unfinished: number; delivered: number; skipped: number; permanentFailed: number }; reason?: 'quiet' | 'settings' | 'local' | 'subject_deleted' }
>>;

// 삭제된 노트와 사용자의 수명에 종속되지 않는 후처리 영수증이다.
@Entity('note_delete_receipt')
@Index('IDX_note_delete_receipt_retry', ['nextAttemptAt', 'claimUntil'])
export class MiNoteDeleteReceipt {
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_note_delete_receipt' })
	public noteId: string;

	@Index('IDX_note_delete_receipt_user')
	@Column(id())
	public userId: string;

	@Column('timestamp with time zone')
	public deletedAt: Date;

	@Column('boolean')
	public quiet: boolean;

	@Column('jsonb')
	public snapshot: NoteDeleteLocalSnapshot | NoteDeleteSettledSnapshot;

	@Column('jsonb', { default: {} })
	public effects: NoteDeleteEffects;

	@Column('integer', { default: 0 })
	public attempts: number;

	@Column('timestamp with time zone')
	public nextAttemptAt: Date;

	@Column('timestamp with time zone', { nullable: true })
	public claimUntil: Date | null;

	@Column('varchar', { length: 128, nullable: true })
	public claimToken: string | null;

	@Column('integer', { default: 0 })
	public claimVersion: number;

	// 오류 원문에는 민감한 값이 섞일 수 있으므로 분류 코드만 저장한다.
	@Column('varchar', { length: 128, nullable: true })
	public lastErrorCode: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public completedAt: Date | null;
}
