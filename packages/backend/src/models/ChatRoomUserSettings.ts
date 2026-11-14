/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChatRoom } from './ChatRoom.js';
import { MiChatRoomMembership } from './ChatRoomMembership.js';
import type { ChatNotificationLevel } from '@/core/chat-room-notifications.js';

@Entity('chat_room_user_settings')
export class MiChatRoomUserSettings {
	@PrimaryColumn(id())
	public userId: string;

	@ManyToOne(() => MiUser, { onDelete: 'CASCADE' })
	@JoinColumn()
	public user: MiUser | null;

	@Index()
	@PrimaryColumn(id())
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

	@Column('varchar', { length: 16, default: 'all' })
	public notificationLevel: ChatNotificationLevel;

	@Column('jsonb', { default: {} })
	public channelOverrides: Record<string, ChatNotificationLevel>;
}
