/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { ChatRoomBansRepository } from '@/models/_.js';
import { MiChatRoomBan } from '@/models/ChatRoomBan.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import { MiUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { bindThis } from '@/decorators.js';

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
		@Inject(DI.config)
		private config: Config,

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
	public async isBanned(roomId: MiChatRoom['id'], userId: MiUser['id'], manager?: EntityManager): Promise<boolean> {
		const db = manager ?? this.chatRoomBansRepository.manager;
		const start = await db.findOneBy(MiUser, { id: userId });
		if (start == null) return false;
		const queue = [{ user: start, depth: 0 }];
		const seen = new Set<string>();
		while (queue.length > 0) {
			const { user, depth } = queue.shift()!;
			if (seen.has(user.id)) continue;
			seen.add(user.id);
			if (await db.existsBy(MiChatRoomBan, { roomId, userId: user.id })) return true;
			const aliases = user.alsoKnownAs ?? [];
			if (aliases.length === 0) continue;
			// A bounded search fails closed when it cannot inspect the whole graph.
			if (depth >= 10 || seen.size > 1000 || aliases.length > 1000) return true;
			const uri = user.uri ?? `${this.config.url}/users/${user.id}`;
			const localPrefix = `${this.config.url}/users/`;
			const localIds = aliases.filter(alias => alias.startsWith(localPrefix)).map(alias => alias.slice(localPrefix.length));
			const predecessors = await db.findBy(MiUser, [
				{ uri: In(aliases), movedToUri: uri },
				{ id: In(localIds), host: IsNull(), movedToUri: uri },
			]);
			if (seen.size + queue.length + predecessors.length > 1000) return true;
			queue.push(...predecessors.map(predecessor => ({ user: predecessor, depth: depth + 1 })));
		}
		return false;
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
}
