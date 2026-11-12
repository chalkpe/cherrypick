/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChatRoom } from './ChatRoom.js';
import { MiChatMessage } from './ChatMessage.js';
import { MiChatRoomMembership } from './ChatRoomMembership.js';

@Entity('chat_room_unread')
@Index(['userId', 'roomId'])
export class MiChatRoomUnread {
	@PrimaryColumn(id())
	public userId: string;

	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' })
	@JoinColumn()
	public user: MiUser | null;

	@Index()
	@PrimaryColumn(id())
	public messageId: string;

	@ManyToOne(() => MiChatMessage, { onDelete: 'CASCADE' })
	@JoinColumn()
	public message: MiChatMessage | null;

	@Index()
	@Column(id())
	public roomId: string;

	@ManyToOne(() => MiChatRoom, { onDelete: 'CASCADE' })
	@JoinColumn()
	public room: MiChatRoom | null;

	@Index()
	@Column({ ...id(), nullable: true })
	public membershipId: string | null;

	@ManyToOne(() => MiChatRoomMembership, { onDelete: 'CASCADE' })
	@JoinColumn()
	public membership: MiChatRoomMembership | null;

	@Column('bigint')
	public sequence: string;

	@Column('boolean', { default: false })
	public isMention: boolean;

	@Column('boolean', { default: false })
	public notificationSent: boolean;
}
