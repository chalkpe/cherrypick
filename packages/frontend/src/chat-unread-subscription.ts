/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Misskey from 'cherrypick-js';

// 既読になった知らせはメインチャンネルのバージョン付きイベントで届く。イベントを信じられるかは、
// 最後の状態確認のあとに購読の空白があったかで決まる。会話画面は作られては消えるが、
// 画面が一つも無いあいだに起きた空白は忘れてはいけないので、この状態はコンポーネントの外で持つ。

// 起動時にハンドラを登録したか。起動後にリアルタイムモードを有効にしても再読み込みを飛ばすとイベントは適用されないので、サーバーへの確認に戻る必要がある。
let listening = false;

// 起動時はアカウント取得と購読完了のあいだに空白がある。共有メインチャンネルは購読の完了を知らせてこないので、
// 接続が開いただけでは空白を解消できない。バージョン付きイベントの適用か保護付きの状態確認まで空白を残す。
let gap = true;

// 소켓의 현재 연결 상태. 부팅 직후에는 아직 연결 전이므로 false에서 시작한다.
// 연결 중에 발행한 확인과 단절 중에 발행한 확인은 공백에 대한 의미가 다르다.
let connected = false;

// 끊김 세대. 끊길 때마다 올라간다. 단절 중 재확인 중복 억제는 이 세대 안에서만 적용되고,
// 복구 뒤 첫 열기의 확인 의무는 세대가 바뀌어도 공백이 남아 있는 한 유지된다.
let episode = 0;

// 단절 중 재확인을 이미 발행한 세대. 같은 세대의 반복 열기는 중복 요청을 내지 않는다.
let disconnectedRecheckEpisode: number | null = null;

// 상태 확인의 세대. 버전 붙은 이벤트 적용이나 연결 중 보호 확인 발행 때마다 올라간다.
// 실패한 확인이 공백을 되돌릴지는 이 값이 그대로일 때만다. 그 사이 더 새로운 확인이 있었으면 되돌리지 않는다.
let confirmRevision = 0;

// 空白の解消を待つ読み手 (すべて既読など)。解消か時間切れで一度だけ起きる。
const gapResolvedWaiters = new Set<() => void>();

export function initChatUnreadSubscription(stream: Misskey.IStream): void {
	listening = true;
	stream.on('_connected_', () => {
		connected = true;
	});
	stream.on('_disconnected_', () => {
		connected = false;
		episode++;
		gap = true;
	});
}

export function chatUnreadEventsActive(): boolean {
	return listening;
}

export function chatUnreadSubscriptionGap(): boolean {
	return gap;
}

function resolveGap(): void {
	gap = false;
	for (const waiter of gapResolvedWaiters) waiter();
	gapResolvedWaiters.clear();
}

// 버전 붙은 이벤트를 적용했을 때 공백을 해소한다. 확인 세대도 올려, 진행 중인 확인의 실패 복원을 무효화한다.
export function resolveChatUnreadGap(): void {
	confirmRevision++;
	resolveGap();
}

// 보호된 재확인을 시작할 때 부른다. 연결 상태에 따라 공백 해소 여부와 실패 복원 토큰이 달라진다.
// - 연결 중(또는 실시간 끔): 공백을 해소하고 확인을 발행한다. 실패하면 반환된 토큰으로 공백을 되돌릴 수 있다.
// - 단절 중: 공백을 해소하지 않는다. 복구 뒤 첫 열기의 확인 의무가 남는다. 같은 세대에선 중복 발행을 억제한다.
//   모두읽음 폴백처럼 중복 억제를 건너뛰어야 하는 경로는 bypassDedup을 쓴다.
export function beginChatUnreadRecheck(opts?: { bypassDedup?: boolean }): { issue: boolean; failToken: number | null } {
	if (!listening || connected) {
		confirmRevision++;
		resolveGap();
		return { issue: true, failToken: confirmRevision };
	}
	if (!opts?.bypassDedup && disconnectedRecheckEpisode === episode) {
		return { issue: false, failToken: null };
	}
	disconnectedRecheckEpisode = episode;
	return { issue: true, failToken: null };
}

// 실패한 보호 확인이 공백을 되돌린다. 그 사이 더 새로운 이벤트/확인이 있었으면(세대가 올랐으면) 되돌리지 않는다.
// 단절 중 발행한 확인은 공백을 해소한 적이 없으므로 토큰이 null이고, 되돌릴 것도 없다.
export function restoreChatUnreadGapIfUnchanged(token: number | null): void {
	if (token != null && token === confirmRevision) {
		gap = true;
	}
}

// 空白が解消されるまで待つ。時間切れまでに解消されなければ false を返す。
// すべて既読のあとなど、サーバーが間もなく出すバージョン付きイベントを待つときに使う。
export function waitChatUnreadGapResolved(timeoutMs: number): Promise<boolean> {
	if (!gap) return Promise.resolve(true);
	return new Promise(resolve => {
		const timeout: { id: number | null } = { id: null };
		const waiter = () => {
			if (timeout.id != null) window.clearTimeout(timeout.id);
			resolve(true);
		};
		timeout.id = window.setTimeout(() => {
			gapResolvedWaiters.delete(waiter);
			resolve(false);
		}, timeoutMs);
		gapResolvedWaiters.add(waiter);
	});
}
