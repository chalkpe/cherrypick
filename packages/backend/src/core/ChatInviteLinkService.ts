/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { SummalyResult } from '@misskey-dev/summaly';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { ChatRoomInvitationsRepository, ChatRoomInviteLinksRepository, ChatRoomMembershipsRepository, ChatRoomsRepository, UsersRepository } from '@/models/_.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomInviteLink } from '@/models/ChatRoomInviteLink.js';
import { MiChatRoomInvitation } from '@/models/ChatRoomInvitation.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiBlocking } from '@/models/Blocking.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ChatRoomIconEntityService } from '@/core/entities/ChatRoomIconEntityService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApRequestService } from '@/core/activitypub/ApRequestService.js';
import type { IObject } from '@/core/activitypub/type.js';
import { QueueService } from '@/core/QueueService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import { ChatRoomAccessError, ChatRoomArchivedError, ChatRoomFullError, ChatService, MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { StatusError } from '@/misc/status-error.js';
import { acquireDistributedLock } from '@/misc/distributed-lock.js';
import { bindThis } from '@/decorators.js';
import {
	apIdOf,
	chatInviteUrl,
	chatInviteJoinInvitationKey,
	decideChatJoin,
	generateChatInviteCode,
	isChatInviteCode,
	parseChatInvitePreview,
	parseChatInviteUrl,
	parseChatJoinReject,
	renderChatInvitePreview,
	renderChatJoin,
	renderChatJoinReject,
} from '@/core/chat-invite-link.js';
import type { ChatInvitePreview, ChatInvitePreviewDocument, ChatJoinRefusal, ChatJoinRefusalReceived, ParsedChatInviteUrl } from '@/core/chat-invite-link.js';

/**
 * 참여 요청의 유효 시간. 배달 재시도(1·3·7분 대기)와 그룹 서버의 inbox 재시도를 덮는다.
 * 그 뒤 늦게 온 초대는 자동으로 수락하지 않고 보통의 초대로 남는다.
 */
const JOIN_TTL_SECONDS = 30 * 60;
// 서명한 요청은 리다이렉트를 따르지 않는다. 다른 곳으로 서명이 가지 않게 한다 (RemoteVoiceCallService와 같은 한도)
const PREVIEW_TIMEOUT_MS = 10_000;
const PREVIEW_SIZE_LIMIT = 64 * 1024;

export class ChatInviteLinkExistsError extends Error {}
export class ChatInviteLinkNotFoundError extends Error {}
export class ChatInviteInvalidUrlError extends Error {}
/** 다른 서버의 링크인데 그 서버가 이 규약을 모르거나, 연합이 막혀 있거나, 응답이 맞지 않는다. 일반 링크로 다룬다 */
export class ChatInviteRemoteUnavailableError extends Error {}
export class ChatInviteJoinRefusedError extends Error {
	constructor(public reason: ChatJoinRefusal) {
		super(reason);
	}
}

export type ChatInviteJoinStatus = {
	status: 'none' | 'pending' | 'joined' | 'invited' | 'refused';
	roomId: string | null;
	reason: ChatJoinRefusalReceived | null;
};

export type ChatInviteSummary = SummalyResult & {
	chatInvite: ChatInviteIcon & {
		url: string;
		host: string;
		code: string;
		name: string;
		description: string;
		membersCount: number;
		isLocal: boolean;
	};
};

export type ChatInviteIcon = Pick<Awaited<ReturnType<ChatRoomIconEntityService['pack']>>, 'iconUrl' | 'iconBlurhash' | 'iconDecorations'>;

/**
 * 사본 서버가 보낸 참여 요청의 기록. 사용자와 그룹 URI, 실제로 보낸 Join id에 묶인다.
 * - pending: Join을 보냄
 * - joined: 그룹 서버의 Invite를 자동으로 수락함
 * - invited: Invite는 왔지만 자동 수락이 실패함. 보통의 초대로 남음
 * - refused: 그룹 서버가 이 Join을 거절함. afterAccept면 자동 수락 뒤 그룹 서버가 Accept를 받아들이지 않은 것
 */
type JoinIntent = {
	joinId: string;
	url: string;
	roomUri: string;
	state: 'pending' | 'joined' | 'invited' | 'refused';
	reason: ChatJoinRefusalReceived | null;
	roomId: string | null;
	afterAccept: boolean;
	/** 자동 수락으로 만든 멤버십. 늦은 거절이 그 멤버십에 대한 것인지, 그 뒤 다른 경로로 생긴 멤버십인지 가른다 */
	membershipId?: string | null;
};

/** 그룹 서버가 Join에 답해 만든 초대. Accept를 받아들이지 못하면 이 Join에 사유를 알린다 */
type JoinInvitation = { joinId: string; url: string; actor: string; invitationId?: string };

type LocalInvite = {
	link: MiChatRoomInviteLink;
	room: MiChatRoom;
	owner: MiLocalUser;
	membersCount: number;
};

function hashKey(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class ChatInviteLinkService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomInviteLinksRepository)
		private chatRoomInviteLinksRepository: ChatRoomInviteLinksRepository,

		@Inject(DI.chatRoomInvitationsRepository)
		private chatRoomInvitationsRepository: ChatRoomInvitationsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		private idService: IdService,
		private userEntityService: UserEntityService,
		private chatRoomIconEntityService: ChatRoomIconEntityService,
		private avatarDecorationService: AvatarDecorationService,
		private apRendererService: ApRendererService,
		private apRequestService: ApRequestService,
		private queueService: QueueService,
		private systemAccountService: SystemAccountService,
		private hostPolicyService: HostPolicyService,
		private globalEventService: GlobalEventService,
		private chatRosterService: ChatRosterService,
		private chatRoomBanService: ChatRoomBanService,
		private chatService: ChatService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('chat-invite-link');
	}

	//#region 그룹장의 발급·조회·폐기

	private async ownedRoom(owner: MiUser, roomId: MiChatRoom['id']): Promise<MiChatRoom> {
		const room = owner.host == null ? await this.chatRoomsRepository.findOneBy({ id: roomId, ownerId: owner.id }) : null;
		if (room == null) throw new ChatRoomAccessError('no such room');
		return room;
	}

	@bindThis
	public async findLink(owner: MiUser, roomId: MiChatRoom['id']): Promise<MiChatRoomInviteLink | null> {
		const room = await this.ownedRoom(owner, roomId);
		return await this.chatRoomInviteLinksRepository.findOneBy({ roomId: room.id });
	}

	/** 링크가 없을 때만 발급한다. 있던 링크를 자동으로 폐기하거나 바꾸지 않는다 */
	@bindThis
	public async createLink(owner: MiUser, roomId: MiChatRoom['id']): Promise<MiChatRoomInviteLink> {
		const room = await this.ownedRoom(owner, roomId);
		return await this.db.transaction(async manager => {
			const locked = await this.lockRoom(manager, room.id);
			if (locked == null) throw new ChatRoomAccessError('no such room');
			if (locked.isArchived) throw new ChatRoomArchivedError('room is archived');
			if (await manager.existsBy(MiChatRoomInviteLink, { roomId: room.id })) throw new ChatInviteLinkExistsError();

			const link = { id: this.idService.gen(), roomId: room.id, code: generateChatInviteCode() };
			await manager.insert(MiChatRoomInviteLink, link);
			return { ...link, room: null };
		});
	}

	/** 폐기한 코드는 없는 주소가 된다. 이미 만든 개별 초대는 그대로다(그 Join은 폐기 전에 판정을 마쳤다) */
	@bindThis
	public async revokeLink(owner: MiUser, roomId: MiChatRoom['id']): Promise<void> {
		const room = await this.ownedRoom(owner, roomId);
		await this.db.transaction(async manager => {
			const locked = await this.lockRoom(manager, room.id);
			if (locked == null) throw new ChatRoomAccessError('no such room');
			if (locked.isArchived) throw new ChatRoomArchivedError('room is archived');
			const deleted = await manager.delete(MiChatRoomInviteLink, { roomId: room.id });
			if ((deleted.affected ?? 0) === 0) throw new ChatInviteLinkNotFoundError();
		});
	}

	@bindThis
	public packLink(link: MiChatRoomInviteLink): { url: string; code: string; createdAt: string } {
		return {
			url: chatInviteUrl(this.config.url, link.code),
			code: link.code,
			createdAt: this.idService.parse(link.id).date.toISOString(),
		};
	}

	//#endregion

	//#region 미리보기

	/** 이 서버가 발급한 유효한 링크와 그 그룹. 없는 코드·폐기된 링크·삭제된 그룹은 모두 null */
	@bindThis
	public async findLocalInvite(code: string): Promise<LocalInvite | null> {
		if (!isChatInviteCode(code)) return null;
		const link = await this.chatRoomInviteLinksRepository.findOneBy({ code });
		if (link == null) return null;
		const room = await this.chatRoomsRepository.findOneBy({ id: link.roomId });
		if (room == null) return null;
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || !this.userEntityService.isLocalUser(owner)) return null;
		const membersCount = await this.chatRoomMembershipsRepository.countBy({ roomId: room.id }) + 1;
		return { link, room, owner, membersCount };
	}

	private async localIcon(invite: LocalInvite): Promise<ChatInviteIcon> {
		const { iconUrl, iconBlurhash, iconDecorations } = await this.chatRoomIconEntityService.pack(invite.room, false, invite.owner);
		return { iconUrl, iconBlurhash, iconDecorations };
	}

	/** 발급 서버의 직접 초대 화면용. 멤버·채널·그룹장 정보는 공개하지 않는다 */
	@bindThis
	public async previewForViewer(code: string, me: MiUser | null): Promise<ChatInviteIcon & { name: string; description: string; membersCount: number; joinedRoomId: string | null } | null> {
		const invite = await this.findLocalInvite(code);
		if (invite == null) return null;
		const joined = me != null && await this.chatService.isRoomMember(invite.room, me.id);
		return {
			name: invite.room.name,
			description: invite.room.description ?? '',
			membersCount: invite.membersCount,
			joinedRoomId: joined ? invite.room.id : null,
			...await this.localIcon(invite),
		};
	}

	@bindThis
	public async renderLocalPreviewDocument(code: string): Promise<ChatInvitePreviewDocument | null> {
		const invite = await this.findLocalInvite(code);
		if (invite == null) return null;
		const icon = await this.localIcon(invite);
		const group = await this.apRendererService.renderChatRoom(invite.room, invite.owner);
		return renderChatInvitePreview({
			baseUrl: this.config.url, code: invite.link.code, room: invite.room, membersCount: invite.membersCount,
			icon: { url: icon.iconUrl, decorations: Array.isArray(group._misskey_chatIconDecorations) ? group._misskey_chatIconDecorations : [] },
		});
	}

	/**
	 * 다른 서버의 미리보기 문서를 대표 계정의 서명으로 새로 받는다. 캐시하지 않는다.
	 * 없는 링크(404·410)는 'gone', 미지원·형식 불일치·연결 실패는 null.
	 */
	private async fetchRemotePreview(target: ParsedChatInviteUrl): Promise<ChatInvitePreview | 'gone' | null> {
		if (await this.hostPolicyService.isRefusedRemoteHost(target.host)) return null;

		const actor = await this.systemAccountService.fetch('actor');
		let doc: unknown;
		try {
			doc = await this.apRequestService.signedGetJson(actor, target.url, PREVIEW_TIMEOUT_MS, { redirect: 'manual', size: PREVIEW_SIZE_LIMIT });
		} catch (err) {
			if (err instanceof StatusError && (err.statusCode === 404 || err.statusCode === 410)) return 'gone';
			this.logger.info(`Failed to fetch the invite preview of ${target.host}: ${err}`);
			return null;
		}
		return parseChatInvitePreview(doc, target.url);
	}

	/** 주소를 이 서버의 링크와 다른 서버의 링크로 나눈다. 다른 서버의 링크는 https만 받는다 */
	private resolveTarget(url: string): { target: ParsedChatInviteUrl; isLocal: boolean } | null {
		const target = parseChatInviteUrl(url, { allowHttp: true });
		if (target == null) return null;
		if (target.url === chatInviteUrl(this.config.url, target.code)) return { target, isLocal: true };
		if (!target.url.startsWith('https://') || target.host === this.config.host) return null;
		return { target, isLocal: false };
	}

	/**
	 * 타임라인·쪽지 카드(`/url`)의 초대 정보. 초대 주소가 아니거나 검증에 실패하면 null이고, 호출하는 쪽은 일반 미리보기로 넘어간다.
	 * 결과는 기존 미리보기 캐시를 그대로 탄다.
	 */
	@bindThis
	public async summarize(url: string): Promise<ChatInviteSummary | null> {
		const resolved = this.resolveTarget(url);
		if (resolved == null) return null;
		const { target, isLocal } = resolved;

		let info: ChatInviteIcon & { name: string; description: string; membersCount: number };
		if (isLocal) {
			const invite = await this.findLocalInvite(target.code);
			if (invite == null) return null;
			info = { name: invite.room.name, description: invite.room.description ?? '', membersCount: invite.membersCount, ...await this.localIcon(invite) };
		} else {
			const preview = await this.fetchRemotePreview(target);
			if (preview == null || preview === 'gone') return null;
			const decorations = await this.avatarDecorationService.resolveChatDecorations(target.host, preview.iconDecorations);
			info = {
				name: preview.name, description: preview.description, membersCount: preview.membersCount,
				iconUrl: preview.iconUrl != null ? this.avatarDecorationService.getProxiedUrl(preview.iconUrl, 'avatar') : this.chatRoomIconEntityService.getIdenticonUrl(preview.roomUri),
				iconBlurhash: null,
				iconDecorations: await this.avatarDecorationService.pack(decorations ?? []),
			};
		}

		return {
			url: target.url,
			title: info.name,
			description: info.description,
			icon: null,
			thumbnail: info.iconUrl,
			thumbnailStyle: null,
			sitename: null,
			player: { url: null, width: null, height: null, allow: [] },
			sensitive: false,
			activityPub: null,
			fediverseCreator: null,
			chatInvite: { url: target.url, host: target.host, code: target.code, ...info, isLocal },
		};
	}

	//#endregion

	//#region 참여 판정

	private async lockRoom(manager: EntityManager, roomId: MiChatRoom['id']): Promise<MiChatRoom | null> {
		return await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
	}

	/**
	 * 그룹 행을 잠근 뒤 링크를 다시 읽고 판정한다. 폐기·내보내기·다른 참여가 같은 잠금을 잡으므로
	 * 폐기와 진행 중 참여, 정원 직전의 동시 참여, 내보내기와 재참여가 한 순서로 정해진다.
	 */
	private async decideUnderLock(manager: EntityManager, roomId: MiChatRoom['id'], code: string, owner: MiLocalUser, userId: MiUser['id']): Promise<ReturnType<typeof decideChatJoin>> {
		const room = await this.lockRoom(manager, roomId);
		if (room == null) return 'revoked';
		const linkValid = await manager.existsBy(MiChatRoomInviteLink, { roomId, code });
		const isMember = room.ownerId === userId || await manager.existsBy(MiChatRoomMembership, { roomId, userId });
		return decideChatJoin({
			linkValid,
			isMember,
			isArchived: room.isArchived,
			// 그룹장이 내보낸 계정은 사면 전까지 유효한 링크로도 들이지 않는다. 이미 멤버면 그대로 둔다
			isBanned: !isMember && await this.chatRoomBanService.isBanned(roomId, userId, manager),
			// 참여 판정은 다른 프로세스에 남은 차단 캐시가 아니라 현재 DB 상태를 확인한다.
			blockedByOwner: !isMember && await manager.existsBy(MiBlocking, { blockerId: owner.id, blockeeId: userId }),
			isFull: !isMember && await manager.countBy(MiChatRoomMembership, { roomId }) >= MAX_ROOM_MEMBERS,
		});
	}

	//#endregion

	//#region 참여 요청 (API)

	/**
	 * 로그인한 사용자의 참여. 이 서버의 링크면 바로 멤버가 되고, 다른 서버의 링크면 그 서버에 Join을 보낸다.
	 * 캐시와 무관하게 최신 링크·자격을 확인한다.
	 */
	@bindThis
	public async join(user: MiLocalUser, url: string): Promise<{ status: 'joined'; roomId: string } | { status: 'pending'; roomId: null }> {
		const resolved = this.resolveTarget(url);
		if (resolved == null) throw new ChatInviteInvalidUrlError();
		if (resolved.isLocal) return { status: 'joined', roomId: await this.joinLocal(user, resolved.target.code) };
		const unlock = await acquireDistributedLock(this.redisClient, `chat-invite-join:${user.id}:${hashKey(resolved.target.url)}`, 30_000, 200, 100);
		try {
			return await this.requestRemoteJoin(user, resolved.target);
		} finally {
			await unlock();
		}
	}

	private async joinLocal(user: MiLocalUser, code: string): Promise<MiChatRoom['id']> {
		const invite = await this.findLocalInvite(code);
		if (invite == null) throw new ChatInviteJoinRefusedError('revoked');
		const { room, owner } = invite;

		const outcome = await this.db.transaction(async manager => {
			const decision = await this.decideUnderLock(manager, room.id, invite.link.code, owner, user.id);
			if (decision !== 'join') return { decision, membershipId: null, invitationDeleted: false };

			const membershipId = this.idService.gen();
			await manager.insert(MiChatRoomMembership, { id: membershipId, roomId: room.id, userId: user.id });
			// 받아 둔 개별 초대는 이 참여로 쓸모가 없어진다
			const deleted = await manager.delete(MiChatRoomInvitation, { roomId: room.id, userId: user.id });
			const joinedAt = this.idService.parse(membershipId).date;
			await this.chatRosterService.recordAccepted(room.id, user.id, joinedAt, manager);
			return { decision, membershipId, invitationDeleted: (deleted.affected ?? 0) > 0 };
		});

		if (outcome.decision === 'member') return room.id;
		if (outcome.membershipId == null) throw new ChatInviteJoinRefusedError(outcome.decision as ChatJoinRefusal);

		this.globalEventService.publishChatRoomStream(room.id, 'membershipStarted', { userId: user.id });
		this.chatService.notifyRoomListChanged(outcome.invitationDeleted ? [user.id, owner.id] : [user.id]);
		await this.chatService.announceNewRoomMember(room, owner, user, this.idService.parse(outcome.membershipId).date);
		return room.id;
	}

	private async requestRemoteJoin(user: MiLocalUser, target: ParsedChatInviteUrl): Promise<{ status: 'joined'; roomId: string } | { status: 'pending'; roomId: null }> {
		// 대기 중에 다시 눌러도 새 Join을 보내지 않는다. 그 사이 다른 초대로 이미 멤버가 됐다면 현재 상태를 돌려준다.
		const waiting = await this.intentByUrl(user.id, target.url);
		if (waiting?.state === 'pending') {
			const mirror = waiting.roomId != null
				? await this.chatRoomsRepository.findOneBy({ id: waiting.roomId })
				: await this.chatRoomsRepository.findOneBy({ uri: waiting.roomUri });
			if (mirror != null && await this.chatService.isRoomMember(mirror, user.id)) return { status: 'joined', roomId: mirror.id };
			return { status: 'pending', roomId: null };
		}

		const preview = await this.fetchRemotePreview(target);
		if (preview === 'gone') throw new ChatInviteJoinRefusedError('revoked');
		if (preview == null) throw new ChatInviteRemoteUnavailableError();

		const mirror = await this.chatRoomsRepository.findOneBy({ uri: preview.roomUri });
		if (mirror != null) {
			if (await this.chatService.isRoomMember(mirror, user.id)) {
				await this.rememberJoinedUrl(user.id, target.url, preview.roomUri);
				return { status: 'joined', roomId: mirror.id };
			}
			// 받아 둔 초대가 있으면 기존 수락 경로로 바로 수락한다. 수락하지 못하면 그룹 서버의 판정을 받으러 Join을 보낸다
			if (await this.chatRoomInvitationsRepository.existsBy({ roomId: mirror.id, userId: user.id })) {
				try {
					await this.chatService.joinToRoom(user.id, mirror.id);
					await this.rememberJoinedUrl(user.id, target.url, preview.roomUri);
					return { status: 'joined', roomId: mirror.id };
				} catch (err) {
					if (!(err instanceof ChatRoomAccessError || err instanceof ChatRoomArchivedError || err instanceof ChatRoomFullError)) throw err;
				}
			}
		}

		const joinId = `${this.config.url}/activities/${this.idService.gen()}`;
		// Invite가 Join보다 먼저 처리될 수 없도록 의사를 먼저 기록한다
		await this.saveIntent(user.id, {
			joinId,
			url: target.url,
			roomUri: preview.roomUri,
			state: 'pending',
			reason: null,
			roomId: mirror?.id ?? null,
			afterAccept: false,
		}, true);

		const activity = renderChatJoin({
			id: joinId,
			actor: this.userEntityService.genLocalUserUri(user.id),
			inviteUrl: target.url,
			published: new Date().toISOString(),
		});
		this.queueService.deliver(user, this.apRendererService.addContext(activity), preview.sharedInbox, true);
		return { status: 'pending', roomId: null };
	}

	/**
	 * 부작용 없는 상태 조회. 이 서버에서 그 그룹의 멤버면 joined, 아니면 최근 참여 요청의 상태.
	 * 자동 수락 뒤 그룹 서버가 Accept를 거절했으면 Remove가 늦게 와도 refused다.
	 */
	@bindThis
	public async joinStatus(user: MiLocalUser, url: string): Promise<ChatInviteJoinStatus> {
		const resolved = this.resolveTarget(url);
		if (resolved == null) throw new ChatInviteInvalidUrlError();
		const none = { status: 'none', roomId: null, reason: null } as const;

		if (resolved.isLocal) {
			const invite = await this.findLocalInvite(resolved.target.code);
			if (invite == null || !await this.chatService.isRoomMember(invite.room, user.id)) return none;
			return { status: 'joined', roomId: invite.room.id, reason: null };
		}

		const intent = await this.intentByUrl(user.id, resolved.target.url);
		if (intent == null) {
			const roomUri = await this.redisClient.get(this.joinedUrlKey(user.id, resolved.target.url));
			if (roomUri == null) return none;
			const room = await this.chatRoomsRepository.findOneBy({ uri: roomUri });
			return room != null && await this.chatService.isRoomMember(room, user.id)
				? { status: 'joined', roomId: room.id, reason: null }
				: none;
		}

		const mirror = intent.roomId != null
			? await this.chatRoomsRepository.findOneBy({ id: intent.roomId })
			: await this.chatRoomsRepository.findOneBy({ uri: intent.roomUri });
		if (mirror != null && await this.isMembershipBeyondRefusal(mirror, user.id, intent)) return { status: 'joined', roomId: mirror.id, reason: null };

		switch (intent.state) {
			case 'refused': return { status: 'refused', roomId: null, reason: intent.reason };
			case 'invited': return { status: 'invited', roomId: intent.roomId, reason: null };
			case 'pending': return { status: 'pending', roomId: null, reason: null };
			default: return none;
		}
	}

	//#endregion

	//#region 그룹 서버: Join 받기

	/**
	 * 서명된 Join. 그룹 행을 잠근 채 최신 링크·보관·금지·그룹장의 차단·정원을 판정하고,
	 * 통과하면 기존 형식의 Invite를, 아니면 대표 계정이 서명한 사유 있는 Reject를 보낸다.
	 * 이미 멤버면 다시 초대해 사본을 맞추고, 기존 멤버십은 건드리지 않는다.
	 */
	@bindThis
	public async receiveJoin(actor: MiRemoteUser, activity: IObject): Promise<string> {
		const joinId = activity.id;
		if (typeof joinId !== 'string' || joinId.length > 2048 || !this.isOnHostOf(joinId, actor.uri)) return 'skip: invalid Join id';
		if (apIdOf((activity as { actor?: unknown }).actor) !== actor.uri) return 'skip: invalid actor';

		const url = apIdOf((activity as { object?: unknown }).object);
		const target = url != null ? parseChatInviteUrl(url, { allowHttp: this.config.url.startsWith('http://') }) : null;
		if (target == null || target.url !== chatInviteUrl(this.config.url, target.code)) return 'skip: not an invite link of this server';
		const join = { id: joinId, actor: actor.uri, object: target.url };

		const invite = await this.findLocalInvite(target.code);
		if (invite == null) {
			await this.deliverJoinReject(actor, join, 'revoked');
			return 'ok: Join refused (revoked)';
		}
		const { room, owner } = invite;

		const outcome = await this.db.transaction(async manager => {
			const decision = await this.decideUnderLock(manager, room.id, target.code, owner, actor.id);
			if (decision !== 'join' && decision !== 'member') return { decision, invitationId: null };

			// 초대장은 (그룹, 사용자)당 하나. 같은 Join이 여러 번 와도 결과가 같다
			const existing = await manager.findOneBy(MiChatRoomInvitation, { roomId: room.id, userId: actor.id });
			const invitationId = existing?.id ?? this.idService.gen();
			if (existing == null) await manager.insert(MiChatRoomInvitation, { id: invitationId, roomId: room.id, userId: actor.id });
			// 차단 처리도 그룹 잠금 아래서 이 기록을 확인한다. 커밋이 실패해도 초대 ID가 다르면 다른 초대를 보호하지 않는다.
			await this.redisClient.set(chatInviteJoinInvitationKey(room.id, actor.id), JSON.stringify({ joinId, url: target.url, actor: actor.uri, invitationId } satisfies JoinInvitation), 'EX', JOIN_TTL_SECONDS);
			return { decision, invitationId };
		});

		if (outcome.invitationId == null) {
			await this.deliverJoinReject(actor, join, outcome.decision as ChatJoinRefusal);
			return `ok: Join refused (${outcome.decision})`;
		}

		await this.chatService.deliverRoomInvite(room, owner, actor, outcome.invitationId);
		return outcome.decision === 'member' ? 'ok: invited a member again' : 'ok: invited';
	}

	/** Join에 답해 보낸 초대의 Accept를 받아들이지 못했다. 기존 Remove에 더해 그 Join에 사유를 알린다 */
	@bindThis
	public async refuseAcceptedJoin(room: MiChatRoom, actor: MiRemoteUser, reason: ChatJoinRefusal): Promise<void> {
		const raw = await this.redisClient.getdel(chatInviteJoinInvitationKey(room.id, actor.id));
		const record = this.parseJoinInvitation(raw);
		if (record == null || record.actor !== actor.uri) return;
		await this.deliverJoinReject(actor, { id: record.joinId, actor: record.actor, object: record.url }, reason);
	}

	@bindThis
	public async forgetAcceptedJoin(roomId: MiChatRoom['id'], userId: MiUser['id']): Promise<void> {
		await this.redisClient.del(chatInviteJoinInvitationKey(roomId, userId));
	}

	private async deliverJoinReject(actor: MiRemoteUser, join: { id: string; actor: string; object: string }, reason: ChatJoinRefusal): Promise<void> {
		const instanceActor = await this.systemAccountService.fetch('actor');
		const reject = renderChatJoinReject({
			actor: this.userEntityService.genLocalUserUri(instanceActor.id),
			join,
			reason,
			published: new Date().toISOString(),
		});
		this.queueService.deliver(instanceActor, this.apRendererService.addContext({ ...reject, id: `${this.config.url}/activities/${this.idService.gen()}` }), actor.inbox, false);
	}

	private parseJoinInvitation(raw: string | null): JoinInvitation | null {
		if (raw == null) return null;
		try {
			const value = JSON.parse(raw) as Partial<JoinInvitation>;
			if (typeof value.joinId !== 'string' || typeof value.url !== 'string' || typeof value.actor !== 'string') return null;
			return { joinId: value.joinId, url: value.url, actor: value.actor };
		} catch {
			return null;
		}
	}

	//#endregion

	//#region 사본 서버: 그룹 서버의 답 받기

	/** 이 그룹에 대해 답을 기다리는(또는 자동 수락한) 참여 요청이 있는가 */
	@bindThis
	public async isAwaitingInvite(userId: MiUser['id'], roomUri: string): Promise<boolean> {
		const intent = await this.intentByRoom(userId, roomUri);
		if (intent?.state === 'pending') return true;
		if (intent?.state !== 'joined') return false;
		const mirror = await this.chatRoomsRepository.findOneBy({ uri: roomUri });
		return mirror != null && await this.chatService.isRoomMember(mirror, userId);
	}

	/**
	 * 그룹 서버의 Invite가 왔다. 이 사용자가 그 그룹에 참여를 요청해 두었으면 기존 수락 경로로 수락한다.
	 * 요청이 없거나 이미 거절·만료됐으면 아무것도 하지 않는다(관계없는 초대를 자동으로 수락하지 않음).
	 */
	@bindThis
	public async acceptAwaitedInvite(invitee: MiLocalUser, room: MiChatRoom, roomUri: string): Promise<'none' | 'joined' | 'invited'> {
		const intent = await this.intentByRoom(invitee.id, roomUri);
		if (intent == null || (intent.state !== 'pending' && intent.state !== 'joined')) return 'none';
		// 자동 수락으로 들어갔다가 스스로 나간 뒤 같은 Invite가 다시 와도 다시 넣지 않는다. 보통의 초대로 남긴다.
		// 아직 멤버면 호스트가 수락을 못 받았을 수 있으므로 기존처럼 다시 수락한다
		if (intent.state === 'joined' && !await this.chatService.isRoomMember(room, invitee.id)) return 'none';

		try {
			await this.chatService.joinToRoom(invitee.id, room.id);
		} catch (err) {
			if (!(err instanceof ChatRoomAccessError || err instanceof ChatRoomArchivedError || err instanceof ChatRoomFullError)) throw err;
			this.logger.info(`Could not accept the invitation to ${roomUri} that ${invitee.id} asked for: ${err}`);
			await this.saveIntent(invitee.id, { ...intent, state: 'invited', roomId: room.id }, false);
			this.publishResult(invitee.id, intent.url, { status: 'invited', roomId: room.id, reason: null });
			return 'invited';
		}

		const membership = await this.chatRoomMembershipsRepository.findOneBy({ roomId: room.id, userId: invitee.id });
		await this.saveIntent(invitee.id, { ...intent, state: 'joined', roomId: room.id, membershipId: membership?.id ?? null }, false);
		if (intent.state === 'pending') this.publishResult(invitee.id, intent.url, { status: 'joined', roomId: room.id, reason: null });
		return 'joined';
	}

	/**
	 * 지금 멤버이고, 그 멤버십이 이 Join의 거절과 관계없는지. 자동 수락으로 만든 바로 그 멤버십이 거절됐으면 호스트가
	 * 그 수락을 받아들이지 않은 것이며 멤버십은 호스트의 Remove로 끝난다. 그 뒤 다른 경로로 새로 생긴 멤버십은 가리지 않는다
	 */
	private async isMembershipBeyondRefusal(mirror: MiChatRoom, userId: MiUser['id'], intent: JoinIntent): Promise<boolean> {
		if (!await this.chatService.isRoomMember(mirror, userId)) return false;
		if (intent.state !== 'refused' || !intent.afterAccept || intent.membershipId == null) return true;
		const membership = await this.chatRoomMembershipsRepository.findOneBy({ roomId: mirror.id, userId });
		return membership != null && membership.id !== intent.membershipId;
	}

	/**
	 * 그룹 서버의 거절. 이 서버가 보낸 바로 그 Join에 대한 것만 받는다.
	 * 참여 요청의 상태만 바꾸고 멤버십은 지우지 않는다. 자동 수락을 취소하는 것은 그룹 서버의 기존 Remove다.
	 */
	@bindThis
	public async receiveJoinReject(actor: MiRemoteUser, reject: IObject): Promise<string> {
		const join = (reject as { object?: unknown }).object;
		if (typeof join !== 'object' || join == null || Array.isArray(join)) return 'skip: the Join is not embedded';
		const joinActor = apIdOf((join as { actor?: unknown }).actor);
		const localPrefix = `${this.config.url}/users/`;
		if (joinActor == null || !joinActor.startsWith(localPrefix)) return 'skip: not a Join from this server';
		const userId = joinActor.slice(localPrefix.length);

		const url = apIdOf((join as { object?: unknown }).object);
		const target = url != null ? parseChatInviteUrl(url) : null;
		if (target == null) return 'skip: not a Join with an invite link';

		const intent = await this.intentByUrl(userId, target.url);
		if (intent == null || intent.state === 'refused') return 'skip: no Join awaiting an answer';

		const answer = parseChatJoinReject(reject, { joinId: intent.joinId, actor: joinActor, inviteUrl: intent.url, signerUri: actor.uri });
		if (answer == null) return 'skip: the Reject does not answer the Join awaiting it';

		const afterAccept = intent.state !== 'pending';
		const refused = { ...intent, state: 'refused', reason: answer.reason, afterAccept } as const;
		await this.saveIntent(userId, refused, false);
		// 그 사이 다른 경로(개별 초대 등)로 이미 멤버가 됐으면 이 Join의 거절은 그 멤버십과 관계없다
		const mirror = await this.chatRoomsRepository.findOneBy({ uri: intent.roomUri });
		if (mirror != null && await this.isMembershipBeyondRefusal(mirror, userId, refused)) {
			this.publishResult(userId, intent.url, { status: 'joined', roomId: mirror.id, reason: null });
		} else {
			this.publishResult(userId, intent.url, { status: 'refused', roomId: null, reason: answer.reason });
		}
		return `ok: Join refused (${answer.reason})`;
	}

	private publishResult(userId: MiUser['id'], url: string, result: { status: 'joined' | 'invited' | 'refused'; roomId: string | null; reason: ChatJoinRefusalReceived | null }): void {
		this.globalEventService.publishMainStream(userId, 'chatInviteJoinResult', { url, ...result });
	}

	//#endregion

	//#region 참여 요청 기록

	private intentKey(userId: MiUser['id'], roomUri: string): string {
		return `chatInviteJoin:${userId}:${hashKey(roomUri)}`;
	}

	private intentUrlKey(userId: MiUser['id'], url: string): string {
		return `chatInviteJoinUrl:${userId}:${hashKey(url)}`;
	}

	private joinedUrlKey(userId: MiUser['id'], url: string): string {
		return `chatInviteJoinedUrl:${userId}:${hashKey(url)}`;
	}

	private async rememberJoinedUrl(userId: MiUser['id'], url: string, roomUri: string): Promise<void> {
		await this.redisClient.set(this.joinedUrlKey(userId, url), roomUri, 'EX', JOIN_TTL_SECONDS);
	}

	/** 새 요청은 유효 시간을 새로 잡고, 상태 변경은 남은 시간을 유지한다 */
	private async saveIntent(userId: MiUser['id'], intent: JoinIntent, fresh: boolean): Promise<void> {
		const value = JSON.stringify(intent);
		if (fresh) {
			await this.redisClient.multi()
				.set(this.intentKey(userId, intent.roomUri), value, 'EX', JOIN_TTL_SECONDS)
				.set(this.intentUrlKey(userId, intent.url), intent.roomUri, 'EX', JOIN_TTL_SECONDS)
				.exec();
		} else {
			await this.redisClient.set(this.intentKey(userId, intent.roomUri), value, 'KEEPTTL', 'XX');
		}
	}

	private async intentByRoom(userId: MiUser['id'], roomUri: string): Promise<JoinIntent | null> {
		const raw = await this.redisClient.get(this.intentKey(userId, roomUri));
		if (raw == null) return null;
		try {
			const value = JSON.parse(raw) as JoinIntent;
			return typeof value.joinId === 'string' && typeof value.url === 'string' && value.roomUri === roomUri ? value : null;
		} catch {
			return null;
		}
	}

	/** 같은 그룹에 다른 코드로 새로 요청했으면 예전 주소의 기록은 없는 것으로 본다 */
	private async intentByUrl(userId: MiUser['id'], url: string): Promise<JoinIntent | null> {
		const roomUri = await this.redisClient.get(this.intentUrlKey(userId, url));
		if (roomUri == null) return null;
		const intent = await this.intentByRoom(userId, roomUri);
		return intent?.url === url ? intent : null;
	}

	//#endregion

	private isOnHostOf(uri: string, actorUri: string): boolean {
		try {
			return new URL(uri).host === new URL(actorUri).host;
		} catch {
			return false;
		}
	}
}
