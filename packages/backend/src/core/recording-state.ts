/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 参加者が報告した通話の設定。recording が無ければ設定だけの報告で、録音状態は変えない */
export type RecordingStatus = { micMuted: boolean; deafened: boolean; recording?: boolean };

// 通話から離れた参加者の録音状態を、読んだときの値のままのときだけ消す。
// 読み直しているあいだに同じ identity が新しいセッションで報告した状態は消さない。
// KEYS[1]: 状態の鍵。ARGV[1]: 読んだ値 (無ければ空文字)。消したら 1、変わっていれば 0
export const CLEAR_RECORDING_STATE_IF_CURRENT_SCRIPT = `-- CLEAR_RECORDING_STATE_IF_CURRENT
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;
