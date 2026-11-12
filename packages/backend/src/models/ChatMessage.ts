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

@Entity('chat_message')
export class MiChatMessage {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column({
		...id(),
	})
	public fromUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public fromUser: MiUser | null;

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
}
