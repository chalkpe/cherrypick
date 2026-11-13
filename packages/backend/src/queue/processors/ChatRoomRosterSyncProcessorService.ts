/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { MAX_ROOM_MEMBERS, ChatService } from '@/core/ChatService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { IdService } from '@/core/IdService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApChatRoomStateService } from '@/core/activitypub/ApChatRoomStateService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { chatActorUri } from '@/core/activitypub/misc/chat-payloads.js';
import { parseRemoteChatDate } from '@/core/activitypub/misc/chat-remote-date.js';
import { getApHrefNullable, getApType } from '@/core/activitypub/type.js';
import type { IObject } from '@/core/activitypub/type.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { StatusError } from '@/misc/status-error.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository, MiUser, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { ChatRoomRosterSyncJobData } from '../types.js';

// A room whose owner does not recognize this many of the members here has bigger problems than one more request.
const MAX_SIGNERS = 3;
const ACCEPT_TRAVEL_TIME = 5 * 60 * 1000;

/**
 * A server only learns a remote room's members one activity at a time, and an activity can be lost.
 * The owner's server knows them all, so this reads the membership from there and corrects what has gone astray.
 */
@Injectable()
export class ChatRoomRosterSyncProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private chatService: ChatService,
		private apChatRoomStateService: ApChatRoomStateService,
		private chatRosterService: ChatRosterService,
		private apResolverService: ApResolverService,
		private apDbResolverService: ApDbResolverService,
		private apPersonService: ApPersonService,
		private userEntityService: UserEntityService,
		private idService: IdService,
		private utilityService: UtilityService,
		private hostPolicyService: HostPolicyService,
		private globalEventService: GlobalEventService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('chat-room-roster-sync');
	}

	@bindThis
	public async process(job: Bull.Job<ChatRoomRosterSyncJobData>): Promise<string> {
		return await this.syncRoom(job.data.roomId);
	}

	/** 그룹 객체를 다시 읽어 명단과 채널 목록을 맞춘다. 과거 기록 가져오기가 모르는 채널을 만났을 때도 쓴다. */
	@bindThis
	public async syncRoom(roomId: MiChatRoom['id']): Promise<string> {
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room?.uri == null) return 'skip: no room to read the roster of';

		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || !this.userEntityService.isRemoteUser(owner) || owner.isSuspended) return 'skip: the room has no owner to ask';
		if (await this.hostPolicyService.isRefusedRemoteHost(owner.host)) return 'skip: the owner\'s server is refused';

		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const members = memberships.length > 0 ? await this.usersRepository.findBy({ id: In(memberships.map(membership => membership.userId)) }) : [];

		const group = await this.fetchGroup(room.uri, members);
		if (group == null) return 'skip: nobody here can read the room';

		const roster = this.parseRoster(group, room.uri, owner.uri);
		if (roster == null) return 'skip: the owner\'s server gave no roster';

		if (Object.hasOwn(group, 'icon') || Object.hasOwn(group, '_misskey_chatIconDecorations')) {
			await this.apChatRoomStateService.apply(room, group);
		} else {
			await this.chatService.updateRoom(room, {}, { federate: false, remoteUpdatedAt: parseRemoteChatDate(group.updated) ?? undefined, remoteGroup: group });
		}

		const present = await this.removeDropped(room, memberships, members, roster);
		await this.addListed(room, owner.uri, roster, present);
		return 'ok';
	}

	/** The owner shows the membership only to a member, so the request has to come from one. */
	private async fetchGroup(roomUri: string, members: MiUser[]): Promise<IObject | null> {
		const signers = members.filter((member): member is MiLocalUser => this.userEntityService.isLocalUser(member)).slice(0, MAX_SIGNERS);
		for (const signer of signers) {
			const resolver = await this.apResolverService.createResolver();
			resolver.signAs(signer);
			try {
				return await resolver.resolve(roomUri);
			} catch (err) {
				// The owner does not count this one as a member, but may count another.
				if (err instanceof StatusError && err.isClientError) continue;
				throw err;
			}
		}
		return null;
	}

	private parseRoster(group: IObject, roomUri: string, ownerUri: string): { uris: Set<string>; at: Date } | null {
		if (getApType(group) !== 'Group' || group.id !== roomUri || getApHrefNullable(group.attributedTo as string | IObject | undefined) !== ownerUri) return null;

		const at = parseRemoteChatDate(group._misskey_chatRoomRosterAt);
		const listed: unknown = group._misskey_chatRoomMembers;
		if (at == null || !Array.isArray(listed)) return null;
		// The owner may or may not list itself.
		if (listed.length > MAX_ROOM_MEMBERS + 1 || !listed.every(uri => typeof uri === 'string')) return null;

		return { uris: new Set<string>(listed), at };
	}

	/** @returns the listed members this server already has */
	private async removeDropped(room: MiChatRoom, memberships: MiChatRoomMembership[], members: MiUser[], roster: { uris: Set<string>; at: Date }): Promise<Set<string>> {
		const usersById = new Map(members.map(member => [member.id, member]));
		const present = new Set<string>();

		for (const membership of memberships) {
			const user = usersById.get(membership.userId);
			if (user == null || user.id === room.ownerId) continue;

			const uri = chatActorUri(user, this.config.url);
			if (roster.uris.has(uri)) {
				present.add(uri);
				// The list has the final word up to its time, so an older Remove still on its way is out of date.
				await this.withRoomLock(room.id, manager => this.chatRosterService.advance(room.id, user.id, roster.at, manager));
				continue;
			}

			const removed = await this.withRoomLock(room.id, async manager => {
				if (this.userEntityService.isLocalUser(user) && await this.acceptMayBeOnItsWay(room, membership, roster.at, manager)) return false;
				if (!await this.chatRosterService.claimRosterRemove(room.id, user.id, roster.at, manager)) return false;
				const result = await manager.delete(MiChatRoomMembership, { roomId: room.id, userId: user.id });
				return (result.affected ?? 0) > 0;
			});
			if (removed) await this.chatService.finishRoomMemberRemoval(room, user);
		}

		return present;
	}

	private async acceptMayBeOnItsWay(room: MiChatRoom, membership: MiChatRoomMembership, rosterAt: Date, manager: EntityManager): Promise<boolean> {
		const acceptedAt = await this.chatRosterService.acceptedAt(room.id, membership.userId, manager) ?? this.idService.parse(membership.id).date;
		return acceptedAt >= rosterAt || Date.now() - acceptedAt.getTime() < ACCEPT_TRAVEL_TIME;
	}

	private async addListed(room: MiChatRoom, ownerUri: string, roster: { uris: Set<string>; at: Date }, present: Set<string>): Promise<void> {
		for (const uri of roster.uris) {
			if (present.has(uri) || uri === ownerUri) continue;
			// Only their own acceptance makes someone here a member.
			if (!this.isRemoteMemberUri(uri)) continue;

			const user = await this.resolveMember(uri);
			if (user == null || !this.userEntityService.isRemoteUser(user) || user.id === room.ownerId) continue;

			const added = await this.withRoomLock(room.id, async manager => {
				if (await manager.countBy(MiChatRoomMembership, { roomId: room.id }) >= MAX_ROOM_MEMBERS) return false;
				if (!await this.chatRosterService.claimAdd(room.id, user.id, roster.at, manager)) return false;
				if (await manager.findOneBy(MiChatRoomMembership, { roomId: room.id, userId: user.id }) != null) return false;
				await manager.insert(MiChatRoomMembership, { id: this.idService.gen(), roomId: room.id, userId: user.id });
				return true;
			}).catch(err => {
				// An Add from the owner got here first.
				if (!isDuplicateKeyValueError(err)) throw err;
				return false;
			});
			if (added) this.globalEventService.publishChatRoomStream(room.id, 'membershipStarted', { userId: user.id });
		}
	}

	private async withRoomLock<T>(roomId: MiChatRoom['id'], callback: (manager: EntityManager) => Promise<T>): Promise<T | null> {
		return await this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			return room == null ? null : await callback(manager);
		});
	}

	private isRemoteMemberUri(uri: string): boolean {
		try {
			return !this.utilityService.isUriLocal(uri) && this.utilityService.isFederationAllowedUri(uri);
		} catch {
			return false;
		}
	}

	private async resolveMember(uri: string): Promise<MiUser | null> {
		try {
			return await this.apDbResolverService.getUserFromApId(uri) ?? await this.apPersonService.resolvePerson(uri, await this.apResolverService.createResolver());
		} catch (err) {
			this.logger.warn(`Failed to resolve chat room member ${uri}: ${err}`);
			return null;
		}
	}
}
