/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull } from 'typeorm';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository, UsersRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { RoleService } from '@/core/RoleService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';

const REFRESH_DELAY_MS = 500;

// LiveKit が再起動して room_finished を送らなかった場合でも表示が残らないよう、
// スナップショットには寿命を付け、通話中のルームは定期的に読み直す
const SNAPSHOT_TTL_SECONDS = 120;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_LOCK_SECONDS = 50;
const ACTIVE_ROOMS_KEY = 'chatVoice:active';

// 他のサーバーが持つルーム (ミラー) の通話は、このサーバーから読み直せない。
// メンバーが参加するたびにホストから届く現況を、これだけの間だけ表示する
const REMOTE_SNAPSHOT_TTL_SECONDS = 600;

// 参加者の出入りや画面共有の開始・終了に関わるイベントだけを扱う
const REFRESH_EVENTS = new Set([
	'room_started',
	'room_finished',
	'participant_joined',
	'participant_left',
	'participant_connection_aborted',
	'track_published',
	'track_unpublished',
]);

type VoiceSnapshot = {
	participants: { identity: string; userId: MiUser['id']; screenSharing: boolean }[];
	updatedAt: number;
};

/** 他のサーバーに渡す参加者の現況。userId はこのサーバーの DB の id なので含めない */
type FederatedVoiceSnapshot = {
	participants: { identity: string; screenSharing: boolean }[];
	updatedAt: number;
};

/**
 * チャットルームの通話参加者のスナップショットを Redis に保持し、ストリームへ配信する。
 */
@Injectable()
export class ChatVoiceService implements OnModuleInit, OnApplicationShutdown {
	private pendingRefreshes = new Map<MiChatRoom['id'], NodeJS.Timeout>();
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private liveKitService: LiveKitService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private roleService: RoleService,
		private utilityService: UtilityService,
		private federatedInstanceService: FederatedInstanceService,
	) {
	}

	@bindThis
	public async issueJoinToken(user: MiLocalUser | MiRemoteUser, room: MiChatRoom, canScreenShare: boolean): Promise<{ url: string; token: string }> {
		await this.liveKitService.ensureRoom(room.id, MAX_ROOM_MEMBERS + 1);
		const token = await this.liveKitService.createJoinToken({
			roomId: room.id,
			identity: this.liveKitService.identityOf(user),
			userId: user.id,
			canScreenShare,
		});
		return { url: this.liveKitService.getPublicUrl(), token };
	}

	/**
	 * 他のサーバーのユーザーに、このサーバーが持つルームの通話トークンを発行する。
	 * room は owner を読み込んだもの (ChatService.findRoomById) を渡す。owner が無ければ断る。
	 * 画面共有は、相手のサーバーが求め (canScreenShareRequested)、こちらのポリシーも許すときだけ認める
	 */
	@bindThis
	public async issueRemoteJoinToken(user: MiRemoteUser, room: MiChatRoom, canScreenShareRequested: boolean): Promise<({ url: string; token: string } & FederatedVoiceSnapshot) | 'forbidden'> {
		// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーで開く。保管済みのルームはローカルと同じく断る
		if (room.owner == null || room.owner.host != null || room.isArchived) return 'forbidden';

		if (user.isSuspended) return 'forbidden';
		if (!this.utilityService.isFederationAllowedHost(user.host)) return 'forbidden';
		const instance = await this.federatedInstanceService.fetch(user.host);
		if (instance != null && instance.suspensionState !== 'none') return 'forbidden';

		const isMember = await this.chatRoomMembershipsRepository.exists({ where: { roomId: room.id, userId: user.id } });
		if (!isMember) return 'forbidden';

		// トークンは常にマイクを許すので、ローカルの参加と同じくチャットの書き込み権限も求める
		const policies = await this.roleService.getUserPolicies(user.id);
		if (!policies.canVoiceCall || policies.chatAvailability !== 'available') return 'forbidden';

		const { url, token } = await this.issueJoinToken(user, room, canScreenShareRequested && policies.canScreenShare);
		const { participants, updatedAt } = await this.snapshotOf(room.id);
		return { url, token, participants, updatedAt };
	}

	/**
	 * 保存してある参加者の現況。通話が無ければ、今の時刻で空の一覧を返す
	 */
	@bindThis
	public async snapshotOf(roomId: MiChatRoom['id']): Promise<FederatedVoiceSnapshot> {
		const raw = await this.redisClient.get(this.keyOf(roomId));
		if (raw == null) return { participants: [], updatedAt: Date.now() };
		const snapshot = JSON.parse(raw) as VoiceSnapshot;
		return {
			participants: snapshot.participants.map(p => ({ identity: p.identity, screenSharing: p.screenSharing })),
			updatedAt: snapshot.updatedAt,
		};
	}

	@bindThis
	public async getStates(me: { id: MiUser['id'] }, roomIds: MiChatRoom['id'][]): Promise<Packed<'ChatRoomVoiceState'>[]> {
		if (roomIds.length === 0) return [];
		const raws = await this.redisClient.mget(...roomIds.map(roomId => this.keyOf(roomId)));
		const states: Packed<'ChatRoomVoiceState'>[] = [];
		for (let i = 0; i < roomIds.length; i++) {
			const raw = raws[i];
			if (raw == null) continue;
			const snapshot = JSON.parse(raw) as VoiceSnapshot;
			if (snapshot.participants.length === 0) continue;
			states.push(await this.pack(roomIds[i], snapshot, me));
		}
		return states;
	}

	@bindThis
	public handleWebhook(event: WebhookEvent): void {
		if (!REFRESH_EVENTS.has(event.event)) return;
		const roomName = event.room?.name;
		if (roomName == null) return;
		const roomId = this.liveKitService.roomIdOf(roomName);
		if (roomId == null) return;
		this.scheduleRefresh(roomId);
	}

	@bindThis
	public scheduleRefresh(roomId: MiChatRoom['id']): void {
		if (this.pendingRefreshes.has(roomId)) return;
		this.pendingRefreshes.set(roomId, setTimeout(() => {
			this.pendingRefreshes.delete(roomId);
			this.refresh(roomId).catch(() => {
				// 次の webhook か通話参加時に再取得されるので握りつぶす
			});
		}, REFRESH_DELAY_MS));
	}

	@bindThis
	public async refresh(roomId: MiChatRoom['id']): Promise<void> {
		const participants = await this.liveKitService.listParticipants(roomId);
		const snapshot: VoiceSnapshot = {
			participants: participants.map(p => ({ identity: p.identity, userId: p.userId, screenSharing: p.screenSharing })),
			updatedAt: Date.now(),
		};

		if (snapshot.participants.length === 0) {
			await this.redisClient.del(this.keyOf(roomId));
			await this.redisClient.srem(ACTIVE_ROOMS_KEY, roomId);
		} else {
			await this.redisClient.set(this.keyOf(roomId), JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL_SECONDS);
			await this.redisClient.sadd(ACTIVE_ROOMS_KEY, roomId);
		}

		const packed = await this.pack(roomId, snapshot, null);
		this.globalEventService.publishChatRoomStream(roomId, 'voiceState', packed);

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return;
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId });
		const memberIds = new Set([room.ownerId, ...memberships.map(m => m.userId)]);
		for (const userId of memberIds) {
			this.globalEventService.publishMainStream(userId, 'chatRoomVoiceState', packed);
		}
	}

	/**
	 * 他のサーバーが持つルーム (ミラー) について、ホストから届いた参加者の現況を保存し、このサーバーのメンバーに知らせる。
	 * updatedAt はホストの時刻。保存済みのもの以前の現況は捨てる。
	 * ミラーの通話はこのサーバーの LiveKit には無いので、定期的な読み直し (sweep) の対象には加えない
	 */
	@bindThis
	public async storeRemoteSnapshot(room: MiChatRoom, participants: { identity: string; screenSharing: boolean }[], updatedAt: number): Promise<void> {
		const capped = participants.slice(0, MAX_ROOM_MEMBERS + 1);
		const userIds = await this.knownUserIdsOf(capped.map(p => p.identity));
		const snapshot: VoiceSnapshot = { participants: [], updatedAt };
		for (const p of capped) {
			const userId = userIds.get(p.identity);
			if (userId != null) snapshot.participants.push({ identity: p.identity, userId, screenSharing: p.screenSharing });
		}

		// 解決している間に新しい現況が保存されたかもしれないので、書く直前に比べる
		const stored = await this.redisClient.get(this.keyOf(room.id));
		if (stored != null && (JSON.parse(stored) as VoiceSnapshot).updatedAt >= updatedAt) return;

		// 空になったときも時刻ごと残し、遅れて届いた古い現況で上書きされないようにする (getStates は空のものを返さない)
		await this.redisClient.set(this.keyOf(room.id), JSON.stringify(snapshot), 'EX', REMOTE_SNAPSHOT_TTL_SECONDS);

		const packed = await this.pack(room.id, snapshot, null);
		this.globalEventService.publishChatRoomStream(room.id, 'voiceState', packed);

		// 持ち主は他のサーバーのユーザーなので、このサーバーのメンバーにだけ知らせる
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id, user: { host: IsNull() } });
		for (const membership of memberships) {
			this.globalEventService.publishMainStream(membership.userId, 'chatRoomVoiceState', packed);
		}
	}

	/**
	 * 通話中のルームを LiveKit から読み直す。複数のワーカーが同時に動いても、各ルームを読むのは一つだけ
	 */
	@bindThis
	public async sweep(): Promise<void> {
		const roomIds = await this.redisClient.smembers(ACTIVE_ROOMS_KEY);
		for (const roomId of roomIds) {
			const locked = await this.redisClient.set(`chatVoice:sweep:${roomId}`, '1', 'EX', SWEEP_LOCK_SECONDS, 'NX');
			if (locked !== 'OK') continue;
			await this.refresh(roomId).catch(() => {
				// LiveKit に届かなければスナップショットの寿命切れに任せる
			});
		}
	}

	@bindThis
	public onModuleInit(): void {
		if (!this.liveKitService.isEnabled) return;
		this.sweepTimer = setInterval(() => {
			this.sweep().catch(() => {});
		}, SWEEP_INTERVAL_MS);
	}

	@bindThis
	public onApplicationShutdown(): void {
		for (const timer of this.pendingRefreshes.values()) clearTimeout(timer);
		this.pendingRefreshes.clear();
		if (this.sweepTimer != null) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
	}

	private keyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:${roomId}`;
	}

	/**
	 * 参加者の identity (LiveKitService.identityOf) を、このサーバーが既に知っているユーザーの id にする。
	 * identity は他のサーバーから届くので、知らないユーザーを取りに行くことはしない (相手に好きな URL を取得させないため)。
	 * このサーバーの `${url}/users/<id>` はその id のローカルユーザー、それ以外は uri が一致するリモートユーザー。
	 * 削除済みのユーザーと、どれにも当たらない identity は含めない
	 */
	private async knownUserIdsOf(identities: string[]): Promise<Map<string, MiUser['id']>> {
		const localPrefix = `${this.config.url}/users/`;
		const localIdentityOf = new Map<MiUser['id'], string>();
		const remoteIdentities: string[] = [];
		for (const identity of identities) {
			if (identity.startsWith(localPrefix)) {
				const userId = identity.slice(localPrefix.length);
				if (/^[a-zA-Z0-9]+$/.test(userId)) localIdentityOf.set(userId, identity);
			} else {
				remoteIdentities.push(identity);
			}
		}

		const [localUsers, remoteUsers] = await Promise.all([
			localIdentityOf.size > 0
				? this.usersRepository.findBy({ id: In([...localIdentityOf.keys()]), host: IsNull(), isDeleted: false })
				: [],
			remoteIdentities.length > 0
				? this.usersRepository.findBy({ uri: In(remoteIdentities), isDeleted: false })
				: [],
		]);

		const result = new Map<string, MiUser['id']>();
		for (const user of localUsers) {
			const identity = localIdentityOf.get(user.id);
			if (identity != null) result.set(identity, user.id);
		}
		for (const user of remoteUsers) {
			if (user.host != null && user.uri != null) result.set(user.uri, user.id);
		}
		return result;
	}

	private async pack(roomId: MiChatRoom['id'], snapshot: VoiceSnapshot, me: { id: MiUser['id'] } | null): Promise<Packed<'ChatRoomVoiceState'>> {
		const users = await this.userEntityService.packMany(snapshot.participants.map(p => p.userId), me);
		const usersById = new Map(users.map(user => [user.id, user]));
		const participants: Packed<'ChatRoomVoiceState'>['participants'] = [];
		for (const p of snapshot.participants) {
			const user = usersById.get(p.userId);
			if (user == null) continue;
			participants.push({ identity: p.identity, user, screenSharing: p.screenSharing });
		}
		return { roomId, participants };
	}
}
