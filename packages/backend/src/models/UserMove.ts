/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

/**
 * 이 서버가 확인한 계정 이전(옛 계정 → 새 계정). 그룹 재참여 금지를 이전 사슬을 따라 잇는 데만 쓴다.
 * 원격 이전은 별칭·순환·대상 확인을 통과한 것만, 로컬 이전은 이전 표시를 저장하는 트랜잭션에서 기록한다.
 * 이 기록이 있는 이전은 금지를 이미 옮긴 것이므로 같은 이전을 다시 처리해도 금지를 다시 복사하지 않는다.
 */
@Entity('user_move')
@Index(['srcUserId', 'dstUserId'], { unique: true })
export class MiUserMove {
	@PrimaryColumn(id())
	public id: string;

	@Column({
		...id(),
	})
	public srcUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public srcUser: MiUser | null;

	@Index()
	@Column({
		...id(),
	})
	public dstUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public dstUser: MiUser | null;
}
