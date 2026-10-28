/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, MoreThan, Not } from 'typeorm';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository, UsersRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { reportedVoiceStatus } from '@/core/voice-participant-status.js';
import type Logger from '@/logger.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { LiveKitService, userIdOfMetadata } from '@/core/LiveKitService.js';
import type { LiveKitParticipant } from '@/core/LiveKitService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { RoleService } from '@/core/RoleService.js';
import type { RolePolicies } from '@/core/RoleService.js';
import { MetaService } from '@/core/MetaService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
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

// このサーバーが持つルームの現況の時刻 (増える一方、ALLOCATE_STAMP_SCRIPT) を覚えておく長さ。現況の寿命 (SNAPSHOT_TTL_SECONDS) と
// ワーカーの時計のずれより十分長くし、鍵が切れた後に決める時刻も、保存されている現況の時刻より後になるようにする
const LOCAL_STAMP_TTL_SECONDS = 3_600;

// 他のサーバーが持つルーム (ミラー) の通話は、このサーバーから読み直せない。
// メンバーが参加するたびにホストから届く現況を、これだけの間だけ表示する
const REMOTE_SNAPSHOT_TTL_SECONDS = 600;

// ホストの時計がこれより先の時刻を付けた現況は捨てる。受け入れると、寿命が切れるまでホストが新しい現況で上書きできなくなる
const REMOTE_SNAPSHOT_MAX_AHEAD_MS = 300_000;

// ミラーの現況について、最後に受け入れた時刻 (updatedAt) を現況の寿命より長く覚えておく。
// 配送は既定で 12 回まで間隔を延ばしながらやり直す (最後のやり直しまで最大で約 39 時間) ので、通話の終わりを保存した鍵が切れた後に
// 終わる前の現況が届き、終わった通話が戻ることがある。受け取った側の inbox のやり直し (約 5 時間) を足しても収まるよう、2 日覚えておく
const REMOTE_SNAPSHOT_LAST_SEEN_TTL_SECONDS = 172_800;

// これより古い時刻の現況は捨てる。最後に受け入れた時刻を覚えておく間が過ぎた後は、それより前の現況を時刻で比べられないため。
// 覚えておいた最後の時刻は、受け入れたときのこの時計より最大で REMOTE_SNAPSHOT_MAX_AHEAD_MS 先なので、その分を引く。
// こうすると、覚えておく間が過ぎた後に届く、それ以前の現況はすべてこれより古い
const REMOTE_SNAPSHOT_MAX_AGE_MS = REMOTE_SNAPSHOT_LAST_SEEN_TTL_SECONDS * 1000 - REMOTE_SNAPSHOT_MAX_AHEAD_MS;

// 参加者のいる現況は、これより古ければ捨てる。ミラーの現況は REMOTE_SNAPSHOT_TTL_SECONDS で切れるので、それより古い参加者を
// 表示し直さない (ホストの時計のずれの分だけ延ばす)。通話の終わり (空の現況) は REMOTE_SNAPSHOT_MAX_AGE_MS まで受け入れる
const REMOTE_ACTIVE_SNAPSHOT_MAX_AGE_MS = REMOTE_SNAPSHOT_TTL_SECONDS * 1000 + REMOTE_SNAPSHOT_MAX_AHEAD_MS;

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

// 消去を始めた世代と、そのとき読んだ現況・ホスト時刻が変わっていない場合だけ消す。
// KEYS: 現況、最後に受け入れた時刻、世代、通知記録。ARGV: 消去の世代、読んだ現況、読んだ時刻 (無ければ空文字)。
const CLEAR_MIRROR_IF_CURRENT_SCRIPT = `-- CLEAR_MIRROR_IF_CURRENT
if (redis.call('GET', KEYS[3]) or '0') ~= ARGV[1] then return 0 end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[2] then return 0 end
if (redis.call('GET', KEYS[2]) or '') ~= ARGV[3] then return 0 end
redis.call('DEL', KEYS[1], KEYS[4])
return 1
`;

// 他のサーバーのメンバーには、参加者が変わったときのほか、変わらなくてもこの間隔で送り直してミラーの寿命を延ばす。
// 送り直しは読み直し (sweep) のついでに行うので、実際の間隔は最大でこれに SWEEP_INTERVAL_MS を足したものになる
const FEDERATION_RESEND_INTERVAL_MS = 240_000;

// 参加者が目まぐるしく変わっても (画面共有の切り替えや出入りの繰り返し) 配送が膨らまないよう、
// 他のサーバーへはルームごとにこの間隔に一度だけ送る。全ワーカーで Redis の鍵を共有して数える
const FEDERATION_MIN_INTERVAL_MS = 10_000;

// ミラーのメイン通知をルームごと・全ワーカーで制限する。時計は Redis のものを使う。
// 空の通知は直前に通知した参加者をすぐ消すが、参加者の通知間隔はリセットしない。
// KEYS: 通知記録、現況、世代。ARGV: 世代、現況の時刻、空なら 1、間隔 ms、記録 TTL 秒。
// -1: 通知する、-2: 世代変更、-3: 現況変更、0: 通知済み/空の繰り返し、正数: 次の参加者通知までの待ち時間。
const GATE_MIRROR_PUBLICATION_SCRIPT = `-- GATE_MIRROR_PUBLICATION
if (redis.call('GET', KEYS[3]) or '0') ~= ARGV[1] then return -2 end
local raw = redis.call('GET', KEYS[2])
if not raw then return -3 end
local snapshot = cjson.decode(raw)
if snapshot.updatedAt ~= tonumber(ARGV[2]) then return -3 end
local lastRaw = redis.call('GET', KEYS[1])
local last = lastRaw and cjson.decode(lastRaw) or nil
if last and last.updatedAt >= snapshot.updatedAt then return 0 end
local empty = ARGV[3] == '1'
if empty and last and last.empty then return 0 end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local activeAt = last and last.activeAt or nil
if not empty and activeAt and now - activeAt < tonumber(ARGV[4]) then
	return tonumber(ARGV[4]) - (now - activeAt)
end
if not empty then activeAt = now end
redis.call('SET', KEYS[1], cjson.encode({ updatedAt = snapshot.updatedAt, empty = empty, activeAt = activeAt }), 'EX', ARGV[5])
return -1
`;

// 他のサーバーへ送るかを決めてから、配送を積み、送った記録を残すまでは、ルームごとに全ワーカーで一つずつ行う (その順番の鍵の寿命)。
// 積むのは普通すぐに終わる。途中で止まったワーカーの鍵は、この寿命で切れる
const FEDERATION_LOCK_MS = 30_000;

// 順番の鍵が空いていないときに待つ間隔。REFRESH_DELAY_MS から待つたびに倍にし、この長さで止める
const FEDERATION_LOCK_RETRY_MAX_MS = 4_000;

// 他のサーバーへ送るかを決められない (順番の鍵が空かない、鍵を取った後に LiveKit を読めない) まま、最初に決められなかったときから
// これだけ経ったら、決め直すのをやめる。配送を積めないときも同じ期限を使う。
// ミラーの保存後の寿命は REMOTE_SNAPSHOT_TTL_SECONDS だが、参加者のいる現況は最大 REMOTE_ACTIVE_SNAPSHOT_MAX_AGE_MS 前のものまで
// 受け入れるので、遅れて届いたミラーはこの期限を越えて残りうる。期限は再試行の仕事量を抑えるためのもので、ミラーの消滅を保証しない。
// LiveKit が戻った後の通話は、webhook と定期的な読み直しで送る
const FEDERATION_RETRY_LIMIT_MS = REMOTE_SNAPSHOT_TTL_SECONDS * 1000;

// 送るかを決めた現況の時刻 (増える一方) を覚えておく長さ。順番の鍵が切れた後も手間取っているワーカーの決定より十分長くする
const FEDERATION_DECIDED_TTL_SECONDS = 3_600;

// ルームの時刻の列から次の時刻を決めて返す。列は、このサーバーの現況の時刻 (chatVoice:localStamp) と、他のサーバーへ送るかを決めた
// 現況の時刻 (chatVoice:federateDecided) の二つ。この時計の時刻 (ARGV[1]) と、二つの列それぞれの最後の時刻の 1 ミリ秒後のうち、
// 最も遅いものにして、KEYS[1] の列に残す (KEYS[2] の列は読むだけ)。
// どのワーカーの時計で決めても、Redis で後に決めた時刻は、前に決めたどちらの列の時刻よりも必ず後になり、同じ時刻にもならない
// (受け取る側は時刻の新しい現況しか受け入れない)。時計が遅れたワーカーも待たずに決められる。
// 他のサーバーは、送られた現況 (送るかを決めた時刻) と、参加したときに渡された現況 (このサーバーの現況の時刻) を同じように比べるので、
// 二つの列を一つの順番にする。ただし送るかを決めた時刻の列は、決めるときにだけ書く (このサーバーの現況のために書くと、
// 送っている途中の決定の記録が古いものとして断られる)。
// 前の時刻が読めなければ無いものとして扱う。KEYS[1]: 決める列、KEYS[2]: もう一方の列、ARGV: この時計の時刻、KEYS[1] の寿命 (秒)
const ALLOCATE_STAMP_SCRIPT = `
local stamp = tonumber(ARGV[1])
for i = 1, 2 do
	local last = tonumber(redis.call('GET', KEYS[i]))
	if last and last + 1 > stamp then
		stamp = last + 1
	end
end
redis.call('SET', KEYS[1], string.format('%.0f', stamp), 'EX', ARGV[2])
return stamp
`;

// raw-null の参加応答だけが無効化する境界。通常の refresh の時刻とは分け、古い配送の記録で送り直しを抑止させない。
// KEYS: ローカル時刻、配送時刻、参加応答の境界、配送記録。境界の更新と記録の消去は同じ操作にする。
const INVALIDATE_JOIN_SNAPSHOT_SCRIPT = `
local stamp = tonumber(ARGV[1])
for i = 1, 3 do
	local last = tonumber(redis.call('GET', KEYS[i]))
	if last and last + 1 > stamp then stamp = last + 1 end
end
redis.call('SET', KEYS[1], string.format('%.0f', stamp), 'EX', ARGV[2])
redis.call('SET', KEYS[3], string.format('%.0f', stamp), 'EX', ARGV[2])
redis.call('DEL', KEYS[4])
return stamp
`;

// 送る順番の鍵を、自分が取ったもの (ARGV[1]) のときだけ外す。寿命が切れた後にほかのワーカーが取った鍵は外さない
const RELEASE_FEDERATION_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
	return redis.call('DEL', KEYS[1])
end
return 0
`;

// 他のサーバーに送った記録を、保存済みの記録より新しい現況 (updatedAt が大きい) のもので、送るかを決めた最新の時刻より前の現況の
// ものでもなければ書く。書いたら 1、書かなければ 0。保存済みの記録や時刻が読めないか updatedAt を持たなければ、無いものとして扱う。
// KEYS[1]: 記録の鍵、KEYS[2]: 配送時刻、KEYS[3]: raw-null 参加応答の境界、ARGV: 記録 (JSON)、その updatedAt、寿命 (秒)
const RECORD_FEDERATED_IF_NOT_OLDER_SCRIPT = `
local updatedAt = tonumber(ARGV[2])
local invalidated = tonumber(redis.call('GET', KEYS[3]))
if invalidated and invalidated >= updatedAt then return 0 end
local decided = tonumber(redis.call('GET', KEYS[2]))
if decided and decided > updatedAt then
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
return 1
`;

// このサーバーが持つルームの現況を、保存済みのものより新しい (updatedAt が大きい) ときだけ書き、通話中のルームの一覧も合わせて変える。
// 書いたら 1、書かなければ 0。比べてから一覧を変えるまでを一つの操作にし、遅れて読み終えた古い現況が新しい現況や一覧を戻さないようにする。
// 空の現況 (通話の終わり) も時刻ごと残す (getStates は空のものを返さない)。保存済みのものが読めなければ無いものとして扱う。
// KEYS[1]: 現況の鍵、KEYS[2]: 通話中のルームの一覧、ARGV: 現況 (JSON)、その updatedAt、寿命 (秒)、ルームの id、空なら '1'
const STORE_LOCAL_SNAPSHOT_IF_NEWER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
	local ok, stored = pcall(cjson.decode, current)
	if ok and type(stored) == 'table' and type(stored.updatedAt) == 'number' and stored.updatedAt >= tonumber(ARGV[2]) then
		return 0
	end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
if ARGV[5] == '1' then
	redis.call('SREM', KEYS[2], ARGV[4])
else
	redis.call('SADD', KEYS[2], ARGV[4])
end
return 1
`;

// 入った直後の参加者が残れるかを、読めないものがあって決められなかったとき、確かめ直すまで待つ長さ。
// 確かめ直しても決められなければ外す (このサーバーで確かめられない接続は受け入れない。外された人は入り直せる)
const JOIN_RECHECK_DELAY_MS = 2_000;

// 定期的な読み直し (sweep) で、残れるかを続けてこの回数決められなかった参加者を外す (読み直しは SWEEP_INTERVAL_MS ごとなので約 3 分)。
// 一度でも決められたら数え直す
const UNVERIFIED_SWEEP_LIMIT = 3;
// 続けて決められなかった回数を覚えておく長さ。読み直しの間隔より長くし、しばらく読み直されなければ数え直す
const UNVERIFIED_TTL_SECONDS = 300;

// 続けて決められなかった回数を一つ増やし、寿命を延ばして、増やした後の回数を返す。KEYS[1]: 回数の鍵、ARGV[1]: 寿命 (秒)
const COUNT_UNVERIFIED_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return count
`;

// サーバーの停止の知らせはすべてのワーカーに届く。ルームごとに一つのワーカーだけが確かめ直すよう、この間だけ鍵を取る
const SUSPENSION_RECHECK_LOCK_SECONDS = 10;

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
	participants: { identity: string; userId: MiUser['id']; screenSharing: boolean; micMuted?: boolean; deafened?: boolean }[];
	updatedAt: number;
};

/** 他のサーバーのユーザーを断るかどうかに関わる設定 */
type FederationPolicy = { blockedHosts?: string[]; federation?: string; federationHosts?: string[] };

/**
 * ミラーの参加者を見せるかを決める共有設定 (MetaService.fetch(true)) と、それを読む前の epoch・世代 (readMirrorPolicy)。
 * 一つの操作 (保存と通知、一覧、消去のまとまり) で一度だけ読んで使い回し、終わりに epoch と世代を比べる。policy が null なら読めなかった (見せない)
 */
type MirrorPolicy = { version: number; generation: string; policy: MiMeta | null };

/**
 * ミラーの現況を見せるか (voiceVisibilityOf)。
 * - visible: 見せる
 * - superseded: 持ち主は許せるが、より新しい現況が保存されている。その現況の通知 (待たせたものは後でまとめて送る) が続く
 * - hidden: 参加者を見せない
 */
export type VoiceVisibility = 'visible' | 'superseded' | 'hidden';

/** 通話の参加者。userId はトークンに付けたメタデータの値 (無ければ null) */
type CallParticipant = { identity: string; userId: MiUser['id'] | null; canScreenShare?: boolean; screenSharing?: boolean };

/** トークンに付けたユーザーのある参加者 */
type NamedCallParticipant = CallParticipant & { userId: MiUser['id'] };

/** 読んだもの。読めなければ ok: false */
type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** あるルームの参加者が通話に残れるか (admissionOf) を確かめるために、ルームごとにまとめて引いたもの。読めなかったものは ok: false */
type AdmissionContext = {
	room: Read<MiChatRoom | null>;
	users: Read<Map<MiUser['id'], MiUser>>;
	memberIds: Read<Set<MiUser['id']>>;
	/** 参加者のユーザー (トークンに付けた userId) ごとのロールのポリシー */
	policies: Map<MiUser['id'], Read<RolePolicies>>;
	/**
	 * ホストごとの HostPolicyService.isRefusedRemoteHost の結果 (決められたものだけ)。定期的な読み直し (sweep) と、
	 * 設定の変更や停止の後の確かめ直しでは、ルームをまたいで使い回す
	 */
	refusedHosts: Map<string, boolean>;
	/** 読めなかったときのエラー (記録用) */
	errors: unknown[];
};

/**
 * 参加者が通話に残れるか (admissionOf)。
 * - admitted: 残れる
 * - denied: 残れない。読めたものだけで決まる
 * - unverified: 読めなかったものがあり、決められない
 */
type Admission = 'admitted' | 'denied' | 'unverified';

/**
 * 残れるかを確かめる場面。決められなかった (unverified) 参加者の扱いが違う。
 * - join: 入った直後 (participant_joined)。JOIN_RECHECK_DELAY_MS 後に一度だけ確かめ直し、それでも決められなければ外す
 * - sweep: 定期的な読み直し。続けて UNVERIFIED_SWEEP_LIMIT 回決められなければ外す
 * - recheck: 設定の変更や停止の後。外さない (定期的な読み直しが確かめ直す)
 */
type AdmissionCheck = 'join' | 'sweep' | 'recheck';

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
 * - old: この時計より、参加者がいれば REMOTE_ACTIVE_SNAPSHOT_MAX_AGE_MS、空なら REMOTE_SNAPSHOT_MAX_AGE_MS より前の時刻が付いている
 * - disabled: 他のサーバーの通話を止めている (保存の途中で止められた場合を含む)
 */
export type RemoteSnapshotStoreResult = 'stored' | 'stale' | 'ahead' | 'old' | 'disabled';

/** 他のサーバーに送った現況の記録。at は送った時刻、updatedAt は送った現況の時刻 */
type FederatedRecord = { hash: string; at: number; updatedAt: number };

/** 他のサーバーに渡す参加者の現況。userId はこのサーバーの DB の id なので含めない */
type FederatedVoiceSnapshot = {
	participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean }[];
	updatedAt: number;
};

/**
 * 通話に入るためのもの。iceServers は、このサーバーの通話では TURN が設定されていなければ null (LiveKit が渡すものを使う)。
 * 他のサーバーの通話 (RemoteVoiceCallService) では必ず一覧で、空のこともある (持ち主のサーバーの LiveKit が渡すものを使わせない)
 */
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
	/** ミラーのメイン通知を待たせたルームごとに、最新の現況を送り直す予定 */
	private pendingMirrorPublications = new Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>();
	/** 他のサーバーへ送るのを待たせたルームについて、送れるようになったときに送るかを決め直す予定 (federateRoom) */
	private pendingFollowUps = new Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>();
	/**
	 * 他のサーバーへ送るかを決められず、または配送を積めずに続けて待った回数 (waits) と、最初に失敗した時刻 (since)。ルームごと。
	 * 順番の鍵が空いていないとき、鍵を取った後に LiveKit を読めなかったとき、配送を積めなかったときに増やし、待つ間隔を延ばすのと、
	 * 決め直すのをやめる (FEDERATION_RETRY_LIMIT_MS) のに使う。すべての配送を積んで記録できたとき (または同じ現況の記録があるとき) と、待つのをやめたとき (ルームが無い・
	 * 他のサーバーのメンバーがいない・ルームを読めない・Redis が失敗した・待ちすぎた) に消す
	 */
	private federationBackoff = new Map<MiChatRoom['id'], { waits: number; since: number }>();
	private mirrorPolicyVersion = 0;
	private sweepTimer: NodeJS.Timeout | null = null;
	/** 入った直後の参加者を確かめ直すまで待っているもの (wait)。止めるときは待つのをやめ、確かめ直さない */
	private pendingWaits = new Map<NodeJS.Timeout, (completed: boolean) => void>();
	private isShuttingDown = false;
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

		private liveKitService: LiveKitService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private roleService: RoleService,
		private hostPolicyService: HostPolicyService,
		private apRendererService: ApRendererService,
		private queueService: QueueService,
		private loggerService: LoggerService,
		private cloudflareTurnService: CloudflareTurnService,
		private metaService: MetaService,
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
			this.hostPolicyService.isRefusedRemoteHost(user.host),
			this.roleService.getUserPolicies(user.id),
		]);

		// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーで開く。保管済みのルームはローカルと同じく断る
		if (room == null || room.owner == null || room.owner.host != null || room.isArchived) return 'forbidden';

		// 通話に残れるか (admissionOf) と同じく、停止・削除されたユーザーには発行しない
		if (user.isSuspended || user.isDeleted) return 'forbidden';
		if (isRefusedHost) return 'forbidden';
		if (!isMember) return 'forbidden';

		// トークンは常にマイクを許すので、ローカルの参加と同じくチャットの書き込み権限も求める
		if (!policies.canVoiceCall || policies.chatAvailability !== 'available') return 'forbidden';

		const { url, token, iceServers } = await this.issueJoinToken(user, room, canScreenShareRequested && policies.canScreenShare);
		const { participants, updatedAt } = await this.snapshotOf(room.id);
		return { url, token, iceServers, participants, updatedAt };
	}

	/** Accept only the authenticated user's own connected session and reported settings. */
	@bindThis
	public async reportStatus(user: MiUser, roomId: string, sessionId: string, status: { micMuted: boolean; deafened: boolean }): Promise<boolean> {
		if (!this.liveKitService.isEnabled) return false;
		const participant = { identity: this.liveKitService.identityOf(user), userId: user.id };
		const context = await this.admissionContextOf(roomId, [participant], new Map());
		if (this.admissionOf(participant, context) !== 'admitted' || !context.room.ok || context.room.value == null) return false;
		const owner = await this.usersRepository.findOneBy({ id: context.room.value.ownerId });
		if (owner == null || owner.host != null) return false;
		if (!await this.liveKitService.setParticipantStatus(roomId, participant.identity, sessionId, status)) return false;
		await this.refresh(roomId);
		return true;
	}

	/**
	 * 通話中のすべてのルームで、いま残れない参加者 (admissionOf) を外す (reconcileRoom)。
	 * ブロックや連合の設定が変わったときと、管理画面でサーバーを停止したときに、定期的な読み直し (sweep) を待たずに呼ぶ。
	 * 外すのは何度しても同じ結果になるので、複数のワーカーが同時に動いてもよい。
	 * lock を渡すと、ルームごとに SUSPENSION_RECHECK_LOCK_SECONDS のあいだ鍵を取り、同じ lock で確かめ直すのは一つのワーカーだけにする
	 */
	@bindThis
	public async removeRefusedRemoteParticipants(options: { lock?: string } = {}): Promise<void> {
		const roomIds = await this.redisClient.smembers(ACTIVE_ROOMS_KEY);
		// サーバーを断るかは、ルームをまたいで一度だけ決める
		const refusedHosts = new Map<string, boolean>();
		for (const roomId of roomIds) {
			if (options.lock != null) {
				const locked = await this.redisClient.set(`chatVoice:recheck:${options.lock}:${roomId}`, '1', 'EX', SUSPENSION_RECHECK_LOCK_SECONDS, 'NX');
				if (locked !== 'OK') continue;
			}
			await this.reconcileRoom(roomId, refusedHosts);
		}
	}

	/**
	 * ルームの通話の参加者を LiveKit から読み、いまそのルームに残れない参加者 (admissionOf) を外す。
	 * 読めない・決められない・外せないときは記録だけして戻る。定期的な読み直し (sweep) が同じことをするので、次の読み直しでやり直される。
	 * refusedHosts は、サーバーを断るかを決めた結果。渡せば、ほかのルームと使い回す
	 */
	@bindThis
	public async reconcileRoom(roomId: MiChatRoom['id'], refusedHosts = new Map<string, boolean>()): Promise<void> {
		let participants: LiveKitParticipant[];
		try {
			participants = await this.liveKitService.listParticipants(roomId);
		} catch (err) {
			this.logger.warn(`Failed to list the participants of the voice call in ${roomId}`, { error: err });
			return;
		}
		await this.removeUnadmitted(roomId, participants, refusedHosts, 'recheck');
	}

	/**
	 * 通話に入った参加者が、いまもそのルームに残れるか (admissionOf) を確かめ、残れなければ外す。
	 * トークンは 10 分有効なので、ルームを抜けたりサーバーが断られたりした後でも、同じトークンで入り直せてしまうため。
	 * トークンにユーザーの無い参加者は、何も読まずに外す (このサーバーはユーザーの無いトークンを発行しない)。
	 * 読めないものがあって決められなければ、JOIN_RECHECK_DELAY_MS 後に一度だけ確かめ直し、それでも決められなければ外す (入り直せる)
	 */
	@bindThis
	public async removeUnadmittedParticipant(roomId: MiChatRoom['id'], participant: { identity: string; metadata?: string }): Promise<void> {
		await this.removeUnadmitted(roomId, [{ identity: participant.identity, userId: userIdOfMetadata(participant.metadata) }], new Map(), 'join');
	}

	/**
	 * 保存してある参加者の現況。他のサーバーのユーザーが参加するときに渡し、相手のサーバーはこの時刻と、後で送られる現況の時刻を比べる。
	 * 通話が終わった後も、終わりを保存してから SNAPSHOT_TTL_SECONDS のあいだは、終わりの時刻で空の一覧を返す。
	 * 何も保存されていなければ、ルームの時刻の列から決めた時刻 (ALLOCATE_STAMP_SCRIPT) で空の一覧を返す。
	 * どちらの時刻もこのサーバーの現況の時刻の列のものなので、この後で送るかを決めた現況の時刻は、返した時刻より必ず後になる
	 */
	@bindThis
	public async snapshotOf(roomId: MiChatRoom['id']): Promise<FederatedVoiceSnapshot> {
		const raw = await this.redisClient.get(this.keyOf(roomId));
		if (raw == null) {
			const updatedAt = Number(await this.redisClient.eval(INVALIDATE_JOIN_SNAPSHOT_SCRIPT, 4,
				this.localStampKeyOf(roomId), this.decidedKeyOf(roomId), `chatVoice:joinInvalidated:${roomId}`,
				`chatVoice:federated:${roomId}`, Date.now(), LOCAL_STAMP_TTL_SECONDS));
			// トークンを求めた人が接続しなくても、同じ参加者を予算内で送り直す。
			this.retryFederationLater(roomId);
			return { participants: [], updatedAt };
		}
		const snapshot = JSON.parse(raw) as VoiceSnapshot;
		return {
			participants: snapshot.participants.map(p => ({ identity: p.identity, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) })),
			updatedAt: snapshot.updatedAt,
		};
	}

	/**
	 * ミラーの持ち主を許せるときだけ参加者を見せる。読み取りに失敗したときも閉じる。
	 * updatedAt を渡すと、その時刻の現況がいま保存されているときだけ見せる。read を渡すと、その操作で読んだ共有設定を使い回す
	 */
	public async isRoomVoiceVisible(room: MiChatRoom, updatedAt?: number, read?: MirrorPolicy): Promise<boolean> {
		return await this.voiceVisibilityOf(room, updatedAt, read) === 'visible';
	}

	/**
	 * isRoomVoiceVisible と同じく決め、持ち主は許せるが updatedAt より新しい現況が保存されていれば superseded を返す (VoiceVisibility)。
	 * read を渡さなければ共有設定を読む
	 */
	public async voiceVisibilityOf(room: MiChatRoom, updatedAt?: number, read?: MirrorPolicy): Promise<VoiceVisibility> {
		try {
			if (room.owner == null) return 'hidden';
			if (room.owner.host == null) return 'visible';
			const { version, generation, policy } = read ?? await this.readMirrorPolicy();
			if (policy == null || room.owner.isSuspended || room.owner.isDeleted || !isRemoteVoiceCallEnabled(policy)) return 'hidden';
			if (await this.hostPolicyService.isRefusedRemoteHost(room.owner.host, policy)) return 'hidden';
			let superseded = false;
			if (updatedAt != null) {
				const raw = await this.redisClient.get(this.keyOf(room.id));
				const stored = raw == null ? null : (JSON.parse(raw) as VoiceSnapshot).updatedAt;
				if (stored == null || stored < updatedAt) return 'hidden';
				superseded = stored > updatedAt;
			}
			if (version !== this.mirrorPolicyVersion || await this.remoteGenerationOf() !== generation) return 'hidden';
			return superseded ? 'superseded' : 'visible';
		} catch {
			return 'hidden';
		}
	}

	/**
	 * ミラーの参加者を見せるかを決める共有設定を読む (MirrorPolicy)。世代は設定を読む前に取り、読んでいるあいだの取り消しも終わりの比較で閉じる。
	 * 設定が読めなければ policy を null にする。世代が読めなければ例外を投げる
	 */
	private async readMirrorPolicy(): Promise<MirrorPolicy> {
		const version = this.mirrorPolicyVersion;
		const generation = await this.remoteGenerationOf();
		return { version, generation, policy: await this.metaService.fetch(true).catch(() => null) };
	}

	@bindThis
	public async getStates(me: { id: MiUser['id'] }, roomIds: MiChatRoom['id'][]): Promise<Packed<'ChatRoomVoiceState'>[]> {
		if (roomIds.length === 0) return [];
		const raws = await this.redisClient.mget(...roomIds.map(roomId => this.keyOf(roomId)));
		const states: Packed<'ChatRoomVoiceState'>[] = [];
		// ミラーのルームは、現況を読んだ後に一度だけ読んだ共有設定で決める (ミラーが無ければ読まない)。読めなければルームごとに読み直して閉じる
		let read: MirrorPolicy | undefined;
		for (let i = 0; i < roomIds.length; i++) {
			const raw = raws[i];
			if (raw == null) continue;
			const snapshot = JSON.parse(raw) as VoiceSnapshot;
			if (snapshot.participants.length === 0) continue;
			const version = this.mirrorPolicyVersion;
			const room = await this.chatRoomsRepository.findOne({ where: { id: roomIds[i] }, relations: { owner: true } }).catch(() => null);
			if (room == null) continue;
			if (room.owner?.host != null) read ??= await this.readMirrorPolicy().catch(() => undefined);
			if (!(await this.isRoomVoiceVisible(room, undefined, read))) continue;
			const packed = await this.pack(roomIds[i], snapshot, me);
			if (version === this.mirrorPolicyVersion && await this.isRoomVoiceVisible(room, snapshot.updatedAt, read)) states.push(packed);
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
			// 決められなかったときは確かめ直す。外せなかったときは removeUnadmitted が記録し、定期的な読み直し (sweep) がやり直す
			this.removeUnadmittedParticipant(roomId, participant).catch(() => {});
		}

		this.scheduleRefresh(roomId);
	}

	/**
	 * ルームを少し後に読み直す。ルームごとに一つにまとめる
	 */
	@bindThis
	public scheduleRefresh(roomId: MiChatRoom['id']): void {
		this.scheduleIn(this.pendingRefreshes, roomId, REFRESH_DELAY_MS, () => this.refresh(roomId).catch(err => {
			// 次の webhook か定期的な読み直しか通話参加時に読み直されるので、記録だけする
			this.logRefreshFailure(roomId, err);
		}));
	}

	/**
	 * ルームの参加者を LiveKit から読み直して保存し、メンバーに知らせ、他のサーバーへ送るかを決める。
	 * refusedHosts を渡すと (定期的な読み直し)、読んだ参加者のうちいまそのルームに残れない者を外し (removeUnadmitted の sweep。
	 * 決められない参加者は、続けて UNVERIFIED_SWEEP_LIMIT 回決められなければ外す)、外せた者を除いて保存する。
	 * サーバーを断るかを決めた結果は refusedHosts に残し、ほかのルームと使い回す
	 */
	@bindThis
	public async refresh(roomId: MiChatRoom['id'], refusedHosts?: Map<string, boolean>): Promise<void> {
		// 現況の時刻は、LiveKit を読み始める前に Redis で決める (ALLOCATE_STAMP_SCRIPT)。読むのに手間取った現況が、後から読み始めた
		// (新しい) 現況より新しく見えないように。ワーカーの時計がずれていても、参加者が変わった後に読み始めた読み直し (その webhook の
		// もの) の時刻は、変わる前に読み始めたものより必ず後になる。同じミリ秒に読み始めても同じ時刻にはならない
		const readAt = await this.allocateStamp(this.localStampKeyOf(roomId), this.decidedKeyOf(roomId), LOCAL_STAMP_TTL_SECONDS);
		// 最初の読み取りが失敗しても、次の sweep で権限を確かめ直す。
		await this.redisClient.sadd(ACTIVE_ROOMS_KEY, roomId);
		const listed = await this.liveKitService.listParticipants(roomId);
		// 残れない参加者を外すのにも、時刻を決めた後に読んだこの一覧を使い、LiveKit を読み直さない。
		// 外している間に変わった参加者は、その webhook の読み直し (後に決めた時刻) が保存する
		const removed = refusedHosts != null ? await this.removeUnadmitted(roomId, listed, refusedHosts, 'sweep') : new Set<string>();
		const participants = listed.filter(p => !removed.has(p.identity));
		const snapshot: VoiceSnapshot = {
			participants: participants.map(p => ({ identity: p.identity, userId: p.userId, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) })),
			updatedAt: readAt,
		};

		// 後から読み始めた (後に時刻を決めた) 読み直しが保存していれば、この現況では保存も、通話中の一覧の変更も、メンバーへの知らせもしない
		const stored = await this.redisClient.eval(
			STORE_LOCAL_SNAPSHOT_IF_NEWER_SCRIPT,
			2,
			this.keyOf(roomId),
			ACTIVE_ROOMS_KEY,
			JSON.stringify(snapshot),
			snapshot.updatedAt,
			SNAPSHOT_TTL_SECONDS,
			roomId,
			snapshot.participants.length === 0 ? '1' : '0',
		) === 1;

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return;

		// 通話の参加者はルームの今のメンバーにだけ知らせる。ルームのストリーム (chatRoom) はメンバーでないモデレーターも購読でき、
		// 抜けたメンバーの購読も続くので使わない。main ストリームを持つのはこのサーバーのユーザーだけ
		const audience = await this.audienceOf(room);
		if (stored) {
			const packed = await this.pack(roomId, snapshot, null);
			for (const userId of audience.localUserIds) {
				this.globalEventService.publishMainStream(userId, 'chatRoomVoiceState', packed);
			}
		}

		// 他のサーバーへ送るかは、順番の鍵を取ってから LiveKit を読み直して決める (federateChanges)
		await this.federateChanges(room, audience);
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
			case 'old': return 'skip: voice state is too old';
			case 'disabled': return 'skip: remote voice calls are disabled';
		}
	}

	/**
	 * 他のサーバーが持つルーム (ミラー) について、ホストから届いた参加者の現況を保存し、このサーバーのメンバーに知らせる。
	 * room は持ち主 (owner) を読み込んだもの。持ち主がこのサーバーのユーザーなら (ミラーでなければ) 例外を投げる。
	 * updatedAt はホストの時刻。保存済みのもの以前の現況と、この時計より REMOTE_SNAPSHOT_MAX_AHEAD_MS より先の現況は捨てる。
	 * 保存済みの現況の寿命が切れた後も、最後に受け入れた時刻 (REMOTE_SNAPSHOT_LAST_SEEN_TTL_SECONDS のあいだ覚えておく) 以前の現況は捨てる。
	 * 覚えておく間が過ぎた後にも古い現況を書かないよう、REMOTE_SNAPSHOT_MAX_AGE_MS より古い現況も捨てる。
	 * 参加者のいる現況は、ミラーでの寿命に時計のずれを足した REMOTE_ACTIVE_SNAPSHOT_MAX_AGE_MS より古ければ捨てる。
	 * inbox に届いた現況も、参加したときにホストから受け取った現況も、すべてここを通る。
	 * 参加者は、このサーバーが知っているユーザーだけを残す。そのうちこのサーバーのユーザーは、ルームのメンバーでなければ外す。
	 * 他のサーバーのユーザー (持ち主を含む) がメンバーかはこのサーバーでは分からないので、そのサーバーを断っていなければ残す。
	 * 他のサーバーの通話を止めているあいだは保存しない。保存の途中で止められたときも、書かず (REMOTE_GENERATION_KEY)、知らせない。
	 * 結果 (RemoteSnapshotStoreResult) を返す。
	 * ミラーの通話はこのサーバーの LiveKit には無いので、定期的な読み直し (sweep) の対象には加えない
	 */
	@bindThis
	public async storeRemoteSnapshot(room: MiChatRoom, participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean }[], updatedAt: number): Promise<RemoteSnapshotStoreResult> {
		// このサーバーのルームの現況は LiveKit から読む。ホストの言う現況で上書きさせない
		if (room.owner == null || room.owner.host == null) {
			throw new Error(`Voice call participants sent by another server can only be stored for a room owned there: ${room.id}`);
		}

		if (updatedAt > Date.now() + REMOTE_SNAPSHOT_MAX_AHEAD_MS) return 'ahead';
		const maxAge = participants.length > 0 ? REMOTE_ACTIVE_SNAPSHOT_MAX_AGE_MS : REMOTE_SNAPSHOT_MAX_AGE_MS;
		if (updatedAt < Date.now() - maxAge) return 'old';
		// 共有設定を読む前の世代を保存し、その読み取り中に別ワーカーで取り消された保存を断る。
		// 共有設定はこの保存と通知で一度だけ読み、持ち主と参加者のサーバーのどちらもそれで決める
		const read = await this.readMirrorPolicy();
		const { generation, policy } = read;
		if (policy == null || !(await this.isRoomVoiceVisible(room, undefined, read))) return 'disabled';

		const seen = new Set<string>();
		const capped = participants.slice(0, MAX_ROOM_MEMBERS + 1).filter(p => {
			if (seen.has(p.identity)) return false;
			seen.add(p.identity);
			return true;
		});
		const users = await this.knownUsersOf(capped.map(p => p.identity));
		// ホストは、このサーバーのユーザーなら誰でも参加者として送れる。このサーバーのユーザーかどうかは、送られた identity ではなく
		// DB のユーザーで決め、メンバーでなければ外す
		const localMemberIds = await this.memberIdsOf(room, [...new Set([...users.values()].filter(user => user.host == null).map(user => user.id))]);
		const refusedHosts = await this.hostPolicyService.refusedRemoteHostsOf([...new Set([...users.values()].flatMap(user => user.host ?? []))], policy);
		const snapshot: VoiceSnapshot = { participants: [], updatedAt };
		for (const p of capped) {
			const user = users.get(p.identity);
			if (user == null) continue;
			if (user.host == null && !localMemberIds.has(user.id)) continue;
			if (user.host != null && refusedHosts.get(user.host) !== false) continue;
			snapshot.participants.push({ identity: p.identity, userId: user.id, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) });
		}

		// 他のサーバーの通話を止めた後に、止める前に始まった参加の応答が届いても書かない (止めたときにミラーの現況は消している)
		if (!(await this.isRoomVoiceVisible(room, undefined, read))) return 'disabled';

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

		return await this.publishMirrorSnapshot(room, snapshot, read) ? 'stored' : 'disabled';
	}

	/**
	 * 一度に通知する相手は現在のローカルメンバーだけ。通知しなかった参加者の変更は最新の現況にまとめる。
	 * read は保存 (またはまとめて送り直す予定) が読んだ共有設定。最後に epoch と世代を比べ、そのあいだに止められていれば知らせない
	 */
	private async publishMirrorSnapshot(room: MiChatRoom, snapshot: VoiceSnapshot, read: MirrorPolicy): Promise<boolean> {
		const { generation } = read;
		if (!(await this.isRoomVoiceVisible(room, undefined, read))) return false;
		const gate = Number(await this.redisClient.eval(GATE_MIRROR_PUBLICATION_SCRIPT, 3,
			`chatVoice:mirrorPublished:${room.id}`, this.keyOf(room.id), REMOTE_GENERATION_KEY,
			generation, snapshot.updatedAt, snapshot.participants.length === 0 ? '1' : '0', FEDERATION_MIN_INTERVAL_MS, REMOTE_SNAPSHOT_TTL_SECONDS));
		if (gate === -2) return false;
		if (gate > 0) {
			this.scheduleIn(this.pendingMirrorPublications, room.id, gate, () => this.flushMirrorPublication(room.id).catch(err => {
				this.logger.warn({ message: 'Failed to publish coalesced mirror voice state', error: err });
			}));
		}
		if (gate !== -1) return true;
		const [packed, memberships] = await Promise.all([
			this.pack(room.id, snapshot, null),
			this.chatRoomMembershipsRepository.findBy({ roomId: room.id, user: { host: IsNull() } }),
		]);
		if (await this.remoteGenerationOf() !== generation || !(await this.isRoomVoiceVisible(room, undefined, read))) return false;
		for (const membership of memberships) this.globalEventService.publishMainStream(membership.userId, 'chatRoomVoiceState', packed);
		return true;
	}

	private async flushMirrorPublication(roomId: MiChatRoom['id']): Promise<void> {
		// 世代と共有設定は、送り直す現況を読む前に一度だけ読む
		const read = await this.readMirrorPolicy();
		const [room, raw] = await Promise.all([
			this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } }),
			this.redisClient.get(this.keyOf(roomId)),
		]);
		if (room?.owner?.host == null || raw == null) return;
		await this.publishMirrorSnapshot(room, JSON.parse(raw) as VoiceSnapshot, read);
	}

	/**
	 * ミラーの現況を消し、空の状態を知らせる。refusedOnly なら持ち主を断ったルームだけを消す。
	 * 他のサーバーの通話を止めたときにも呼び、寿命 (REMOTE_SNAPSHOT_TTL_SECONDS) まで残さない。
	 * 先に世代 (REMOTE_GENERATION_KEY) を増やし、止める前に始まった書き込みが、消した後に届いても書けないようにする。
	 * ミラーは持ち主が他のサーバーのユーザーのルーム。それを id 順に少しずつ引き、現況の鍵を消す (無い鍵を消しても何も起きない)。
	 * 最後に受け入れた時刻は残し、また通話を使うようにした後に古い現況が届いても書かないようにする。
	 * 何度消しても同じ結果になるので、複数のワーカーが同時に動いてもよい。
	 * 途中で設定が変わってもやめない。後から始まった消去が世代を増やしていれば、CAS がこの消去の残りを断る
	 */
	@bindThis
	public async clearMirrorSnapshots(refusedOnly = false): Promise<void> {
		const generation = String(await this.redisClient.incr(REMOTE_GENERATION_KEY));
		let lastId: MiChatRoom['id'] | null = null;
		for (;;) {
			const rooms: MiChatRoom[] = await this.chatRoomsRepository.find({
				relations: { owner: true },
				where: { owner: { host: Not(IsNull()) }, ...(lastId != null ? { id: MoreThan(lastId) } : {}) },
				order: { id: 'ASC' },
				take: MIRROR_CLEAR_BATCH_SIZE,
			});
			if (rooms.length === 0) return;
			// 断ったかは、このまとまりの現況をすべて読んだ後に一度だけ読んだ共有設定で決める。
			// 設定を読む前に (許されて) 保存された現況はその設定でも許され、読んだ後に保存された現況は読んだものと違うので CAS が消さない
			const raws = await this.redisClient.mget(...rooms.flatMap(room => [this.keyOf(room.id), this.lastSeenKeyOf(room.id)]));
			const read = refusedOnly ? await this.readMirrorPolicy() : null;
			for (const [i, room] of rooms.entries()) {
				const previous = raws[i * 2];
				const lastSeen = raws[i * 2 + 1];
				if (read != null && await this.isRoomVoiceVisible(room, undefined, read)) continue;
				// ホストの時系列にこのサーバーの時計を混ぜない。同じ時刻の空状態も frontend は適用する。
				const updatedAt = Math.max(Number(lastSeen ?? 0), previous == null ? 0 : (JSON.parse(previous) as VoiceSnapshot).updatedAt);
				const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id, user: { host: IsNull() } });
				const cleared = await this.redisClient.eval(CLEAR_MIRROR_IF_CURRENT_SCRIPT, 4,
					this.keyOf(room.id), this.lastSeenKeyOf(room.id), REMOTE_GENERATION_KEY, `chatVoice:mirrorPublished:${room.id}`,
					generation, previous ?? '', lastSeen ?? '');
				if (cleared !== 1) continue;
				// 配送先の読み取りは CAS 前に済ませ、消した後の別の現況を遅れて消さない。
				for (const membership of memberships) this.globalEventService.publishMainStream(membership.userId, 'chatRoomVoiceState', { roomId: room.id, participants: [], updatedAt });
			}
			if (rooms.length < MIRROR_CLEAR_BATCH_SIZE) return;
			lastId = rooms[rooms.length - 1].id;
		}
	}

	/**
	 * 通話中のルームを LiveKit から読み直す。複数のワーカーが同時に動いても、各ルームを読むのは一つだけ。
	 * 読み直すときに、いま残れない参加者を外す (refresh)。設定の変更や停止の後で通話中になったルーム、
	 * 自動で停止されたサーバー、外せなかった参加者も、これで SWEEP_INTERVAL_MS のうちに外れる。
	 * サーバーを断るかは、ルームをまたいで一度だけ決める (次の読み直しでは、いまの記録で決め直す)
	 */
	@bindThis
	public async sweep(): Promise<void> {
		const roomIds = await this.redisClient.smembers(ACTIVE_ROOMS_KEY);
		const refusedHosts = new Map<string, boolean>();
		for (const roomId of roomIds) {
			const locked = await this.redisClient.set(`chatVoice:sweep:${roomId}`, '1', 'EX', SWEEP_LOCK_SECONDS, 'NX');
			if (locked !== 'OK') continue;
			await this.refresh(roomId, refusedHosts).catch(err => {
				// LiveKit に届かなければスナップショットの寿命切れに任せる
				this.logRefreshFailure(roomId, err);
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
		for (const pending of [this.pendingRefreshes, this.pendingFollowUps, this.pendingMirrorPublications]) {
			for (const { timer } of pending.values()) clearTimeout(timer);
			pending.clear();
		}
		this.federationBackoff.clear();
		this.isShuttingDown = true;
		for (const [timer, resolve] of this.pendingWaits) {
			clearTimeout(timer);
			resolve(false);
		}
		this.pendingWaits.clear();
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
					if (body.before == null || body.before.enableRemoteVoiceCall !== body.after.enableRemoteVoiceCall || isFederationPolicyChanged(body.before, body.after)) this.mirrorPolicyVersion++;
					if (isRemoteVoiceCallEnabled(body.after) && (body.before == null || isFederationPolicyChanged(body.before, body.after))) this.clearMirrorSnapshots(true).catch(err => this.logger.warn({ message: 'Failed to clear refused mirror voice states', error: err }));
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
				case 'instanceSuspensionStateUpdated': {
					this.mirrorPolicyVersion++;
					this.clearMirrorSnapshots(true).catch(err => this.logger.warn({ message: 'Failed to clear refused mirror voice states', error: err }));
					// 管理画面でサーバーが停止されたら、そのサーバーのユーザーを通話から外す (停止を解いたときは何もしない)。
					// 知らせはすべてのワーカーに届くので、ルームごとに一つのワーカーだけが確かめ直す (停止したサーバーごとに鍵を分ける)
					if (this.liveKitService.isEnabled && body.suspensionState !== 'none') {
						this.removeRefusedRemoteParticipants({ lock: `suspension:${body.id}` }).catch(err => {
							this.logger.error('Failed to remove voice call participants from the suspended server', { error: err });
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
		return `chatVoice:state:${roomId}`;
	}

	/** 他のサーバーの通話を止めた回数 (世代)。一度も止めていなければ '0' */
	private async remoteGenerationOf(): Promise<string> {
		return (await this.redisClient.get(REMOTE_GENERATION_KEY)) ?? '0';
	}

	/** ミラーの現況について、最後に受け入れた時刻 (updatedAt) を覚えておく鍵 */
	private lastSeenKeyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:lastSeen:${roomId}`;
	}

	/** このサーバーが持つルームの現況の時刻の列 (ALLOCATE_STAMP_SCRIPT) の鍵 */
	private localStampKeyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:localStamp:${roomId}`;
	}

	/** 他のサーバーへ送るかを決めた現況の時刻の列 (ALLOCATE_STAMP_SCRIPT) の鍵 */
	private decidedKeyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:federateDecided:${roomId}`;
	}

	/** ルームの時刻の列 key から次の時刻を決める (ALLOCATE_STAMP_SCRIPT)。other はもう一方の列で、読むだけ */
	private async allocateStamp(key: string, other: string, ttlSeconds: number): Promise<number> {
		return Number(await this.redisClient.eval(ALLOCATE_STAMP_SCRIPT, 2, key, other, Date.now(), ttlSeconds));
	}

	/**
	 * run を delayMs 後に動かす。pending ごと・ルームごとに一つにまとめ、予定済みのものより早く動かしたいときだけ早める
	 */
	private scheduleIn(pending: Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>, roomId: MiChatRoom['id'], delayMs: number, run: () => Promise<void>): void {
		// 止めた後に終わった処理は予定を残さない (止めるときに消した予定と同じく、プロセスを残さない)
		if (this.isShuttingDown) return;
		const dueAt = Date.now() + delayMs;
		const scheduled = pending.get(roomId);
		if (scheduled != null) {
			if (scheduled.dueAt <= dueAt) return;
			clearTimeout(scheduled.timer);
		}
		const timer = setTimeout(() => {
			pending.delete(roomId);
			run();
		}, delayMs);
		pending.set(roomId, { timer, dueAt });
	}

	/**
	 * delayMs 後に、他のサーバーへ送るかを決め直す (federateRoom)。このサーバーのメンバーには知らせ直さない
	 */
	private scheduleFollowUp(roomId: MiChatRoom['id'], delayMs: number): void {
		this.scheduleIn(this.pendingFollowUps, roomId, delayMs, () => this.federateRoom(roomId).catch(err => {
			// 次の webhook か定期的な読み直しで決め直されるので、記録だけする
			this.logger.warn(`Failed to send the voice call in ${roomId} to other servers: ${err instanceof Error ? err.message : String(err)}`);
		}));
	}

	/** 読み直し (refresh) に失敗したことを、ルームとエラーのメッセージだけで記録する */
	private logRefreshFailure(roomId: MiChatRoom['id'], err: unknown): void {
		this.logger.warn(`Failed to refresh the voice call in ${roomId}: ${err instanceof Error ? err.message : String(err)}`);
	}

	/**
	 * 参加者のうち、いまそのルームに残れない (admissionOf が denied の) ものを外し、外せた参加者の identity を返す。
	 * トークンにユーザーの無い参加者は、何も読まずに外す。ほかの参加者について読むものは、ルームごとにまとめて引く (admissionContextOf)。
	 * 読めたものだけで残れないと決まった参加者は、ほかに読めなかったものがあってもすぐに外す。
	 * 決められなかった (unverified) 参加者の扱いは check で変わる (AdmissionCheck)。外せなかった参加者は記録して残りを続ける。
	 * refusedHosts は、サーバーを断るかを決めた結果 (AdmissionContext)
	 */
	private async removeUnadmitted(roomId: MiChatRoom['id'], participants: CallParticipant[], refusedHosts: Map<string, boolean>, check: AdmissionCheck): Promise<Set<string>> {
		const denied: string[] = [];
		const named: NamedCallParticipant[] = [];
		for (const participant of participants) {
			if (participant.userId == null) denied.push(participant.identity);
			else named.push({ ...participant, userId: participant.userId });
		}

		const decision = named.length > 0 ? await this.admissionsOf(roomId, named, refusedHosts) : { admitted: [], denied: [], unverified: [] };
		denied.push(...decision.denied);
		const removed = await this.removeParticipants(roomId, denied);
		if (check !== 'sweep') await this.forgetUnverified(roomId, [...decision.admitted, ...decision.denied]);
		if (decision.unverified.length === 0 && check !== 'sweep') return removed;

		let giveUp: string[] = [];
		if (decision.unverified.length > 0) {
			const identities = decision.unverified.map(p => p.identity);
			switch (check) {
				case 'join': {
					this.logger.warn(`Could not check whether ${identities.join(', ')} may stay in the voice call in ${roomId}; checking again in ${JOIN_RECHECK_DELAY_MS / 1000} seconds`);
					giveUp = await this.recheckJoined(roomId, decision.unverified);
					break;
				}
				case 'sweep': {
					giveUp = await this.countUnverified(roomId, identities);
					break;
				}
				case 'recheck': {
					this.logger.warn(`Could not check whether ${identities.join(', ')} may stay in the voice call in ${roomId}; the periodic sweep will check again`);
					break;
				}
			}
			for (const identity of await this.removeParticipants(roomId, giveUp)) removed.add(identity);
		}

		// 定期的な読み直しでは、決められた参加者 (と、決められないまま外す参加者) の、続けて決められなかった回数を消す
		if (check === 'sweep') await this.forgetUnverified(roomId, [...decision.admitted, ...decision.denied, ...giveUp]);
		return removed;
	}

	/** 参加者を外し、外せた identity を返す。外せなかった参加者は記録して残りを続ける */
	private async removeParticipants(roomId: MiChatRoom['id'], identities: string[]): Promise<Set<string>> {
		const removed = new Set<string>();
		for (const identity of identities) {
			try {
				await this.liveKitService.removeParticipant(roomId, identity);
				removed.add(identity);
			} catch (err) {
				this.logger.warn(`Failed to remove ${identity}, who may not stay, from the voice call in ${roomId}`, { error: err });
			}
		}
		return removed;
	}

	/** 参加者それぞれが残れるか (admissionOf) を、まとめて読んだもの (admissionContextOf) で決め、結果ごとに分ける */
	private async admissionsOf(roomId: MiChatRoom['id'], participants: NamedCallParticipant[], refusedHosts: Map<string, boolean>): Promise<{ admitted: string[]; denied: string[]; unverified: NamedCallParticipant[] }> {
		const context = await this.admissionContextOf(roomId, participants, refusedHosts);
		const result = { admitted: [] as string[], denied: [] as string[], unverified: [] as NamedCallParticipant[] };
		for (const participant of participants) {
			switch (this.admissionOf(participant, context)) {
				case 'admitted': result.admitted.push(participant.identity); break;
				case 'denied': result.denied.push(participant.identity); break;
				case 'unverified': result.unverified.push(participant); break;
			}
		}
		if (result.unverified.length > 0) {
			this.logger.warn(`Failed to read what decides who may stay in the voice call in ${roomId}`, { error: context.errors[0] });
		}
		return result;
	}

	/**
	 * 入った直後に決められなかった参加者を、JOIN_RECHECK_DELAY_MS 後に一度だけ確かめ直す。外す参加者 (残れないか、まだ決められない) を返す。
	 * 待っているあいだに止められたら、確かめ直さず誰も外さない
	 */
	private async recheckJoined(roomId: MiChatRoom['id'], participants: NamedCallParticipant[]): Promise<string[]> {
		if (!(await this.wait(JOIN_RECHECK_DELAY_MS))) return [];
		const decision = await this.admissionsOf(roomId, participants, new Map());
		await this.forgetUnverified(roomId, [...decision.admitted, ...decision.denied]);
		if (decision.unverified.length > 0) {
			this.logger.warn(`Removing ${decision.unverified.map(p => p.identity).join(', ')} from the voice call in ${roomId}, as whether they may stay could not be checked twice`);
		}
		return [...decision.denied, ...decision.unverified.map(p => p.identity)];
	}

	/**
	 * 定期的な読み直しで決められなかった参加者について、続けて決められなかった回数を一つ増やし、UNVERIFIED_SWEEP_LIMIT 回に達した参加者を返す。
	 * 数えられなければ記録して、その参加者は外さない
	 */
	private async countUnverified(roomId: MiChatRoom['id'], identities: string[]): Promise<string[]> {
		const reached: string[] = [];
		for (const identity of identities) {
			try {
				const count = Number(await this.redisClient.eval(COUNT_UNVERIFIED_SCRIPT, 1, this.unverifiedKeyOf(roomId, identity), UNVERIFIED_TTL_SECONDS));
				if (count >= UNVERIFIED_SWEEP_LIMIT) reached.push(identity);
			} catch (err) {
				this.logger.warn(`Failed to count how long ${identity} could not be checked in the voice call in ${roomId}`, { error: err });
			}
		}
		if (reached.length > 0) {
			this.logger.warn(`Removing ${reached.join(', ')} from the voice call in ${roomId}, as whether they may stay could not be checked in ${UNVERIFIED_SWEEP_LIMIT} sweeps in a row`);
		}
		return reached;
	}

	/** 続けて決められなかった回数を消す */
	private async forgetUnverified(roomId: MiChatRoom['id'], identities: string[]): Promise<void> {
		if (identities.length === 0) return;
		await this.redisClient.del(...identities.map(identity => this.unverifiedKeyOf(roomId, identity))).catch(err => {
			this.logger.warn(`Failed to reset how long participants could not be checked in the voice call in ${roomId}`, { error: err });
		});
	}

	private unverifiedKeyOf(roomId: MiChatRoom['id'], identity: string): string {
		return `chatVoice:unverified:${roomId}:${identity}`;
	}

	/** ms 待つ。待っているあいだに止められたら (onApplicationShutdown) false */
	private wait(ms: number): Promise<boolean> {
		if (this.isShuttingDown) return Promise.resolve(false);
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.pendingWaits.delete(timer);
				resolve(true);
			}, ms);
			this.pendingWaits.set(timer, resolve);
		});
	}

	/**
	 * 参加者が残れるかを確かめるのに要るものを、すべて同時に読み始める。どれかが読めなくても、ほかは読む。
	 * ルーム、ユーザー、メンバー、ロールのポリシー (トークンに付けた userId ごと) と、identity のホスト
	 * (他のサーバーのユーザーの identity はその uri なので、そのホスト) のサーバーの記録を読む。
	 * DB に保存されたホストが identity のホストと違うユーザー (古い記録など) がいたときだけ、そのサーバーの記録を後から読み足す
	 */
	private async admissionContextOf(roomId: MiChatRoom['id'], participants: NamedCallParticipant[], refusedHosts: Map<string, boolean>): Promise<AdmissionContext> {
		const ids = [...new Set(participants.map(p => p.userId))];
		const identityHosts = [...new Set(participants.flatMap(p => this.remoteHostOfIdentity(p.identity) ?? []))].filter(host => !refusedHosts.has(host));
		const errors: unknown[] = [];
		const read = async <T>(load: () => Promise<T>): Promise<Read<T>> => {
			try {
				return { ok: true, value: await load() };
			} catch (error) {
				errors.push(error);
				return { ok: false, error };
			}
		};

		const [room, users, memberIds, policies] = await Promise.all([
			read(() => this.chatRoomsRepository.findOneBy({ id: roomId })),
			read(async () => new Map((await this.usersRepository.findBy({ id: In(ids) })).map(user => [user.id, user]))),
			read(async () => new Set((await this.chatRoomMembershipsRepository.findBy({ roomId, userId: In(ids) })).map(membership => membership.userId))),
			Promise.all(ids.map(async userId => [userId, await read(() => this.roleService.getUserPolicies(userId))] as const)),
			this.decideHosts(identityHosts, refusedHosts, errors),
		]);

		if (users.ok) {
			const storedHosts = [...new Set([...users.value.values()].flatMap(user => (user.host != null ? [user.host] : [])))];
			await this.decideHosts(storedHosts.filter(host => !refusedHosts.has(host) && !identityHosts.includes(host)), refusedHosts, errors);
		}

		return { room, users, memberIds, policies: new Map(policies), refusedHosts, errors };
	}

	/** hosts を断るか決め、決められたものを refusedHosts に残す。決められなかったホストのエラーは errors に残す */
	private async decideHosts(hosts: string[], refusedHosts: Map<string, boolean>, errors: unknown[]): Promise<void> {
		if (hosts.length === 0) return;
		for (const [host, refused] of await this.hostPolicyService.refusedRemoteHostsOrUnknown(hosts)) {
			if (refused == null) errors.push(new Error(`Could not read the records of ${host}`));
			else refusedHosts.set(host, refused);
		}
	}

	/** identity が他のサーバーのユーザーのもの (その uri) なら、そのホスト (host:port)。このサーバーのユーザーのものか、URL でなければ null */
	private remoteHostOfIdentity(identity: string): string | null {
		if (identity.startsWith(`${this.config.url}/users/`)) return null;
		try {
			const url = new URL(identity);
			return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : null;
		} catch {
			return null;
		}
	}

	/**
	 * 参加者が、いまもそのルームの通話に残れるか。入ったとき (participant_joined) と定期的な読み直し (sweep)、設定の変更や停止の後で確かめる。
	 * トークンを発行するとき (issueRemoteJoinToken、chat/rooms/voice/join) と同じものを確かめる。
	 * - トークンに付けたユーザー (メタデータの userId) がいて、停止も削除もされておらず、参加者の identity がそのユーザーのもの (LiveKitService.identityOf)
	 * - ルームがあって保管されておらず、そのユーザーが持ち主かメンバー
	 * - そのユーザーのロールが通話に入れ、チャットに書き込める
	 * - 他のサーバーのユーザーなら、そのサーバーを断っていない (HostPolicyService.isRefusedRemoteHost)。
	 *   identity のホストのサーバーを断っていれば、ユーザーを読めなくても残れない (identity はそのユーザーの uri でなければならないので)
	 * 読めたものだけで残れないと決まれば denied、読めなかったもののために決められなければ unverified
	 */
	private admissionOf(participant: NamedCallParticipant, context: AdmissionContext): Admission {
		let unverified = false;

		const identityHost = this.remoteHostOfIdentity(participant.identity);
		if (identityHost != null && context.refusedHosts.get(identityHost) === true) return 'denied';

		if (!context.room.ok) {
			unverified = true;
		} else {
			const room = context.room.value;
			if (room == null || room.isArchived) return 'denied';
			if (!context.memberIds.ok) unverified = true;
			else if (room.ownerId !== participant.userId && !context.memberIds.value.has(participant.userId)) return 'denied';
		}

		if (!context.users.ok) {
			unverified = true;
		} else {
			const user = context.users.value.get(participant.userId);
			if (user == null || user.isSuspended || user.isDeleted) return 'denied';
			if (user.host != null && user.uri == null) return 'denied';
			if (participant.identity !== this.liveKitService.identityOf(user)) return 'denied';
			if (user.host != null) {
				const refused = context.refusedHosts.get(user.host);
				if (refused === true) return 'denied';
				if (refused == null) unverified = true;
			}
		}

		const policies = context.policies.get(participant.userId);
		if (policies == null || !policies.ok) unverified = true;
		else if (!policies.value.canVoiceCall || policies.value.chatAvailability !== 'available') return 'denied';
		else if (!policies.value.canScreenShare && (participant.canScreenShare || participant.screenSharing)) return 'denied';

		return unverified ? 'unverified' : 'admitted';
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
	 * 他のサーバーへ送るのを待たせたルームについて、送るかを決め直す。
	 * このサーバーのメンバーには、その前の読み直し (refresh) が知らせてあるので知らせ直さない
	 */
	private async federateRoom(roomId: MiChatRoom['id']): Promise<void> {
		let target: { room: MiChatRoom; audience: RoomAudience } | null;
		try {
			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			target = room != null ? { room, audience: await this.audienceOf(room) } : null;
		} catch (err) {
			// 読めなければ待つのをやめる (次の webhook か定期的な読み直しで決め直す)
			this.federationBackoff.delete(roomId);
			throw err;
		}
		if (target == null) {
			this.federationBackoff.delete(roomId);
			return;
		}
		await this.federateChanges(target.room, target.audience);
	}

	/**
	 * 決められなかったルームを、待つたびに倍にした間隔 (REFRESH_DELAY_MS から FEDERATION_LOCK_RETRY_MAX_MS まで) の後に決め直す。
	 * 最初に失敗したときから FEDERATION_RETRY_LIMIT_MS を過ぎていれば、決め直さずに待つのをやめる。
	 * 配送を積めなかったときは、間隔の鍵が切れるまで待つ (delayMs)。LiveKit を読めただけでは失敗の時刻を消さない
	 */
	private retryFederationLater(roomId: MiChatRoom['id'], delayMs?: number): void {
		const now = Date.now();
		const backoff = this.federationBackoff.get(roomId) ?? { waits: 0, since: now };
		if (now - backoff.since > FEDERATION_RETRY_LIMIT_MS) {
			this.federationBackoff.delete(roomId);
			this.logger.warn(`Gave up sending the voice call in ${roomId} to other servers after failing for ${FEDERATION_RETRY_LIMIT_MS / 1000} seconds`);
			return;
		}
		this.federationBackoff.set(roomId, { waits: backoff.waits + 1, since: backoff.since });
		this.scheduleFollowUp(roomId, delayMs ?? Math.min(REFRESH_DELAY_MS * 2 ** backoff.waits, FEDERATION_LOCK_RETRY_MAX_MS));
	}

	/**
	 * 参加者の現況を他のサーバーのメンバーに届ける。他のサーバーのメンバーがいないルームでは何もしない (間隔の鍵も読み直しも使わない)。
	 * - 参加者のいる現況は、前に送ったものと同じで、送ってから FEDERATION_RESEND_INTERVAL_MS 経っていなければ送らない
	 * - 送るのはルームごとに FEDERATION_MIN_INTERVAL_MS に一度まで。送れなかった変化は、間隔が空いたときに読み直して最新の現況を送る
	 * - 通話が終わったこと (空の現況) は参加者の現況とは別に数えて待たずに送る。送る直前に記録を読み、同じ終わりを送ってあれば送らない
	 * 送った記録は、すべての届け先への配送を積めたときだけ残す。
	 * 送るかを決めてから記録を残すまでは、ルームごとに全ワーカーで一つずつ行う (順番の鍵、FEDERATION_LOCK_MS)。
	 * 決めるのに使う現況は、鍵を取ってから LiveKit を読み直したもの。鍵を取る前に読んだ現況は、その後でほかのワーカーが決めた現況より古いことがある。
	 * ほかのワーカーが鍵を持っているか、鍵を取った後に LiveKit を読めなければ、間隔を延ばしながら (FEDERATION_LOCK_RETRY_MAX_MS まで)
	 * 待って決め直す。最初に決められなかったときから FEDERATION_RETRY_LIMIT_MS を過ぎたら、決め直すのをやめる。
	 * 決める時刻は、前に決めた時刻とこのサーバーの現況の時刻より必ず後にする (ALLOCATE_STAMP_SCRIPT)。
	 * 鍵の寿命が切れていた (ほかのワーカーと同時に決めたかもしれない) か、記録を書けなかったときは、相手に届いた現況が分からないので、
	 * 記録を消して決め直す
	 */
	private async federateChanges(room: MiChatRoom, audience: RoomAudience): Promise<void> {
		if (audience.localOwner == null || audience.remoteInboxes.size === 0) {
			this.federationBackoff.delete(room.id);
			return;
		}

		const lockKey = `chatVoice:federateLock:${room.id}`;
		const token = randomUUID();
		let locked: boolean;
		try {
			locked = await this.redisClient.set(lockKey, token, 'PX', FEDERATION_LOCK_MS, 'NX') === 'OK';
		} catch (err) {
			// Redis が使えなければ待つのをやめる (次の webhook か定期的な読み直しで決め直す)
			this.federationBackoff.delete(room.id);
			throw err;
		}
		if (!locked) {
			this.retryFederationLater(room.id);
			return;
		}

		let superseded = false;
		try {
			superseded = !(await this.federateChangesInTurn(room, audience));
		} finally {
			// 鍵を外せなかったときは、寿命が切れていたかもしれないものとして扱う
			const released = await this.redisClient.eval(RELEASE_FEDERATION_LOCK_SCRIPT, 1, lockKey, token).catch(() => null);
			if (released !== 1 || superseded) {
				await this.redisClient.del(`chatVoice:federated:${room.id}`).catch(() => {});
				this.scheduleFollowUp(room.id, REFRESH_DELAY_MS);
			}
		}
	}

	/**
	 * federateChanges のうち、送る順番の鍵を取った後に行うもの。
	 * 決めたことが、ほかのワーカーの後の決定に追い越されていた (記録を書けなかった) ときは false を返す
	 */
	private async federateChangesInTurn(room: MiChatRoom, audience: RoomAudience): Promise<boolean> {
		// 決める現況の時刻を、読み始める前に決める。前に決めた時刻とこのサーバーの現況の時刻より必ず後になり (送らずに済ませるときも進める)、
		// 時計が遅れたワーカーも待たずに決められる。Redis が使えなければ待つのをやめる (次の webhook か定期的な読み直しで決め直す)
		const decidedKey = this.decidedKeyOf(room.id);
		let updatedAt: number;
		try {
			updatedAt = await this.allocateStamp(decidedKey, this.localStampKeyOf(room.id), FEDERATION_DECIDED_TTL_SECONDS);
		} catch (err) {
			this.federationBackoff.delete(room.id);
			throw err;
		}

		let listed: LiveKitParticipant[];
		try {
			listed = await this.liveKitService.listParticipants(room.id);
		} catch (err) {
			// 読み直し (refresh) がルームを通話中の一覧から外した後なら、定期的な読み直しはもうこのルームを見ない。間隔を延ばしながら決め直す
			this.retryFederationLater(room.id);
			throw err;
		}
		const participants = listed.map(p => ({ identity: p.identity, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) }));

		const hash = createHash('sha256')
			.update(JSON.stringify([...participants].sort((a, b) => a.identity.localeCompare(b.identity))))
			.digest('hex');
		const ended = participants.length === 0;

		const last = ended ? null : await this.lastFederatedOf(room.id);
		if (!ended && isStillFederated(last, hash)) {
			this.federationBackoff.delete(room.id);
			return true;
		}

		const gateKey = ended ? `chatVoice:federateEmptyGate:${room.id}` : `chatVoice:federateGate:${room.id}`;
		const opened = await this.redisClient.set(gateKey, '1', 'PX', FEDERATION_MIN_INTERVAL_MS, 'NX');
		if (opened !== 'OK') {
			// 相手に届いている現況と違うなら、間隔の鍵が切れた後に決め直す (決め直しはルームごとに一つにまとまる)。
			// 通話の終わりは記録によらず必ず決め直す。送るかどうかは、決め直したときに読む記録で決める
			if (ended || last?.hash !== hash) {
				const ttl = await this.redisClient.pttl(gateKey);
				// 鍵は寿命の時刻ちょうどにはまだ残っているので、それを過ぎてから決め直す
				this.scheduleFollowUp(room.id, ttl >= 0 ? Math.min(ttl, FEDERATION_MIN_INTERVAL_MS) + 1 : REFRESH_DELAY_MS);
			}
			return true;
		}

		// 通話の終わりは、送る直前に読んだ記録が同じ終わりなら送らない (相手には届いている)。
		// 送らないので間隔の鍵も外し、次に参加者が出入りした後の終わりを待たせない
		if (ended && isStillFederated(await this.lastFederatedOf(room.id), hash)) {
			this.federationBackoff.delete(room.id);
			await this.redisClient.del(gateKey);
			return true;
		}

		const recordKey = `chatVoice:federated:${room.id}`;
		try {
			const currentRoom = await this.chatRoomsRepository.findOneBy({ id: room.id });
			if (currentRoom == null) return true;
			await this.deliverSnapshot(currentRoom, await this.audienceOf(currentRoom), participants, updatedAt);
		} catch (err) {
			// 一部の届け先には積めたかもしれず、相手に届いている現況が分からない。記録を消して次の現況 (終わりを含む) を必ず送り、
			// 間隔の鍵が切れた後に決め直して送り直す。記録を消せなくても、記録は FEDERATION_RESEND_INTERVAL_MS で切れる
			await this.redisClient.del(recordKey).catch(() => {});
			this.retryFederationLater(room.id, FEDERATION_MIN_INTERVAL_MS + 1);
			throw err;
		}

		// 順番の鍵が寿命で切れて、ほかのワーカーが後の現況で決めたか記録していれば、書かずに決め直す
		const record: FederatedRecord = { hash, at: Date.now(), updatedAt };
		const recorded = await this.redisClient.eval(RECORD_FEDERATED_IF_NOT_OLDER_SCRIPT, 3, recordKey, decidedKey, `chatVoice:joinInvalidated:${room.id}`, JSON.stringify(record), updatedAt, FEDERATION_RESEND_INTERVAL_MS / 1000) === 1;
		if (recorded) this.federationBackoff.delete(room.id);
		return recorded;
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
	private async deliverSnapshot(room: MiChatRoom, audience: RoomAudience, participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean }[], updatedAt: number): Promise<void> {
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
			participants.push({ identity: p.identity, user, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) });
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

/** 記録 (last) が、同じ現況 (hash) を FEDERATION_RESEND_INTERVAL_MS のうちに送ったことを示すか */
function isStillFederated(last: FederatedRecord | null, hash: string): boolean {
	return last != null && last.hash === hash && Date.now() - last.at < FEDERATION_RESEND_INTERVAL_MS;
}
