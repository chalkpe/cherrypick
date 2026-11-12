/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

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

	@Index({ unique: true })
	@Column('varchar', {
		length: 512, nullable: true,
	})
	public uri: string | null;

	@Column('boolean', {
		default: false,
	})
	public isArchived: boolean;

	/**
	 * 持ち主がこのルームをミュートしているか。メンバーのミュートはメンバーシップに持つが、持ち主にはメンバーシップがないのでここに持つ。
	 * 持ち主ひとりの通知の設定で、ほかの参加者にもほかのサーバーにも伝えない
	 */
	@Column('boolean', {
		default: false,
	})
	public isMutedByOwner: boolean;

	/**
	 * リモートのルーム所有者が最後に知らせた、状態の時刻。遅れて届いた古い状態で巻き戻らないようにする
	 */
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public lastRemoteUpdatedAt: Date | null;
}
