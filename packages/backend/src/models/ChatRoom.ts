/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChatRoomChannel } from './ChatRoomChannel.js';
import { MiDriveFile } from './DriveFile.js';

@Entity('chat_room')
export class MiChatRoom {
	@PrimaryColumn(id())
	public id: string;

	@Column('varchar', {
		length: 256,
	})
	public name: string;

	@Index()
	@Column({
		...id(),
	})
	public ownerId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public owner: MiUser | null;

	@Column('varchar', {
		length: 2048, default: '',
	})
	public description: string;

	@Index()
	@Column({ ...id(), nullable: true })
	public iconId: MiDriveFile['id'] | null;

	@ManyToOne(() => MiDriveFile, { onDelete: 'SET NULL' })
	@JoinColumn()
	public icon: MiDriveFile | null;

	@Column('varchar', { length: 1024, nullable: true })
	public iconUrl: string | null;

	@Column('varchar', { length: 128, nullable: true })
	public iconBlurhash: string | null;

	@Column('jsonb', { default: [] })
	public iconDecorations: MiUser['avatarDecorations'];

	@Index({ unique: true })
	@Column('varchar', {
		length: 512, nullable: true,
	})
	public uri: string | null;

	@Column('boolean', {
		default: false,
	})
	public isArchived: boolean;

	@Column('boolean', { default: false })
	public hasChannels: boolean;

	@Column({ ...id(), nullable: true })
	public legacyChannelId: MiChatRoomChannel['id'] | null;

	@ManyToOne(() => MiChatRoomChannel, { onDelete: 'SET NULL' })
	@JoinColumn()
	public legacyChannel: MiChatRoomChannel | null;

	/**
	 * リモートのルーム所有者が最後に知らせた、状態の時刻。遅れて届いた古い状態で巻き戻らないようにする
	 */
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public lastRemoteUpdatedAt: Date | null;
}
