/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import type { MiDriveFile } from './DriveFile.js';
import { MiChatRoom } from './ChatRoom.js';
import { MiChatRoomChannel } from './ChatRoomChannel.js';
import type { ChatChannelRef } from '@/core/chat-room-channels.js';
import type { ChatDiceResult } from '@/core/chat-dice.js';

/** 계정이 없어진 뒤에도 보존하는 그룹 메시지의 과거 기록용 작성자 정보. 계정이 아니며 프로필로 연결하지 않는다. host가 null이면 이 서버의 계정이었다. */
export type ChatMessageArchivedAuthor = {
	uri: string;
	username: string | null;
	name: string | null;
	host: string | null;
};

@Entity('chat_message')
@Index(['toRoomId', 'id'])
export class MiChatMessage {
	@PrimaryColumn(id())
	public id: string;

	/** 그룹 메시지는 작성자 계정이 지워진 뒤에도 남으며, 그때는 null이고 archivedAuthor로 표시한다. */
	@Index()
	@Column({
		...id(), nullable: true,
	})
	public fromUserId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public fromUser: MiUser | null;

	@Column({ ...id(), nullable: true })
	public directFromUserId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' })
	@JoinColumn()
	public directFromUser: MiUser | null;

	@Index()
	@Column({
		...id(), nullable: true,
	})
	public toUserId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public toUser: MiUser | null;

	@Index()
	@Column({
		...id(), nullable: true,
	})
	public toRoomId: MiChatRoom['id'] | null;

	@ManyToOne(() => MiChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public toRoom: MiChatRoom | null;

	@Index()
	@Column({ ...id(), nullable: true })
	public toRoomChannelId: MiChatRoomChannel['id'] | null;

	@ManyToOne(() => MiChatRoomChannel, { onDelete: 'CASCADE' })
	@JoinColumn()
	public toRoomChannel: MiChatRoomChannel | null;

	@Column({ ...id(), array: true, default: '{}' })
	public mentionedUserIds: string[];

	@Column('bigint', { nullable: true })
	public roomMessageSequence: string | null;

	@Column('jsonb', { default: [] })
	public channelRefs: ChatChannelRef[];

	@Column('varchar', {
		length: 4096, nullable: true,
	})
	public text: string | null;

	@Column('jsonb', { nullable: true })
	public dice: ChatDiceResult | null;

	@Index({ unique: true })
	@Column('varchar', {
		length: 512, nullable: true,
	})
	public uri: string | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public editedAt: Date | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public deletedAt: Date | null;

	@Column({
		...id(),
		array: true, default: '{}',
	})
	public reads: MiUser['id'][];

	@Column({
		...id(),
		array: true, default: '{}',
	})
	public fileIds: MiDriveFile['id'][];

	@Column('varchar', {
		length: 1024, array: true, default: '{}',
	})
	public reactions: string[];

	@Column('varchar', {
		length: 128, array: true, default: '{}',
	})
	public emojis: string[];

	@Column('jsonb', { nullable: true })
	public archivedAuthor: ChatMessageArchivedAuthor | null;

	/** 그룹 소유 서버의 과거 기록에서 가져온 사본이면 가져온 시각. 미읽음·알림을 만들지 않은 글이다. */
	@Column('timestamp with time zone', { nullable: true })
	public importedAt: Date | null;

	/** 과거 기록을 가져올 때 받을 수 없었던 첨부 파일 수. 글 자체는 보존한다. */
	@Column('integer', { default: 0 })
	public unavailableFileCount: number;
}
