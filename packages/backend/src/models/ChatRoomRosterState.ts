/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChatRoom } from './ChatRoom.js';

/**
 * ルームの参加者の変更を、順序どおりに適用するための記録。遅れて届いた古い変更で、新しい状態を巻き戻さないようにする。
 * 参加者でなくなった後の変更と比べるために、メンバーシップがなくなっても残す
 */
@Entity('chat_room_roster_state')
export class MiChatRoomRosterState {
	@PrimaryColumn(id())
	public roomId: MiChatRoom['id'];

	@ManyToOne(() => MiChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public room: MiChatRoom | null;

	@Index()
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	/**
	 * 最後に適用した変更の、ルームの持ち主のサーバーの時計での時刻。サーバーの時計は揃っていないので、持ち主の時刻どうしだけを比べる
	 */
	@Column('timestamp with time zone')
	public lastRosterAt: Date;

	/**
	 * このメンバーのサーバーが最後に述べた受諾・退出の、そのサーバーの時計での時刻。同じサーバーの時刻どうしだけを比べる
	 */
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public lastMemberAt: Date | null;

	/**
	 * このサーバーのユーザーが招待を受諾した時刻。退出するか外されると消える。
	 * ルームの持ち主に届く前に名簿で外されても、これがあれば持ち主からの Add で戻せる
	 */
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public acceptedAt: Date | null;
}
