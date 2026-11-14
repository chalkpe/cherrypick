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

// 起動時はアカウント取得と購読完了のあいだに空白がある。
let gap = true;

// 一度切断を見たら、あとの接続だけでは空白を解消できない。
let disconnected = false;

export function initChatUnreadSubscription(stream: Misskey.IStream): void {
	listening = true;
	stream.on('_disconnected_', () => {
		disconnected = true;
		gap = true;
	});
	// 起動時の空白はメインチャンネルの購読が済んだときに解消する。接続が開いただけではまだ購読が済んでおらず、
	// そのあいだに出た知らせは届かないことがある。購読の完了はチャンネルの _subscribed_ で知る。
	const main = stream.useChannel('main');
	main.on('_subscribed_', () => {
		if (!disconnected) gap = false;
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
}
