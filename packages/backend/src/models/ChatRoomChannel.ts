/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiChatRoom } from './ChatRoom.js';

@Entity('chat_room_channel')
export class MiChatRoomChannel {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column(id())
	public roomId: MiChatRoom['id'];

	@ManyToOne(() => MiChatRoom, { onDelete: 'CASCADE' })
	@JoinColumn()
	public room: MiChatRoom | null;

	@Column('varchar', { length: 4096 })
	public name: string;

	@Column('integer')
	public position: number;

	@Index({ unique: true })
	@Column('varchar', { length: 1024, nullable: true })
	public uri: string | null;
}
