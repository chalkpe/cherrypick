/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull } from 'typeorm';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository, UsersRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiMeta } from '@/models/Meta.js';
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
import { QueueService } from '@/core/QueueService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import type { IObject } from '@/core/activitypub/type.js';

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

// 他のサーバーのメンバーには、参加者が変わったときのほか、変わらなくてもこの間隔で送り直してミラーの寿命を延ばす。
// 送り直しは読み直し (sweep) のついでに行うので、実際の間隔は最大でこれに SWEEP_INTERVAL_MS を足したものになる
const FEDERATION_RESEND_INTERVAL_MS = 240_000;

// 参加者が目まぐるしく変わっても (画面共有の切り替えや出入りの繰り返し) 配送が膨らまないよう、
// 他のサーバーへはルームごとにこの間隔に一度だけ送る。全ワーカーで Redis の鍵を共有して数える
const FEDERATION_MIN_INTERVAL_MS = 10_000;

// 他のサーバーから届くルームの URI のパス (このサーバーが送る `${url}/chat/rooms/${id}` と同じ形)
const ROOM_PATH = /^\/chat\/rooms\/([a-zA-Z0-9]+)$/;

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

/** このサーバーのユーザーが他のサーバーの通話に入れるか (features.remoteVoiceCall と同じ) */
export function isRemoteVoiceCallEnabled(meta: Pick<MiMeta, 'enableRemoteVoiceCall' | 'federation'>): boolean {
	return meta.enableRemoteVoiceCall && meta.federation !== 'none';
}

/**
 * チャットルームの通話参加者のスナップショットを Redis に保持し、ストリームへ配信する。
 */
@Injectable()
export class ChatVoiceService implements OnModuleInit, OnApplicationShutdown {
	private pendingRefreshes = new Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>();
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

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
		private apRendererService: ApRendererService,
		private queueService: QueueService,
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

	/**
	 * ルームを少し後に読み直す。ルームごとに一つにまとめ、予定済みのものより早く読み直したいときだけ早める
	 */
	@bindThis
	public scheduleRefresh(roomId: MiChatRoom['id'], delayMs = REFRESH_DELAY_MS): void {
		const dueAt = Date.now() + delayMs;
		const pending = this.pendingRefreshes.get(roomId);
		if (pending != null) {
			if (pending.dueAt <= dueAt) return;
			clearTimeout(pending.timer);
		}
		const timer = setTimeout(() => {
			this.pendingRefreshes.delete(roomId);
			this.refresh(roomId).catch(() => {
				// 次の webhook か通話参加時に再取得されるので握りつぶす
			});
		}, delayMs);
		this.pendingRefreshes.set(roomId, { timer, dueAt });
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

		await this.federateChanges(room, snapshot);
	}

	/**
	 * このサーバーが持つルームの通話の参加者の現況を、他のサーバーのメンバーに届ける。
	 * 持ち主の名前で Update を作り、メンバーの inbox (共有 inbox があればそちら) ごとに一度だけ送る
	 */
	@bindThis
	public async federateSnapshot(room: MiChatRoom, participants: { identity: string; screenSharing: boolean }[], updatedAt: number): Promise<void> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const users = await this.usersRepository.findBy({ id: In([room.ownerId, ...memberships.map(m => m.userId)]) });

		// 他のサーバーが持つルーム (ミラー) の現況は、そのサーバーが送る
		const owner = users.find(user => user.id === room.ownerId);
		if (owner == null || owner.host != null) return;

		const inboxes = new Map<string, boolean>();
		for (const user of users) {
			if (user.host == null) continue;
			const inbox = user.sharedInbox ?? user.inbox;
			if (inbox != null && !inboxes.has(inbox)) inboxes.set(inbox, user.sharedInbox != null);
		}
		if (inboxes.size === 0) return;

		// 通話の参加者はルームのメンバーにだけ知らせるものなので、公開 (Public) 宛てにはしない
		const activity = this.apRendererService.addContext({
			type: 'Update',
			actor: this.userEntityService.genLocalUserUri(owner.id),
			object: this.apRendererService.renderChatRoomVoiceState(room, participants, updatedAt),
			published: new Date(updatedAt).toISOString(),
		});
		for (const [inbox, isSharedInbox] of inboxes) {
			this.queueService.deliver(owner, activity, inbox, isSharedInbox);
		}
	}

	/**
	 * 他のサーバーが持つルーム (ミラー) の持ち主から届いた、通話の参加者の現況 (ChatRoomVoiceState) を受け取る。
	 * 現況とルームの URI がどちらも送り主と同じサーバー (スキーム・ホスト・ポート) のもので、
	 * そのルームがこのサーバーのミラーであり、送り主がその持ち主のときだけ保存する。戻り値は inbox のログ用
	 */
	@bindThis
	public async receiveRemoteSnapshot(actor: MiRemoteUser, object: IObject): Promise<string> {
		if (!isRemoteVoiceCallEnabled(this.meta)) return 'skip: remote voice calls are disabled';

		const state = object as IObject & { room?: unknown; participants?: unknown };
		if (typeof state.id !== 'string' || typeof state.room !== 'string') return 'skip: invalid voice state';

		const origin = originOf(actor.uri);
		if (origin == null || originOf(state.id) !== origin || originOf(state.room) !== origin) {
			return 'skip: voice state is not on the sender\'s server';
		}

		const roomId = roomIdOfUri(state.room);
		if (roomId == null) return 'skip: invalid room URI';

		const participants = parseParticipants(state.participants);
		if (participants == null) return 'skip: invalid participants';

		const updatedAt = typeof state.updated === 'string' ? Date.parse(state.updated) : NaN;
		if (!Number.isFinite(updatedAt)) return 'skip: invalid updated';

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return 'skip: unknown room';
		// 送り主は他のサーバーのユーザーなので、送り主が持ち主ならそのルームはミラー
		if (room.ownerId !== actor.id) return 'skip: sender does not own the room';

		await this.storeRemoteSnapshot(room, participants, updatedAt);
		return 'ok: voice state stored';
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
		for (const { timer } of this.pendingRefreshes.values()) clearTimeout(timer);
		this.pendingRefreshes.clear();
		if (this.sweepTimer != null) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
	}

	private keyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:${roomId}`;
	}

	/**
	 * 参加者の現況を他のサーバーのメンバーに届ける。
	 * - 前に送ったものと同じで、送ってから FEDERATION_RESEND_INTERVAL_MS 経っていなければ送らない
	 * - 送るのはルームごとに FEDERATION_MIN_INTERVAL_MS に一度まで。送れなかった変化は、間隔が空いたときに読み直して最新の現況を送る
	 * - 通話が終わったこと (空の現況) は参加者の現況とは別に数えて待たずに送るが、続けて終わったときは最初のものだけを送る
	 */
	private async federateChanges(room: MiChatRoom, snapshot: VoiceSnapshot): Promise<void> {
		const participants = snapshot.participants.map(p => ({ identity: p.identity, screenSharing: p.screenSharing }));
		const hash = createHash('sha256')
			.update(JSON.stringify([...participants].sort((a, b) => a.identity.localeCompare(b.identity))))
			.digest('hex');
		const key = `chatVoice:federated:${room.id}`;

		const raw = await this.redisClient.get(key);
		const last = raw != null ? JSON.parse(raw) as { hash: string; at: number } : null;
		if (participants.length > 0 && last != null && last.hash === hash && Date.now() - last.at < FEDERATION_RESEND_INTERVAL_MS) return;

		const gateKey = participants.length > 0 ? `chatVoice:federateGate:${room.id}` : `chatVoice:federateEmptyGate:${room.id}`;
		const opened = await this.redisClient.set(gateKey, '1', 'PX', FEDERATION_MIN_INTERVAL_MS, 'NX');
		if (opened !== 'OK') {
			// 相手に届いている現況と違うなら、間隔が空いたときに読み直す (読み直しはルームごとに一つにまとまる)
			if (last?.hash !== hash) {
				const ttl = await this.redisClient.pttl(gateKey);
				this.scheduleRefresh(room.id, ttl > 0 ? Math.min(ttl, FEDERATION_MIN_INTERVAL_MS) : REFRESH_DELAY_MS);
			}
			return;
		}

		await this.federateSnapshot(room, participants, snapshot.updatedAt);
		await this.redisClient.set(key, JSON.stringify({ hash, at: Date.now() }), 'EX', FEDERATION_RESEND_INTERVAL_MS / 1000);
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

/**
 * URL の出所 (スキーム・ホスト・ポート)。http(s) の URL でなければ null。
 * ホストの比較に UtilityService.extractDbHost を使うと、ポート付きのホストはすべて '' になって区別できない
 */
function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
	} catch {
		return null;
	}
}

/** `${origin}/chat/rooms/${id}` の形のルーム URI から id を取り出す。クエリ・フラグメント・認証情報の付いたものは受け付けない */
function roomIdOfUri(uri: string): string | null {
	const url = new URL(uri);
	if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null;
	return ROOM_PATH.exec(url.pathname)?.[1] ?? null;
}

/** ChatRoomVoiceState の participants を確かめる。形が違うか、ルームに入れる人数より多ければ null */
function parseParticipants(value: unknown): { identity: string; screenSharing: boolean }[] | null {
	if (!Array.isArray(value) || value.length > MAX_ROOM_MEMBERS + 1) return null;

	const parsed: { identity: string; screenSharing: boolean }[] = [];
	for (const participant of value as unknown[]) {
		if (typeof participant !== 'object' || participant == null) return null;
		const { id, screenSharing } = participant as Record<string, unknown>;
		if (typeof id !== 'string' || typeof screenSharing !== 'boolean') return null;
		parsed.push({ identity: id, screenSharing });
	}
	return parsed;
}
