/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { ChatRoomBansRepository } from '@/models/_.js';
import { MiChatRoomBan } from '@/models/ChatRoomBan.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiUser } from '@/models/User.js';
import { MiUserMove } from '@/models/UserMove.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { bindThis } from '@/decorators.js';

/** 계정 이전에 따른 금지 승계를 서로 직렬화하는 트랜잭션 advisory lock의 키. */
const MOVE_CARRY_LOCK = 'chat_room_ban:move';

/** 이 서버가 확인한 계정 이전 하나. */
export type VerifiedMove = { src: { id: MiUser['id'] }; dst: { id: MiUser['id'] } };

/**
 * 그룹장이 이 서버의 그룹에서 직접 내보낸 계정의 재참여 금지.
 *
 * 멤버를 들일 수 있는 것은 그룹장의 서버뿐이므로 그 서버만 이 기록을 가진다. 그룹에 들어오는 모든 경로는
 * 그룹 행 잠금을 잡고 멤버십을 쓰는 트랜잭션 안에서 {@link isBanned}를 묻고, 그룹장의 내보내기는 같은 잠금 아래
 * 멤버십을 지우는 트랜잭션에서 금지를 기록한다. 그래서 참여 요청은 멤버나 금지 중 하나를 반드시 본다.
 */
@Injectable()
export class ChatRoomBanService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.chatRoomBansRepository)
		private chatRoomBansRepository: ChatRoomBansRepository,

		private idService: IdService,
		private queryService: QueryService,
	) {
	}

	/**
	 * 그룹장이 이 계정을 내보낸 뒤 아직 사면하지 않았는지.
	 * 참여 처리는 그룹을 잠근 트랜잭션의 manager를 넘겨, 커밋할 때까지 답이 바뀌지 않게 한다.
	 */
	@bindThis
	public isBanned(roomId: MiChatRoom['id'], userId: MiUser['id'], manager?: EntityManager): Promise<boolean> {
		return (manager ?? this.chatRoomBansRepository.manager).existsBy(MiChatRoomBan, { roomId, userId });
	}

	/** 그룹장의 내보내기 전용. 그룹을 잠그고 멤버십을 지우는 트랜잭션 안에서 부른다. */
	@bindThis
	public async ban(manager: EntityManager, roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<void> {
		await manager.createQueryBuilder()
			.insert()
			.into(MiChatRoomBan)
			.values({ id: this.idService.gen(), roomId, userId })
			.orIgnore()
			.execute();
	}

	@bindThis
	public list(roomId: MiChatRoom['id'], limit: number, sinceId?: MiChatRoomBan['id'] | null, untilId?: MiChatRoomBan['id'] | null): Promise<MiChatRoomBan[]> {
		return this.queryService.makePaginationQuery(this.chatRoomBansRepository.createQueryBuilder('ban'), sinceId, untilId)
			.andWhere('ban.roomId = :roomId', { roomId })
			.innerJoinAndSelect('ban.user', 'user')
			.take(limit)
			.getMany();
	}

	/** 금지 기록만 지운다. 멤버십·초대·알림은 만들지 않는다. */
	@bindThis
	public async pardon(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<boolean> {
		const result = await this.chatRoomBansRepository.delete({ roomId, userId });
		return (result.affected ?? 0) > 0;
	}

	/**
	 * 확인된 계정 이전을 기록하고, 차단을 옮기듯 옛 계정의 금지를 새 계정에 잇는다. 옛 계정의 금지는 그대로 둔다.
	 *
	 * - 처음 기록되는 이전만 옛 계정의 금지 전체를 복사한다. 이미 기록된 이전은 다시 처리해도 복사하지 않으므로 사면한 금지가 되살아나지 않는다.
	 * - 새로 생긴 금지 행은 이미 기록된 다음 이전들을 따라 뒤쪽 계정에도 잇는다. 새 행이 생길 때만 진행하므로 순환이 있어도 끝난다.
	 *   그래서 이전들을 어떤 순서로 처리해도 일어난 순서대로 처리한 것과 같은 금지가 남는다.
	 * - 모든 승계를 하나의 advisory lock으로 직렬화해, 동시에 처리되는 앞뒤 이전이 서로의 결과를 보게 한다.
	 * - 멤버십·초대·알림은 바꾸지 않는다. 이미 멤버인 새 계정은 그대로 남고, 금지는 다시 참여할 때 적용된다.
	 *
	 * @param moves 사슬 순서의 이전들. 원격 이전은 별칭·순환·대상 확인을 통과한 것만 넘긴다.
	 * @param manager 로컬 이전은 이전 표시를 저장하는 트랜잭션의 manager를 넘겨, 승계가 실패하면 이전도 확정되지 않게 한다.
	 */
	@bindThis
	public async carryOnMove(moves: VerifiedMove[], manager?: EntityManager): Promise<void> {
		if (manager == null) {
			await this.db.transaction(transaction => this.carryOnMove(moves, transaction));
			return;
		}
		await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MOVE_CARRY_LOCK]);

		const added: { userId: MiUser['id']; roomIds: MiChatRoom['id'][] }[] = [];
		for (const { src, dst } of moves) {
			if (!await this.recordMove(manager, src.id, dst.id)) continue;
			const bans = await manager.findBy(MiChatRoomBan, { userId: src.id });
			const roomIds = await this.addBans(manager, dst.id, bans.map(ban => ban.roomId));
			if (roomIds.length > 0) added.push({ userId: dst.id, roomIds });
		}

		for (let next = added.shift(); next != null; next = added.shift()) {
			const later = await manager.findBy(MiUserMove, { srcUserId: next.userId });
			for (const move of later) {
				const roomIds = await this.addBans(manager, move.dstUserId, next.roomIds);
				if (roomIds.length > 0) added.push({ userId: move.dstUserId, roomIds });
			}
		}
	}

	/**
	 * 이 계정에 금지가 있는지. 승계가 필요한지 미리 판단할 때 쓴다.
	 * 복제본이 늦어 아직 잇지 않은 금지를 놓치지 않도록 주 DB에서 읽는다.
	 */
	@bindThis
	public hasBans(userId: MiUser['id']): Promise<boolean> {
		return this.onPrimary(manager => manager.existsBy(MiChatRoomBan, { userId }));
	}

	/** 이 이전을 이미 기록했는지. 주 DB에서 읽는다. */
	@bindThis
	public isMoveRecorded(srcUserId: MiUser['id'], dstUserId: MiUser['id']): Promise<boolean> {
		return this.onPrimary(manager => manager.existsBy(MiUserMove, { srcUserId, dstUserId }));
	}

	/** 처음 기록했으면 true, 이미 기록돼 있었으면 false. */
	private async recordMove(manager: EntityManager, srcUserId: MiUser['id'], dstUserId: MiUser['id']): Promise<boolean> {
		const result = await manager.createQueryBuilder()
			.insert()
			.into(MiUserMove)
			.values({ id: this.idService.gen(), srcUserId, dstUserId })
			.orIgnore()
			.returning(['id'])
			.updateEntity(false)
			.execute();
		return (result.raw as unknown[]).length > 0;
	}

	/** 없던 금지만 만들고, 새로 금지된 그룹의 ID를 돌려준다. */
	private async addBans(manager: EntityManager, userId: MiUser['id'], roomIds: MiChatRoom['id'][]): Promise<MiChatRoom['id'][]> {
		if (roomIds.length === 0) return [];

		// ID가 겹치면 이미 있는 금지처럼 조용히 무시되므로 겹치지 않는 ID를 만든다.
		const ids = new Set<string>();
		while (ids.size < roomIds.length) ids.add(this.idService.gen());

		const result = await manager.createQueryBuilder()
			.insert()
			.into(MiChatRoomBan)
			.values([...ids].map((id, i) => ({ id, roomId: roomIds[i], userId })))
			.orIgnore()
			.returning(['roomId'])
			.updateEntity(false)
			.execute();
		return (result.raw as { roomId: MiChatRoom['id'] }[]).map(row => row.roomId);
	}

	private async onPrimary<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
		const runner = this.db.createQueryRunner('master');
		try {
			return await work(runner.manager);
		} finally {
			await runner.release();
		}
	}
}
