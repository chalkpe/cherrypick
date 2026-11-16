/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiChatRoom } from './ChatRoom.js';

export type ChatRoomHistoryStatus = 'running' | 'completed' | 'unavailable';

/**
 * 다른 서버가 소유한 그룹의 과거 기록을 이 서버가 어디까지 가져왔는지. 중단돼도 nextUri부터 이어 받는다.
 * pass는 처음부터 다시 받기 시작할 때마다 늘어나서, 앞선 작업이 새 작업의 진행 위치를 덮어쓰지 못하게 한다.
 */
@Entity('chat_room_history_state')
export class MiChatRoomHistoryState {
	@PrimaryColumn(id())
	public roomId: MiChatRoom['id'];

	@ManyToOne(() => MiChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public room: MiChatRoom | null;

	@Column('varchar', { length: 16 })
	public status: ChatRoomHistoryStatus;

	/** 다음에 받을 페이지. null이면 첫 페이지(최근 글)부터 */
	@Column('varchar', { length: 2048, nullable: true })
	public nextUri: string | null;

	@Column('integer', { default: 0 })
	public pass: number;

	@Column('timestamp with time zone', { nullable: true })
	public completedAt: Date | null;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
