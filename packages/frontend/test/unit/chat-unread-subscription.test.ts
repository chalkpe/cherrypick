/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as Misskey from 'cherrypick-js';

// どの試験も新しいページで始めた状態から見る。モジュールの状態はページに一つなので、試験ごとに作り直す
async function boot(options: { realtimeMode?: boolean } = {}) {
	vi.resetModules();
	const tracker = await import('@/chat-unread-subscription.js');
	const streamHandlers = new Map<string, () => void>();
	const stream = {
		on: vi.fn((event: string, handler: () => void) => { streamHandlers.set(event, handler); }),
		useChannel: vi.fn(),
	};
	if (options.realtimeMode !== false) {
		tracker.initChatUnreadSubscription(stream as unknown as Misskey.IStream);
	}
	return {
		...tracker,
		stream,
		// ソケットが開いた合図。購読の完了とは別物
		connected: () => streamHandlers.get('_connected_')?.(),
		disconnected: () => streamHandlers.get('_disconnected_')?.(),
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

test('before boot registers the handler, events cannot be trusted', async () => {
	vi.resetModules();
	const tracker = await import('@/chat-unread-subscription.js');

	expect(tracker.chatUnreadEventsActive()).toBe(false);
	expect(tracker.chatUnreadSubscriptionGap()).toBe(true);
});

test('boot leaves a gap until a versioned event or a protected check', async () => {
	const t = await boot();

	expect(t.chatUnreadEventsActive()).toBe(true);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

// 共有メインチャンネルは購読の完了を知らせてこない。別のチャンネルを開いて確かめることもないので、
// 起動時にチャンネルを一つも開かない
test('boot does not open a channel to watch for a subscription ack', async () => {
	const t = await boot();

	expect(t.stream.useChannel).not.toHaveBeenCalled();
});

// ソケットが開いただけでは購読が済んでいない。そのあいだに出た知らせは届かないので、空白は残す
test('a bare connection without a state check keeps the boot gap', async () => {
	const t = await boot();

	t.connected();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

// 会話画面が一つも無いあいだに起きた切断は、そのあとに作られた画面には分からない。空白は画面の外で覚えておく
test('a disconnect before any conversation existed is not forgotten by the reconnect', async () => {
	const t = await boot();

	t.disconnected();
	t.connected();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('repeated reconnects without a state check keep the gap', async () => {
	const t = await boot();
	t.disconnected();

	t.connected();
	t.connected();
	t.connected();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('an applied versioned event resolves the gap', async () => {
	const t = await boot();
	t.disconnected();
	t.connected();

	t.resolveChatUnreadGap();

	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('after the gap was resolved, later reconnects do not ask again until a new disconnect', async () => {
	const t = await boot();
	t.disconnected();
	t.resolveChatUnreadGap();

	t.connected();
	t.connected();

	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('a new disconnect after the resolution opens a new gap', async () => {
	const t = await boot();
	t.disconnected();
	t.resolveChatUnreadGap();

	t.disconnected();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('realtime mode turned on after boot does not register the handler', async () => {
	const t = await boot({ realtimeMode: false });

	expect(t.chatUnreadEventsActive()).toBe(false);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

// 空白がすでに解消済みなら待つ必要がない (HTTP の完了よりイベントが先に届いた場合)
test('waiting when there is no gap resolves immediately', async () => {
	const t = await boot();
	t.resolveChatUnreadGap();

	await expect(t.waitChatUnreadGapResolved(5000)).resolves.toBe(true);
});

// すべて既読のあと待っているあいだにバージョン付きイベントが届くと空白が解消され、再問い合わせは不要になる
test('a versioned event arriving during the wait resolves it', async () => {
	const t = await boot();
	const waiting = t.waitChatUnreadGapResolved(5000);

	t.resolveChatUnreadGap();

	await expect(waiting).resolves.toBe(true);
	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('the wait times out while the gap remains', async () => {
	vi.useFakeTimers();
	const t = await boot();
	const waiting = t.waitChatUnreadGapResolved(5000);

	await vi.advanceTimersByTimeAsync(4999);
	let settled = false;
	void waiting.then(() => { settled = true; });
	await Promise.resolve();
	expect(settled).toBe(false);

	await vi.advanceTimersByTimeAsync(1);
	await expect(waiting).resolves.toBe(false);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('every pending wait wakes up when the gap resolves', async () => {
	const t = await boot();
	const first = t.waitChatUnreadGapResolved(5000);
	const second = t.waitChatUnreadGapResolved(5000);

	t.resolveChatUnreadGap();

	await expect(first).resolves.toBe(true);
	await expect(second).resolves.toBe(true);
});

// 遅れて届いたイベントは、すでに時間切れで終わった待ちを戻さない。新しい待ちは改めて機能する
test('a resolution after a timeout does not revive the expired wait', async () => {
	vi.useFakeTimers();
	const t = await boot();
	const expired = t.waitChatUnreadGapResolved(5000);
	await vi.advanceTimersByTimeAsync(5000);
	await expect(expired).resolves.toBe(false);

	t.resolveChatUnreadGap();
	const fresh = t.waitChatUnreadGapResolved(5000);
	await expect(fresh).resolves.toBe(true);
});

// 待ちのあいだに切断を挟んでも、そのあとに届いたバージョン付きイベントが状態を確定する
test('a disconnect during the wait still ends with the versioned event', async () => {
	const t = await boot();
	const waiting = t.waitChatUnreadGapResolved(5000);

	t.disconnected();
	t.connected();
	t.resolveChatUnreadGap();

	await expect(waiting).resolves.toBe(true);
	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});
