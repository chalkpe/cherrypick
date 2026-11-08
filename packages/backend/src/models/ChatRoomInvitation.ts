/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChatRoom } from './ChatRoom.js';

@Entity('chat_room_invitation')
@Index(['userId', 'roomId'], { unique: true })
export class MiChatRoomInvitation {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column({
		...id(),
	})
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	@Index()
	@Column({
		...id(),
	})
	public roomId: MiChatRoom['id'];

	@ManyToOne(() => MiChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public room: MiChatRoom | null;

	@Column('boolean', {
		default: false,
	})
	public ignored: boolean;

	/**
	 * リモートのルーム所有者が Invite に記した時刻。受諾・拒否でそのまま返し、どの招待への返事なのかを所有者が判断できるようにする
	 */
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public invitePublishedAt: Date | null;
}
