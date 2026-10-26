/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, MoreThan, Not } from 'typeorm';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository, InstancesRepository, UsersRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { LiveKitService, userIdOfMetadata } from '@/core/LiveKitService.js';
import type { LiveKitParticipant } from '@/core/LiveKitService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { RoleService } from '@/core/RoleService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { hostLookupCandidates, isHostInList, normalizeHost } from '@/core/ActivityPubAccessControlService.js';
import { QueueService } from '@/core/QueueService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { parseChatRoomVoiceState } from '@/core/activitypub/misc/chat-room-voice-state.js';
import type { IObject } from '@/core/activitypub/type.js';
import { LoggerService } from '@/core/LoggerService.js';
import { CloudflareTurnService } from '@/core/CloudflareTurnService.js';
import type { IceServer } from '@/core/CloudflareTurnService.js';

const REFRESH_DELAY_MS = 500;

// LiveKit が再起動して room_finished を送らなかった場合でも表示が残らないよう、
// スナップショットには寿命を付け、通話中のルームは定期的に読み直す。
// 読み直すたびに、いまルームに残れない参加者 (メンバーでなくなった、サーバーが断られた) も外す
const SNAPSHOT_TTL_SECONDS = 120;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_LOCK_SECONDS = 50;
const ACTIVE_ROOMS_KEY = 'chatVoice:active';

// 他のサーバーが持つルーム (ミラー) の通話は、このサーバーから読み直せない。
// メンバーが参加するたびにホストから届く現況を、これだけの間だけ表示する
const REMOTE_SNAPSHOT_TTL_SECONDS = 600;

// ホストの時計がこれより先の時刻を付けた現況は捨てる。受け入れると、寿命が切れるまでホストが新しい現況で上書きできなくなる
const REMOTE_SNAPSHOT_MAX_AHEAD_MS = 300_000;

// ミラーの現況について、最後に受け入れた時刻 (updatedAt) を現況の寿命より長く覚えておく。
// 配送は既定で 12 回まで間隔を延ばしながらやり直す (最後のやり直しまで最大で約 39 時間) ので、通話の終わりを保存した鍵が切れた後に
// 終わる前の現況が届き、終わった通話が戻ることがある。受け取った側の inbox のやり直し (約 5 時間) を足しても収まるよう、2 日覚えておく
const REMOTE_SNAPSHOT_LAST_SEEN_TTL_SECONDS = 172_800;

// 他のサーバーの通話を止めたときにミラーの現況を消すとき、一度に引くルームの数
const MIRROR_CLEAR_BATCH_SIZE = 1000;

// 他のサーバーの通話を止めるたびに増やす数 (世代)。ミラーの現況を書くスクリプトは、書き始める前に読んだ世代と比べ、変わっていれば書かない。
// 止めたときは、世代を増やしてからミラーの現況を消すので、どのワーカーの書き込みも、消す前に終わって消されるか、世代が変わって断られる
const REMOTE_GENERATION_KEY = 'chatVoice:remoteGeneration';

// ミラーの現況を、他のサーバーの通話を止めておらず (世代が読んだときのまま)、保存済みのものと、最後に受け入れた時刻の
// どちらよりも新しい (updatedAt が大きい) ときだけ書く。書いたら 1、古ければ 0、世代が変わっていれば 2。
// 書いたら、その時刻を最後に受け入れた時刻として残す (空の現況でも残す)。
// 比べてから書くまでを一つの操作にして、同時に届いた古い現況が新しい現況を上書きしないようにする。
// 保存済みのものや時刻が読めなければ、無いものとして扱う。世代の鍵が無ければ '0' とする。
// KEYS[1]: 現況の鍵、KEYS[2]: 最後に受け入れた時刻の鍵、KEYS[3]: 世代の鍵、
// ARGV: 現況 (JSON)、その updatedAt、現況の寿命 (秒)、時刻の寿命 (秒)、書き始める前に読んだ世代
const STORE_IF_NEWER_SCRIPT = `
if (redis.call('GET', KEYS[3]) or '0') ~= ARGV[5] then
	return 2
end
local updatedAt = tonumber(ARGV[2])
local lastSeen = tonumber(redis.call('GET', KEYS[2]))
if lastSeen and lastSeen >= updatedAt then
	return 0
end
local current = redis.call('GET', KEYS[1])
if current then
	local ok, stored = pcall(cjson.decode, current)
	if ok and type(stored) == 'table' and type(stored.updatedAt) == 'number' and stored.updatedAt >= updatedAt then
		return 0
	end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1
`;

// 他のサーバーのメンバーには、参加者が変わったときのほか、変わらなくてもこの間隔で送り直してミラーの寿命を延ばす。
// 送り直しは読み直し (sweep) のついでに行うので、実際の間隔は最大でこれに SWEEP_INTERVAL_MS を足したものになる
const FEDERATION_RESEND_INTERVAL_MS = 240_000;

// 参加者が目まぐるしく変わっても (画面共有の切り替えや出入りの繰り返し) 配送が膨らまないよう、
// 他のサーバーへはルームごとにこの間隔に一度だけ送る。全ワーカーで Redis の鍵を共有して数える
const FEDERATION_MIN_INTERVAL_MS = 10_000;

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

/** 他のサーバーのユーザーを断るかどうかに関わる設定 */
type FederationPolicy = { blockedHosts?: string[]; federation?: string; federationHosts?: string[] };

/** 通話の参加者。userId はトークンに付けたメタデータの値 (無ければ null) */
type CallParticipant = { identity: string; userId: MiUser['id'] | null };

/** あるルームの参加者が通話に残れるか (isAdmitted) を確かめるために、ルームごとにまとめて引いたもの */
type AdmissionContext = {
	room: MiChatRoom | null;
	users: Map<MiUser['id'], MiUser>;
	memberIds: Set<MiUser['id']>;
	/** ホストごとの isRefusedRemoteHost の結果 */
	refusedHosts: Map<string, boolean>;
};

/** ルームの持ち主とメンバーのうち、通話の参加者を知らせる相手 (audienceOf) */
type RoomAudience = {
	/** このサーバーのユーザーである持ち主とメンバー。main ストリームで知らせる */
	localUserIds: MiUser['id'][];
	/** 持ち主がこのサーバーのユーザーならその持ち主 (他のサーバーへ送るときの名義)。ミラーのルームなら null */
	localOwner: MiUser | null;
	/** 他のサーバーのメンバーの inbox (共有 inbox があればそちら) と、それが共有 inbox か。ミラーのルームなら空 */
	remoteInboxes: Map<string, boolean>;
};

/**
 * storeRemoteSnapshot の結果。
 * - stored: 保存して、このサーバーのメンバーに知らせた
 * - stale: 保存済みの現況か、最後に受け入れた時刻以前のもの
 * - ahead: この時計より REMOTE_SNAPSHOT_MAX_AHEAD_MS より先の時刻が付いている
 * - disabled: 他のサーバーの通話を止めている (保存の途中で止められた場合を含む)
 */
export type RemoteSnapshotStoreResult = 'stored' | 'stale' | 'ahead' | 'disabled';

/** 他のサーバーに送った現況の記録 */
type FederatedRecord = { hash: string; at: number };

/** 他のサーバーに渡す参加者の現況。userId はこのサーバーの DB の id なので含めない */
type FederatedVoiceSnapshot = {
	participants: { identity: string; screenSharing: boolean }[];
	updatedAt: number;
};

/** 通話に入るためのもの。iceServers は TURN が設定されていなければ null */
export type JoinCredentials = {
	url: string;
	token: string;
	iceServers: IceServer[] | null;
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
	/** webhook を受けて予定した読み直し */
	private pendingRefreshes = new Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>();
	/** 他のサーバーへ送るのを待たせた現況を、送れるようになったときに送るための読み直し */
	private pendingFollowUps = new Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>();
	private sweepTimer: NodeJS.Timeout | null = null;
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private liveKitService: LiveKitService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private roleService: RoleService,
		private utilityService: UtilityService,
		private apRendererService: ApRendererService,
		private queueService: QueueService,
		private loggerService: LoggerService,
		private cloudflareTurnService: CloudflareTurnService,
	) {
		this.logger = this.loggerService.getLogger('chat-voice');
	}

	/**
	 * 通話のトークンを発行する。TURN が設定されていれば、その ICE サーバーも渡す (無ければ null)
	 */
	@bindThis
	public async issueJoinToken(user: MiLocalUser | MiRemoteUser, room: MiChatRoom, canScreenShare: boolean): Promise<JoinCredentials> {
		const issueToken = async () => {
			await this.liveKitService.ensureRoom(room.id, MAX_ROOM_MEMBERS + 1);
			return await this.liveKitService.createJoinToken({
				roomId: room.id,
				identity: this.liveKitService.identityOf(user),
				userId: user.id,
				canScreenShare,
			});
		};
		// TURN の資格情報の取得は失敗しても null になるだけなので、トークンの発行と並べて待つ
		const [token, iceServers] = await Promise.all([issueToken(), this.cloudflareTurnService.getIceServers()]);
		return { url: this.liveKitService.getPublicUrl(), token, iceServers };
	}

	/**
	 * 他のサーバーのユーザーに、このサーバーが持つルーム (roomId) の通話トークンを発行する。
	 * ルームが無いときも、使わせないときと同じく 'forbidden' を返す。
	 * 画面共有は、相手のサーバーが求め (canScreenShareRequested)、こちらのポリシーも許すときだけ認める
	 */
	@bindThis
	public async issueRemoteJoinToken(user: MiRemoteUser, roomId: MiChatRoom['id'], canScreenShareRequested: boolean): Promise<(JoinCredentials & FederatedVoiceSnapshot) | 'forbidden'> {
		// ルームがあるかどうかで読むものを変えない。DB や Redis が使えないとき、あるルームへの要求だけが失敗して
		// ルームがあると分かってしまわないように、断るかどうかを決める前にすべてを並べて読む
		const [room, isMember, isRefusedHost, policies] = await Promise.all([
			this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } }),
			this.chatRoomMembershipsRepository.exists({ where: { roomId, userId: user.id } }),
			this.isRefusedRemoteHost(user.host),
			this.roleService.getUserPolicies(user.id),
		]);

		// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーで開く。保管済みのルームはローカルと同じく断る
		if (room == null || room.owner == null || room.owner.host != null || room.isArchived) return 'forbidden';

		if (user.isSuspended) return 'forbidden';
		if (isRefusedHost) return 'forbidden';
		if (!isMember) return 'forbidden';

		// トークンは常にマイクを許すので、ローカルの参加と同じくチャットの書き込み権限も求める
		if (!policies.canVoiceCall || policies.chatAvailability !== 'available') return 'forbidden';

		const { url, token, iceServers } = await this.issueJoinToken(user, room, canScreenShareRequested && policies.canScreenShare);
		const { participants, updatedAt } = await this.snapshotOf(room.id);
		return { url, token, iceServers, participants, updatedAt };
	}

	/**
	 * 他のサーバーのホストを、このサーバーが断っているか。
	 * 通話に入れるか (このサーバーのルームに他のサーバーのユーザーを入れるとき、このサーバーのユーザーが他のサーバーのルームに入るとき) と、
	 * 通話中の参加者を外すかを、すべてこれで決める。
	 * inbox (InboxProcessorService) が他のサーバーからのアクティビティを捨てる条件と揃える。
	 * - 連合が許されていないホスト。ブロックはドメインで指定されるので、ポートを除いた名前でも確かめる。
	 *   inbox と同じく、正規化した名前 (ポートと末尾のドットを除いた小文字の punycode) でも確かめる
	 * - inbox と同じく、ポート・末尾のドット・大文字小文字・Unicode の違いを無視して、ブロックの指定に当たるホスト
	 * - 停止 (手動・自動を問わない) または隔離 (quarantineLimited) されたサーバー。
	 *   そのサーバーの記録のどれかにあれば従う。キャッシュを通さず、いまの記録を見る
	 * ホストとして読めないものも断る
	 */
	@bindThis
	public async isRefusedRemoteHost(host: string): Promise<boolean> {
		const normalized = normalizeHost(host);
		const hostname = normalized != null ? hostnameOf(host) : null;
		if (normalized == null || hostname == null) return true;

		if (!this.utilityService.isFederationAllowedHost(normalized)) return true;
		if (!this.utilityService.isFederationAllowedHost(hostname)) return true;
		if (!this.utilityService.isFederationAllowedHost(host)) return true;
		if (isHostInList(this.meta.blockedHosts, host)) return true;

		const instances = await this.instancesRepository.findBy({ host: In(this.instanceHostsOf(host)) });
		return instances.some(instance => instance.suspensionState !== 'none' || instance.quarantineLimited);
	}

	/**
	 * 通話中のすべてのルームで、いま残れない参加者 (isAdmitted) を外す (reconcileRoom)。
	 * ブロックや連合の設定が変わったときと、管理画面でサーバーを停止したときに、定期的な読み直し (sweep) を待たずに呼ぶ。
	 * 外すのは何度しても同じ結果になるので、複数のワーカーが同時に動いてもよい
	 */
	@bindThis
	public async removeRefusedRemoteParticipants(): Promise<void> {
		const roomIds = await this.redisClient.smembers(ACTIVE_ROOMS_KEY);
		for (const roomId of roomIds) {
			await this.reconcileRoom(roomId);
		}
	}

	/**
	 * ルームの通話の参加者を LiveKit から読み、いまそのルームに残れない参加者 (isAdmitted) を外す。
	 * 読めない・確かめられない・外せないときは記録だけして戻る。定期的な読み直し (sweep) が毎回これを呼ぶので、次の読み直しでやり直される
	 */
	@bindThis
	public async reconcileRoom(roomId: MiChatRoom['id']): Promise<void> {
		let participants: LiveKitParticipant[];
		try {
			participants = await this.liveKitService.listParticipants(roomId);
		} catch (err) {
			this.logger.warn(`Failed to list the participants of the voice call in ${roomId}`, { error: err });
			return;
		}
		await this.removeUnadmitted(roomId, participants);
	}

	/**
	 * 通話に入った参加者が、いまもそのルームに残れるか (isAdmitted) を確かめ、残れなければ外す。
	 * トークンは 10 分有効なので、ルームを抜けたりサーバーが断られたりした後でも、同じトークンで入り直せてしまうため。
	 * 確かめられなければ外さない (DB が一時的に使えないだけで全員を外さないため)。そのときは定期的な読み直し (sweep) が確かめ直す
	 */
	@bindThis
	public async removeUnadmittedParticipant(roomId: MiChatRoom['id'], participant: { identity: string; metadata?: string }): Promise<void> {
		await this.removeUnadmitted(roomId, [{ identity: participant.identity, userId: userIdOfMetadata(participant.metadata) }]);
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

		const participant = event.participant;
		if (event.event === 'participant_joined' && participant != null) {
			// 確かめられなかったときと外せなかったときは removeUnadmitted が記録し、定期的な読み直し (sweep) がやり直す
			this.removeUnadmittedParticipant(roomId, participant).catch(() => {});
		}

		this.scheduleRefresh(roomId);
	}

	/**
	 * ルームを少し後に読み直す。ルームごとに一つにまとめる
	 */
	@bindThis
	public scheduleRefresh(roomId: MiChatRoom['id']): void {
		this.scheduleRefreshIn(this.pendingRefreshes, roomId, REFRESH_DELAY_MS);
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

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return;

		const packed = await this.pack(roomId, snapshot, null);
		// 通話の参加者はルームの今のメンバーにだけ知らせる。ルームのストリーム (chatRoom) はメンバーでないモデレーターも購読でき、
		// 抜けたメンバーの購読も続くので使わない。main ストリームを持つのはこのサーバーのユーザーだけ
		const audience = await this.audienceOf(room);
		for (const userId of audience.localUserIds) {
			this.globalEventService.publishMainStream(userId, 'chatRoomVoiceState', packed);
		}

		await this.federateChanges(room, snapshot, audience);
	}

	/**
	 * 他のサーバーが持つルーム (ミラー) の持ち主から届いた、通話の参加者の現況 (ChatRoomVoiceState) を受け取る。
	 * 現況とルームの URI がどちらも送り主と同じサーバー (スキーム・ホスト・ポート) のもので、
	 * そのルームがこのサーバーのミラーであり、送り主がその持ち主のときだけ保存する。戻り値は inbox のログ用
	 */
	@bindThis
	public async receiveRemoteSnapshot(actor: MiRemoteUser, object: IObject): Promise<string> {
		if (!isRemoteVoiceCallEnabled(this.meta)) return 'skip: remote voice calls are disabled';

		// 形と出所 (送り主と同じサーバーのルームか) を確かめる。ルームに入れる人数より多い参加者は受け付けない
		const parsed = parseChatRoomVoiceState(actor.uri, object, MAX_ROOM_MEMBERS + 1);
		if (!parsed.ok) return `skip: ${parsed.reason}`;
		const { roomId, participants, updatedAt } = parsed.state;

		const room = await this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } });
		if (room == null) return 'skip: unknown room';
		// 送り主は他のサーバーのユーザーなので、送り主が持ち主ならそのルームはミラー
		if (room.ownerId !== actor.id) return 'skip: sender does not own the room';

		switch (await this.storeRemoteSnapshot(room, participants, updatedAt)) {
			case 'stored': return 'ok: voice state stored';
			case 'stale': return 'skip: voice state is not newer than the last one accepted';
			case 'ahead': return 'skip: voice state is stamped too far ahead';
			case 'disabled': return 'skip: remote voice calls are disabled';
		}
	}

	/**
	 * 他のサーバーが持つルーム (ミラー) について、ホストから届いた参加者の現況を保存し、このサーバーのメンバーに知らせる。
	 * room は持ち主 (owner) を読み込んだもの。持ち主がこのサーバーのユーザーなら (ミラーでなければ) 例外を投げる。
	 * updatedAt はホストの時刻。保存済みのもの以前の現況と、この時計より REMOTE_SNAPSHOT_MAX_AHEAD_MS より先の現況は捨てる。
	 * 保存済みの現況の寿命が切れた後も、最後に受け入れた時刻 (REMOTE_SNAPSHOT_LAST_SEEN_TTL_SECONDS のあいだ覚えておく) 以前の現況は捨てる。
	 * 参加者は、このサーバーが知っているユーザーだけを残す。そのうちこのサーバーのユーザーは、ルームのメンバーでなければ外す。
	 * 他のサーバーのユーザー (持ち主を含む) がメンバーかはこのサーバーでは分からないので、ホストの言うまま残す。
	 * 他のサーバーの通話を止めているあいだは保存しない。保存の途中で止められたときも、書かず (REMOTE_GENERATION_KEY)、知らせない。
	 * 結果 (RemoteSnapshotStoreResult) を返す。
	 * ミラーの通話はこのサーバーの LiveKit には無いので、定期的な読み直し (sweep) の対象には加えない
	 */
	@bindThis
	public async storeRemoteSnapshot(room: MiChatRoom, participants: { identity: string; screenSharing: boolean }[], updatedAt: number): Promise<RemoteSnapshotStoreResult> {
		// このサーバーのルームの現況は LiveKit から読む。ホストの言う現況で上書きさせない
		if (room.owner == null || room.owner.host == null) {
			throw new Error(`Voice call participants sent by another server can only be stored for a room owned there: ${room.id}`);
		}

		if (updatedAt > Date.now() + REMOTE_SNAPSHOT_MAX_AHEAD_MS) return 'ahead';
		if (!isRemoteVoiceCallEnabled(this.meta)) return 'disabled';
		// 書き込みのスクリプトは、ここで読んだ世代と比べる。この後で止められれば書かない
		const generation = await this.remoteGenerationOf();

		const capped = participants.slice(0, MAX_ROOM_MEMBERS + 1);
		const users = await this.knownUsersOf(capped.map(p => p.identity));
		// ホストは、このサーバーのユーザーなら誰でも参加者として送れる。このサーバーのユーザーかどうかは、送られた identity ではなく
		// DB のユーザーで決め、メンバーでなければ外す
		const localMemberIds = await this.memberIdsOf(room, [...new Set([...users.values()].filter(user => user.host == null).map(user => user.id))]);
		const snapshot: VoiceSnapshot = { participants: [], updatedAt };
		for (const p of capped) {
			const user = users.get(p.identity);
			if (user == null) continue;
			if (user.host == null && !localMemberIds.has(user.id)) continue;
			snapshot.participants.push({ identity: p.identity, userId: user.id, screenSharing: p.screenSharing });
		}

		// 他のサーバーの通話を止めた後に、止める前に始まった参加の応答が届いても書かない (止めたときにミラーの現況は消している)
		if (!isRemoteVoiceCallEnabled(this.meta)) return 'disabled';

		// 解決している間に新しい現況が保存されたかもしれないので、書くときに比べる (STORE_IF_NEWER_SCRIPT)。
		// 空になったときも時刻ごと残し、遅れて届いた古い現況で上書きされないようにする (getStates は空のものを返さない)。
		// 現況の鍵が切れた後に届く古い現況は、最後に受け入れた時刻で捨てる。
		// 読んだ後で (別のワーカーで) 止められて現況が消されていれば、世代が変わっているので書かない
		const stored = await this.redisClient.eval(
			STORE_IF_NEWER_SCRIPT,
			3,
			this.keyOf(room.id),
			this.lastSeenKeyOf(room.id),
			REMOTE_GENERATION_KEY,
			JSON.stringify(snapshot),
			updatedAt,
			REMOTE_SNAPSHOT_TTL_SECONDS,
			REMOTE_SNAPSHOT_LAST_SEEN_TTL_SECONDS,
			generation,
		);
		if (stored === 2) return 'disabled';
		if (stored !== 1) return 'stale';

		// 持ち主は他のサーバーのユーザーなので、このサーバーのメンバーにだけ知らせる (ルームのストリームを使わない理由は refresh と同じ)
		const [packed, memberships] = await Promise.all([
			this.pack(room.id, snapshot, null),
			this.chatRoomMembershipsRepository.findBy({ roomId: room.id, user: { host: IsNull() } }),
		]);

		// 書いた後、知らせる前に止められていれば知らせない。止めたときの消去で現況は消えている (消す前に書いたものも消される)
		if (!isRemoteVoiceCallEnabled(this.meta) || await this.remoteGenerationOf() !== generation) return 'disabled';
		for (const membership of memberships) {
			this.globalEventService.publishMainStream(membership.userId, 'chatRoomVoiceState', packed);
		}
		return 'stored';
	}

	/**
	 * ミラーの現況をすべて消す。他のサーバーの通話を止めたときに呼び、寿命 (REMOTE_SNAPSHOT_TTL_SECONDS) まで残さない。
	 * 先に世代 (REMOTE_GENERATION_KEY) を増やし、止める前に始まった書き込みが、消した後に届いても書けないようにする。
	 * ミラーは持ち主が他のサーバーのユーザーのルーム。それを id 順に少しずつ引き、現況の鍵を消す (無い鍵を消しても何も起きない)。
	 * 最後に受け入れた時刻は残し、また通話を使うようにした後に古い現況が届いても書かないようにする。
	 * 何度消しても同じ結果になるので、複数のワーカーが同時に動いてもよい
	 */
	@bindThis
	public async clearMirrorSnapshots(): Promise<void> {
		await this.redisClient.incr(REMOTE_GENERATION_KEY);
		let lastId: MiChatRoom['id'] | null = null;
		for (;;) {
			const rooms: Pick<MiChatRoom, 'id'>[] = await this.chatRoomsRepository.find({
				select: { id: true },
				where: { owner: { host: Not(IsNull()) }, ...(lastId != null ? { id: MoreThan(lastId) } : {}) },
				order: { id: 'ASC' },
				take: MIRROR_CLEAR_BATCH_SIZE,
			});
			if (rooms.length > 0) await this.redisClient.del(...rooms.map(room => this.keyOf(room.id)));
			if (rooms.length < MIRROR_CLEAR_BATCH_SIZE) return;
			lastId = rooms[rooms.length - 1].id;
		}
	}

	/**
	 * 通話中のルームを LiveKit から読み直す。複数のワーカーが同時に動いても、各ルームを読むのは一つだけ。
	 * 読み直す前に、いま残れない参加者を外す (reconcileRoom)。設定の変更や停止の後で通話中になったルーム、
	 * 自動で停止されたサーバー、外せなかった参加者も、これで SWEEP_INTERVAL_MS のうちに外れる
	 */
	@bindThis
	public async sweep(): Promise<void> {
		const roomIds = await this.redisClient.smembers(ACTIVE_ROOMS_KEY);
		for (const roomId of roomIds) {
			const locked = await this.redisClient.set(`chatVoice:sweep:${roomId}`, '1', 'EX', SWEEP_LOCK_SECONDS, 'NX');
			if (locked !== 'OK') continue;
			await this.reconcileRoom(roomId);
			await this.refresh(roomId).catch(() => {
				// LiveKit に届かなければスナップショットの寿命切れに任せる
			});
		}
	}

	@bindThis
	public onModuleInit(): void {
		// 設定の変更は、このサーバーに LiveKit が無くても受け取る (ミラーの現況は LiveKit が無くても保存されるので)
		this.redisForSub.on('message', this.onMessage);
		if (!this.liveKitService.isEnabled) return;
		this.sweepTimer = setInterval(() => {
			this.sweep().catch(() => {});
		}, SWEEP_INTERVAL_MS);
	}

	@bindThis
	public onApplicationShutdown(): void {
		for (const pending of [this.pendingRefreshes, this.pendingFollowUps]) {
			for (const { timer } of pending.values()) clearTimeout(timer);
			pending.clear();
		}
		if (this.sweepTimer != null) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	private onMessage(_: string, data: string): void {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'metaUpdated': {
					// ブロックや連合の設定が変わったら、通話中の他のサーバーの参加者を確かめ直す。
					// DI.meta は GlobalModule の購読が先に書き換えているので、新しい設定で判定される。
					// 外すのは何度しても同じ結果になるので、どのワーカーでも行う
					if (this.liveKitService.isEnabled && (body.before == null || isFederationPolicyChanged(body.before, body.after))) {
						this.removeRefusedRemoteParticipants().catch(err => {
							this.logger.error('Failed to remove voice call participants from refused servers', { error: err });
						});
					}
					// 他のサーバーの通話を止めたら、ミラーの現況を消す。消すのは何度しても同じ結果になるので、どのワーカーでも行う
					if (!isRemoteVoiceCallEnabled(body.after) && (body.before == null || isRemoteVoiceCallEnabled(body.before))) {
						this.clearMirrorSnapshots().catch(err => {
							this.logger.error('Failed to clear the voice call participants of rooms owned on other servers', { error: err });
						});
					}
					break;
				}
				default:
					break;
			}
		}
	}

	private keyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:${roomId}`;
	}

	/** 他のサーバーの通話を止めた回数 (世代)。一度も止めていなければ '0' */
	private async remoteGenerationOf(): Promise<string> {
		return (await this.redisClient.get(REMOTE_GENERATION_KEY)) ?? '0';
	}

	/** ミラーの現況について、最後に受け入れた時刻 (updatedAt) を覚えておく鍵 */
	private lastSeenKeyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:lastSeen:${roomId}`;
	}

	/**
	 * ルームを delayMs 後に読み直す。pending ごと・ルームごとに一つにまとめ、予定済みのものより早く読み直したいときだけ早める
	 */
	private scheduleRefreshIn(pending: Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>, roomId: MiChatRoom['id'], delayMs: number): void {
		const dueAt = Date.now() + delayMs;
		const scheduled = pending.get(roomId);
		if (scheduled != null) {
			if (scheduled.dueAt <= dueAt) return;
			clearTimeout(scheduled.timer);
		}
		const timer = setTimeout(() => {
			pending.delete(roomId);
			this.refresh(roomId).catch(() => {
				// 次の webhook か通話参加時に再取得されるので握りつぶす
			});
		}, delayMs);
		pending.set(roomId, { timer, dueAt });
	}

	/**
	 * そのサーバーの停止が記録されうる instance.host。
	 * - toPuny した host: FederatedInstanceService.fetchOrRegister、管理画面での停止、配送の停止の判定 (DeliverProcessorService) が使う記録。
	 *   domainToASCII はポート付きのホストに '' を返すので、ポート付きのサーバーはすべて '' の記録にまとめられている
	 * - hostLookupCandidates: 同じドメインの記録、末尾にドットの付いた記録、domainToASCII を使う前にポートごと保存された記録。
	 *   ActivityPub のアクセス制御と inbox が隔離を確かめるのと同じ候補 (ポートは区別しない)
	 */
	private instanceHostsOf(host: string): string[] {
		return [...new Set([this.utilityService.toPuny(host), ...hostLookupCandidates(host)])];
	}

	/**
	 * 参加者のうち、いまそのルームに残れない (isAdmitted でない) ものを外す。
	 * ルームとユーザーとメンバーはまとめて引く。確かめられなければ誰も外さず、外せなかった参加者は記録して残りを続ける
	 */
	private async removeUnadmitted(roomId: MiChatRoom['id'], participants: CallParticipant[]): Promise<void> {
		if (participants.length === 0) return;

		const unadmitted: string[] = [];
		try {
			const context = await this.admissionContextOf(roomId, participants.flatMap(p => p.userId != null ? [p.userId] : []));
			for (const participant of participants) {
				if (!(await this.isAdmitted(participant, context))) unadmitted.push(participant.identity);
			}
		} catch (err) {
			this.logger.warn(`Failed to check who may stay in the voice call in ${roomId}; nobody was removed`, { error: err });
			return;
		}

		for (const identity of unadmitted) {
			await this.liveKitService.removeParticipant(roomId, identity).catch(err => {
				this.logger.warn(`Failed to remove ${identity}, who may not stay, from the voice call in ${roomId}`, { error: err });
			});
		}
	}

	private async admissionContextOf(roomId: MiChatRoom['id'], userIds: MiUser['id'][]): Promise<AdmissionContext> {
		const ids = [...new Set(userIds)];
		const [room, users, memberships] = await Promise.all([
			this.chatRoomsRepository.findOneBy({ id: roomId }),
			ids.length > 0 ? this.usersRepository.findBy({ id: In(ids) }) : [],
			ids.length > 0 ? this.chatRoomMembershipsRepository.findBy({ roomId, userId: In(ids) }) : [],
		]);
		return {
			room,
			users: new Map(users.map(user => [user.id, user])),
			memberIds: new Set(memberships.map(membership => membership.userId)),
			refusedHosts: new Map(),
		};
	}

	/**
	 * 参加者が、いまもそのルームの通話に残れるか。入ったとき (participant_joined) と定期的な読み直し (sweep) で確かめる。
	 * - トークンに付けたユーザー (メタデータの userId) がいて、参加者の identity がそのユーザーのもの (LiveKitService.identityOf)
	 * - ルームがあり、そのユーザーが持ち主かメンバー
	 * - 他のサーバーのユーザーなら、そのサーバーを断っていない (isRefusedRemoteHost)
	 */
	private async isAdmitted(participant: CallParticipant, context: AdmissionContext): Promise<boolean> {
		if (participant.userId == null) return false;
		const user = context.users.get(participant.userId);
		if (user == null) return false;
		if (user.host != null && user.uri == null) return false;
		if (participant.identity !== this.liveKitService.identityOf(user)) return false;

		const room = context.room;
		if (room == null) return false;
		if (room.ownerId !== user.id && !context.memberIds.has(user.id)) return false;

		if (user.host == null) return true;
		let refused = context.refusedHosts.get(user.host);
		if (refused == null) {
			refused = await this.isRefusedRemoteHost(user.host);
			context.refusedHosts.set(user.host, refused);
		}
		return !refused;
	}

	/**
	 * ルームの持ち主とメンバーを一度に引き、このサーバーで知らせる相手と、他のサーバーの届け先に分ける
	 */
	private async audienceOf(room: MiChatRoom): Promise<RoomAudience> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const users = await this.usersRepository.findBy({ id: In([room.ownerId, ...memberships.map(m => m.userId)]) });

		// 他のサーバーが持つルーム (ミラー) の現況は、そのサーバーが送る
		const owner = users.find(user => user.id === room.ownerId);
		const localOwner = owner != null && owner.host == null ? owner : null;

		const remoteInboxes = new Map<string, boolean>();
		if (localOwner != null) {
			for (const user of users) {
				if (user.host == null) continue;
				const inbox = user.sharedInbox ?? user.inbox;
				if (inbox != null && !remoteInboxes.has(inbox)) remoteInboxes.set(inbox, user.sharedInbox != null);
			}
		}

		return {
			localUserIds: users.filter(user => user.host == null).map(user => user.id),
			localOwner,
			remoteInboxes,
		};
	}

	/**
	 * 参加者の現況を他のサーバーのメンバーに届ける。他のサーバーのメンバーがいないルームでは何もしない (間隔の鍵も読み直しも使わない)。
	 * - 参加者のいる現況は、前に送ったものと同じで、送ってから FEDERATION_RESEND_INTERVAL_MS 経っていなければ送らない
	 * - 送るのはルームごとに FEDERATION_MIN_INTERVAL_MS に一度まで。送れなかった変化は、間隔が空いたときに読み直して最新の現況を送る
	 * - 通話が終わったこと (空の現況) は参加者の現況とは別に数えて待たずに送る。送る直前に記録を読み、同じ終わりを送ってあれば送らない
	 * 送った記録は、すべての届け先への配送を積めたときだけ残す
	 */
	private async federateChanges(room: MiChatRoom, snapshot: VoiceSnapshot, audience: RoomAudience): Promise<void> {
		if (audience.localOwner == null || audience.remoteInboxes.size === 0) return;

		const participants = snapshot.participants.map(p => ({ identity: p.identity, screenSharing: p.screenSharing }));
		const hash = createHash('sha256')
			.update(JSON.stringify([...participants].sort((a, b) => a.identity.localeCompare(b.identity))))
			.digest('hex');
		const ended = participants.length === 0;

		const last = ended ? null : await this.lastFederatedOf(room.id);
		if (!ended && isStillFederated(last, hash)) return;

		const gateKey = ended ? `chatVoice:federateEmptyGate:${room.id}` : `chatVoice:federateGate:${room.id}`;
		const opened = await this.redisClient.set(gateKey, '1', 'PX', FEDERATION_MIN_INTERVAL_MS, 'NX');
		if (opened !== 'OK') {
			// 相手に届いている現況と違うなら、間隔の鍵が切れた後に読み直して送る (読み直しはルームごとに一つにまとまる)。
			// 通話の終わりは記録によらず必ず読み直す。記録を読んでから決めるまでに、ほかのワーカーが参加者のいる現況を送るかもしれないため。
			// 送るかどうかは、読み直したときに読む記録で決める
			if (ended || last?.hash !== hash) {
				const ttl = await this.redisClient.pttl(gateKey);
				// 鍵は寿命の時刻ちょうどにはまだ残っているので、それを過ぎてから読み直す
				this.scheduleRefreshIn(this.pendingFollowUps, room.id, ttl >= 0 ? Math.min(ttl, FEDERATION_MIN_INTERVAL_MS) + 1 : REFRESH_DELAY_MS);
			}
			return;
		}

		// 通話の終わりは、送る直前に読んだ記録が同じ終わりなら送らない (相手には届いている)。
		// 送らないので間隔の鍵も外し、次に参加者が出入りした後の終わりを待たせない
		if (ended && isStillFederated(await this.lastFederatedOf(room.id), hash)) {
			await this.redisClient.del(gateKey);
			return;
		}

		await this.deliverSnapshot(room, audience, participants, snapshot.updatedAt);
		await this.redisClient.set(`chatVoice:federated:${room.id}`, JSON.stringify({ hash, at: Date.now() } satisfies FederatedRecord), 'EX', FEDERATION_RESEND_INTERVAL_MS / 1000);
	}

	/** 他のサーバーに最後に送った現況の記録。FEDERATION_RESEND_INTERVAL_MS で切れる */
	private async lastFederatedOf(roomId: MiChatRoom['id']): Promise<FederatedRecord | null> {
		const raw = await this.redisClient.get(`chatVoice:federated:${roomId}`);
		return raw != null ? JSON.parse(raw) as FederatedRecord : null;
	}

	/**
	 * このサーバーが持つルームの通話の参加者の現況を、他のサーバーのメンバーに届ける。
	 * 持ち主の名前で Update を作り、メンバーの inbox (共有 inbox があればそちら) ごとに一度だけ送る。
	 * すべての配送を積み終えるまで待ち、どれかを積めなければ例外を投げる
	 */
	private async deliverSnapshot(room: MiChatRoom, audience: RoomAudience, participants: { identity: string; screenSharing: boolean }[], updatedAt: number): Promise<void> {
		const owner = audience.localOwner;
		if (owner == null) return;

		// 通話の参加者はルームのメンバーにだけ知らせるものなので、公開 (Public) 宛てにはしない
		const activity = this.apRendererService.addContext({
			type: 'Update',
			actor: this.userEntityService.genLocalUserUri(owner.id),
			object: this.apRendererService.renderChatRoomVoiceState(room, participants, updatedAt),
			published: new Date(updatedAt).toISOString(),
		});
		await Promise.all([...audience.remoteInboxes].map(([inbox, isSharedInbox]) => this.queueService.deliver(owner, activity, inbox, isSharedInbox)));
	}

	/**
	 * userIds のうち、いまルームのメンバーであるユーザー。一度に引き、userIds が空なら引かない
	 */
	private async memberIdsOf(room: MiChatRoom, userIds: MiUser['id'][]): Promise<Set<MiUser['id']>> {
		if (userIds.length === 0) return new Set();
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id, userId: In(userIds) });
		return new Set(memberships.map(membership => membership.userId));
	}

	/**
	 * 参加者の identity (LiveKitService.identityOf) を、このサーバーが既に知っているユーザーにする。
	 * identity は他のサーバーから届くので、知らないユーザーを取りに行くことはしない (相手に好きな URL を取得させないため)。
	 * このサーバーの `${url}/users/<id>` はその id のローカルユーザー、それ以外は uri が一致するリモートユーザー。
	 * 削除済みのユーザーと、どれにも当たらない identity は含めない。
	 * 返すユーザーの host は DB の値なので、このサーバーのユーザーかどうかはそれで決められる
	 */
	private async knownUsersOf(identities: string[]): Promise<Map<string, Pick<MiUser, 'id' | 'host'>>> {
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

		const result = new Map<string, Pick<MiUser, 'id' | 'host'>>();
		for (const user of localUsers) {
			const identity = localIdentityOf.get(user.id);
			if (identity != null && user.host == null) result.set(identity, { id: user.id, host: null });
		}
		for (const user of remoteUsers) {
			if (user.host != null && user.uri != null) result.set(user.uri, { id: user.id, host: user.host });
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
		return { roomId, participants, updatedAt: snapshot.updatedAt };
	}
}

/** ブロックや連合の設定のうち、他のサーバーのユーザーを断るかどうかに関わるものが変わったか */
function isFederationPolicyChanged(before: FederationPolicy, after: FederationPolicy): boolean {
	return before.federation !== after.federation
		|| !isSameList(before.blockedHosts, after.blockedHosts)
		|| !isSameList(before.federationHosts, after.federationHosts);
}

function isSameList(a: string[] | undefined, b: string[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((value, i) => value === right[i]);
}

/** host (`host` または `host:port`) からポートを除いた名前。読めなければ null */
function hostnameOf(host: string): string | null {
	try {
		return new URL(`https://${host}`).hostname;
	} catch {
		return null;
	}
}

/** 記録 (last) が、同じ現況 (hash) を FEDERATION_RESEND_INTERVAL_MS のうちに送ったことを示すか */
function isStillFederated(last: FederatedRecord | null, hash: string): boolean {
	return last != null && last.hash === hash && Date.now() - last.at < FEDERATION_RESEND_INTERVAL_MS;
}
