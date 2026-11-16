/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiChatRoom } from './ChatRoom.js';

/**
 * 그룹의 활성 초대 링크. 그룹당 하나이고, 폐기하면 행을 지운다. 발급 시각은 id에서 얻는다.
 * 그룹 행은 모더레이션 기록 등으로 통째로 나가므로 코드를 그룹 행에 두지 않는다.
 */
@Entity('chat_room_invite_link')
export class MiChatRoomInviteLink {
	@PrimaryColumn(id())
	public id: string;

	@Index({ unique: true })
	@Column(id())
	public roomId: MiChatRoom['id'];

	@ManyToOne(() => MiChatRoom, { onDelete: 'CASCADE' })
	@JoinColumn()
	public room: MiChatRoom | null;

	@Index({ unique: true })
	@Column('varchar', { length: 64 })
	public code: string;
}
