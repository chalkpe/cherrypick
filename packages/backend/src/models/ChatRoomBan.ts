/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChatRoom } from './ChatRoom.js';

/**
 * 이 서버에 있는 그룹에서 그룹장이 직접 내보낸 계정. 그룹장이 사면하기 전까지 다시 참여할 수 없다.
 * 멤버를 들일 수 있는 것은 그룹장의 서버뿐이므로 그 서버만 이 기록을 가진다.
 */
@Entity('chat_room_ban')
@Index(['roomId', 'userId'], { unique: true })
export class MiChatRoomBan {
	@PrimaryColumn(id())
	public id: string;

	@Column({
		...id(),
	})
	public roomId: MiChatRoom['id'];

	@ManyToOne(() => MiChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public room: MiChatRoom | null;

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
}
