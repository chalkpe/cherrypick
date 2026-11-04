/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import { LoggerService } from '@/core/LoggerService.js';
import { QueueService } from '@/core/QueueService.js';
import type { ChatRoomRosterStatesRepository, MiChatRoom, MiUser } from '@/models/_.js';

const ROSTER_SYNC_INTERVAL = 60;
// Longer than the longest an activity can spend being retried, so nothing outlives the record of its room.
const DELETED_ROOM_TTL = 31 * 24 * 60 * 60;
// A record that says nothing about the owner's clock: older than anything the owner can state.
const NO_OWNER_TIME = new Date(0);

/**
 * Keeps a room's membership changes in order. Another server's changes can arrive in any order, and only the room
 * owner's server knows the whole membership, so this also remembers which rooms are gone and asks for the membership again.
 *
 * Servers' clocks do not agree, so a time is only ever compared with another time from the same server:
 * lastRosterAt holds what the room's owner stated, and lastMemberAt what the member's own server stated.
 */
@Injectable()
export class ChatRosterService {
	private logger: Logger;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.chatRoomRosterStatesRepository)
		private chatRoomRosterStatesRepository: ChatRoomRosterStatesRepository,

		private queueService: QueueService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('chat-roster');
	}

	@bindThis
	public async lastRosterAt(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<Date | null> {
		const state = await this.chatRoomRosterStatesRepository.findOneBy({ roomId, userId });
		return state?.lastRosterAt ?? null;
	}

	/**
	 * Whether an Add may apply, recording it if so. A change without a time comes from a server
	 * that never states one, so there is nothing to order it by and it applies in arrival order.
	 */
	@bindThis
	public async claimAdd(roomId: MiChatRoom['id'], userId: MiUser['id'], published: Date | null): Promise<boolean> {
		if (published == null) return true;
		return await this.claim(roomId, userId, published, '<');
	}

	/** Whether a Remove may apply, recording it if so. A Remove wins a tie: a member who was removed stays out. */
	@bindThis
	public async claimRemove(roomId: MiChatRoom['id'], userId: MiUser['id'], published: Date | null): Promise<boolean> {
		if (published == null) return true;
		return await this.claim(roomId, userId, published, '<=');
	}

	/**
	 * A member the owner's roster has dropped leaves only if the roster is newer than their last change. Every way of
	 * becoming a member records one, so a membership without a record is from before this was kept and older than any roster.
	 */
	@bindThis
	public async claimRosterRemove(roomId: MiChatRoom['id'], userId: MiUser['id'], rosterAt: Date): Promise<boolean> {
		return await this.claim(roomId, userId, rosterAt, '<');
	}

	/** For a new membership from an owner that states no time. A record already here says more than this does. */
	@bindThis
	public async recordIfMissing(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<void> {
		await this.chatRoomRosterStatesRepository.query(
			'INSERT INTO "chat_room_roster_state" ("roomId", "userId", "lastRosterAt") VALUES ($1, $2, $3) ON CONFLICT ("roomId", "userId") DO NOTHING',
			[roomId, userId, NO_OWNER_TIME],
		);
	}

	/**
	 * Someone here accepted an invitation. This is not a change by the owner, so what the owner stated last stays
	 * what a cancellation is compared with: one that crossed this acceptance still has to apply.
	 */
	@bindThis
	public async recordAccepted(roomId: MiChatRoom['id'], userId: MiUser['id'], acceptedAt: Date): Promise<void> {
		await this.chatRoomRosterStatesRepository.query(
			`INSERT INTO "chat_room_roster_state" ("roomId", "userId", "lastRosterAt", "acceptedAt") VALUES ($1, $2, $3, $4)
			ON CONFLICT ("roomId", "userId") DO UPDATE SET "acceptedAt" = EXCLUDED."acceptedAt"`,
			[roomId, userId, NO_OWNER_TIME, acceptedAt],
		);
	}

	/** In a room owned here: a member's server accepted, stating the time by its own clock if it states one at all. */
	@bindThis
	public async recordMemberAccept(roomId: MiChatRoom['id'], userId: MiUser['id'], published: Date | null): Promise<void> {
		await this.chatRoomRosterStatesRepository.query(
			`INSERT INTO "chat_room_roster_state" ("roomId", "userId", "lastRosterAt", "lastMemberAt") VALUES ($1, $2, $3, $4)
			ON CONFLICT ("roomId", "userId") DO UPDATE SET
				"lastRosterAt" = GREATEST("chat_room_roster_state"."lastRosterAt", EXCLUDED."lastRosterAt"),
				"lastMemberAt" = GREATEST("chat_room_roster_state"."lastMemberAt", EXCLUDED."lastMemberAt")`,
			[roomId, userId, new Date(), published],
		);
	}

	/**
	 * In a room owned here: whether a member's own Remove may apply, recording it if so. It goes against what the same
	 * server said last, so that a Remove from before an acceptance changes nothing however far its clock is from this one.
	 */
	@bindThis
	public async claimOwnRemove(roomId: MiChatRoom['id'], userId: MiUser['id'], published: Date | null): Promise<boolean> {
		if (published == null) return true;
		const rows = await this.chatRoomRosterStatesRepository.query(
			`INSERT INTO "chat_room_roster_state" ("roomId", "userId", "lastRosterAt", "lastMemberAt") VALUES ($1, $2, $3, $4)
			ON CONFLICT ("roomId", "userId") DO UPDATE SET "lastMemberAt" = EXCLUDED."lastMemberAt"
			WHERE "chat_room_roster_state"."lastMemberAt" IS NULL OR "chat_room_roster_state"."lastMemberAt" <= EXCLUDED."lastMemberAt"
			RETURNING "lastMemberAt"`,
			[roomId, userId, NO_OWNER_TIME, published],
		);
		return rows.length > 0;
	}

	@bindThis
	public async lastMemberAt(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<Date | null> {
		const state = await this.chatRoomRosterStatesRepository.findOneBy({ roomId, userId });
		return state?.lastMemberAt ?? null;
	}

	/** Their own acceptance is what lets an Add from the owner make someone here a member, until they leave or are removed. */
	@bindThis
	public async acceptedAt(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<Date | null> {
		const state = await this.chatRoomRosterStatesRepository.findOneBy({ roomId, userId });
		return state?.acceptedAt ?? null;
	}

	@bindThis
	public async forgetAccepted(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<void> {
		await this.chatRoomRosterStatesRepository.update({ roomId, userId }, { acceptedAt: null });
	}

	/** Moves the record up to this time. Changes older than it are out of date from now on. */
	@bindThis
	public async advance(roomId: MiChatRoom['id'], userId: MiUser['id'], at: Date): Promise<void> {
		await this.chatRoomRosterStatesRepository.query(
			`INSERT INTO "chat_room_roster_state" ("roomId", "userId", "lastRosterAt") VALUES ($1, $2, $3)
			ON CONFLICT ("roomId", "userId") DO UPDATE SET "lastRosterAt" = GREATEST("chat_room_roster_state"."lastRosterAt", EXCLUDED."lastRosterAt")
			RETURNING "lastRosterAt"`,
			[roomId, userId, at],
		);
	}

	// Inbox workers can process a room's changes at the same time, so the comparison and the write are one statement.
	private async claim(roomId: MiChatRoom['id'], userId: MiUser['id'], at: Date, comparison: '<' | '<='): Promise<boolean> {
		const rows = await this.chatRoomRosterStatesRepository.query(
			`INSERT INTO "chat_room_roster_state" ("roomId", "userId", "lastRosterAt") VALUES ($1, $2, $3)
			ON CONFLICT ("roomId", "userId") DO UPDATE SET "lastRosterAt" = EXCLUDED."lastRosterAt"
			WHERE "chat_room_roster_state"."lastRosterAt" ${comparison} EXCLUDED."lastRosterAt"
			RETURNING "lastRosterAt"`,
			[roomId, userId, at],
		);
		return rows.length > 0;
	}

	/** Asks the room owner's server for the membership. The request comes from outside, so one member can only ask so often. */
	@bindThis
	public async requestSync(room: Pick<MiChatRoom, 'id'>, memberKey: string): Promise<void> {
		try {
			const acquired = await this.redisClient.set(`chat_room_roster_sync:${room.id}:${memberKey}`, '1', 'EX', ROSTER_SYNC_INTERVAL, 'NX');
			if (acquired == null) return;
			await this.queueService.createChatRoomRosterSyncJob(room.id);
		} catch (err) {
			// Whoever asked goes on to refuse or retry either way.
			this.logger.warn(`Failed to request the roster of chat room ${room.id}: ${err}`);
		}
	}

	/** Activities still on their way must not bring the room back or use up their retries waiting for it. */
	@bindThis
	public async markRoomDeletedByOwner(roomUri: string): Promise<void> {
		await this.redisClient.setex(this.deletedRoomKey(roomUri), DELETED_ROOM_TTL, new Date().toISOString());
	}

	@bindThis
	public async isRoomDeletedByOwner(roomUri: string): Promise<boolean> {
		return await this.redisClient.get(this.deletedRoomKey(roomUri)) != null;
	}

	/** This server's copy was removed but the room goes on, so its owner may still invite someone here again. */
	@bindThis
	public async markRoomClosedHere(roomUri: string): Promise<void> {
		await this.redisClient.setex(this.closedRoomKey(roomUri), DELETED_ROOM_TTL, new Date().toISOString());
	}

	@bindThis
	public async forgetRoomClosedHere(roomUri: string): Promise<void> {
		await this.redisClient.del(this.closedRoomKey(roomUri));
	}

	/** Whether a room this server has no copy of will never get one from the activity at hand. */
	@bindThis
	public async isRoomGone(roomUri: string): Promise<boolean> {
		if (await this.isRoomDeletedByOwner(roomUri)) return true;
		return await this.redisClient.get(this.closedRoomKey(roomUri)) != null;
	}

	/** Lets those who were in a room learn that it was deleted, and nobody else that it ever existed. */
	@bindThis
	public async markRoomDeletedFor(userIds: MiUser['id'][], roomId: MiChatRoom['id']): Promise<void> {
		const pipeline = this.redisClient.pipeline();
		for (const userId of userIds) {
			pipeline.setex(this.deletedForKey(userId, roomId), DELETED_ROOM_TTL, '1');
		}
		await pipeline.exec();
	}

	@bindThis
	public async wasRoomDeletedFor(userId: MiUser['id'], roomId: MiChatRoom['id']): Promise<boolean> {
		return await this.redisClient.get(this.deletedForKey(userId, roomId)) != null;
	}

	private deletedRoomKey(roomUri: string): string {
		return `chat_room_deleted:${roomUri}`;
	}

	private closedRoomKey(roomUri: string): string {
		return `chat_room_closed_here:${roomUri}`;
	}

	private deletedForKey(userId: MiUser['id'], roomId: MiChatRoom['id']): string {
		return `chat_room_deleted_for:${userId}:${roomId}`;
	}
}
