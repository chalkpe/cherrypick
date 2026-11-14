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

// 空白の解消を待つ読み手 (すべて既読など)。解消か時間切れで一度だけ起きる。
const gapResolvedWaiters = new Set<() => void>();

export function initChatUnreadSubscription(stream: Misskey.IStream): void {
	listening = true;
	stream.on('_disconnected_', () => {
		gap = true;
	});
}

export function chatUnreadEventsActive(): boolean {
	return listening;
}

export function chatUnreadSubscriptionGap(): boolean {
	return gap;
}

// バージョン付きイベントを適用したとき、保護付きのアカウント確認を発行したときに空白を解消する。
export function resolveChatUnreadGap(): void {
	gap = false;
	for (const waiter of gapResolvedWaiters) waiter();
	gapResolvedWaiters.clear();
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
