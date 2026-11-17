/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 参加者が報告した通話の設定。recording が無ければ設定だけの報告で、録音状態は変えない */
export type RecordingStatus = { micMuted: boolean; deafened: boolean; recording?: boolean };

/** 参加者 (ルーム, identity) ごとの録音状態。報告を受け付けるたびに版が一つ進む */
export type RecordingState = { sessionId: string; recording: boolean; version: number };

// 録音状態を報告する。いまの版を読んで一つ進めた値を書き、参加者の一覧にも足す。
// 同じセッション・同じ値の再報告でも版が変わるので、後の整理が新しい報告と見分けられる。
// KEYS[1]: 状態の鍵、KEYS[2]: 一覧の鍵。ARGV: セッション ID、録音中 ('1'/'0')、identity、寿命 (秒)。書いた版を返す
export const STORE_RECORDING_STATE_SCRIPT = `-- STORE_RECORDING_STATE
local version = 0
local raw = redis.call('GET', KEYS[1])
if raw then
	local ok, state = pcall(cjson.decode, raw)
	if ok and type(state) == 'table' and type(state.version) == 'number' then
		version = state.version
	end
end
version = version + 1
redis.call('SET', KEYS[1], cjson.encode({ sessionId = ARGV[1], recording = ARGV[2] == '1', version = version }), 'EX', ARGV[4])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return version
`;

// 接続が続いている録音の寿命を延ばす。いまの値が同じセッションの録音中のときだけ延ばすので、
// 読み取ってから延ばすまでに届いた終了報告 (recording が false) や新しいセッションを昔の状態で上書きしない。
// KEYS[1]: 状態の鍵、KEYS[2]: 一覧の鍵。ARGV: 読み取ったセッション ID、寿命 (秒)。延ばしたら 1、変わっていなければ 0
export const RENEW_RECORDING_STATE_IF_CURRENT_SCRIPT = `-- RENEW_RECORDING_STATE_IF_CURRENT
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, state = pcall(cjson.decode, raw)
if not ok or type(state) ~= 'table' then return 0 end
if state.sessionId ~= ARGV[1] or state.recording ~= true then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

// 通話から離れた参加者の録音状態を、参加者一覧を読む前に読んだときの値のままのときだけ消す。
// 一覧の後に届いた報告 (新しいセッション・同じ値の再報告) は版が違うので消さない。
// 消すときは一覧からも同じ操作で外すので、間に届いた新しい報告の追跡を失わない。
// KEYS[1]: 状態の鍵、KEYS[2]: 一覧の鍵。ARGV[1]: 読んだ値 (無ければ空文字)、ARGV[2]: identity。消したら 1、変わっていれば 0
export const CLEAR_RECORDING_STATE_IF_CURRENT_SCRIPT = `-- CLEAR_RECORDING_STATE_IF_CURRENT
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`;
