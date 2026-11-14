/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import type * as Misskey from 'cherrypick-js';

// どの試験も新しいページで始めた状態から見る。モジュールの状態はページに一つなので、試験ごとに作り直す
async function boot(options: { realtimeMode?: boolean } = {}) {
	vi.resetModules();
	const tracker = await import('@/chat-unread-subscription.js');
	const streamHandlers = new Map<string, () => void>();
	const channelHandlers = new Map<string, () => void>();
	const stream = {
		on: vi.fn((event: string, handler: () => void) => { streamHandlers.set(event, handler); }),
		useChannel: vi.fn(() => ({
			on: vi.fn((event: string, handler: () => void) => { channelHandlers.set(event, handler); }),
		})),
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
		// メインチャンネルの購読が済んだ合図
		subscribed: () => channelHandlers.get('_subscribed_')?.(),
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
});

test('before boot registers the handler, events cannot be trusted', async () => {
	vi.resetModules();
	const tracker = await import('@/chat-unread-subscription.js');

	expect(tracker.chatUnreadEventsActive()).toBe(false);
	expect(tracker.chatUnreadSubscriptionGap()).toBe(true);
});

test('boot leaves a gap until the main channel is subscribed', async () => {
	const t = await boot();

	expect(t.chatUnreadEventsActive()).toBe(true);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('boot watches the main channel for the subscription ack', async () => {
	const t = await boot();

	expect(t.stream.useChannel).toHaveBeenCalledWith('main');
});

test('the first main-channel subscription resolves the boot gap', async () => {
	const t = await boot();

	t.subscribed();

	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

// ソケットが開いただけでは購読が済んでいない。そのあいだに出た知らせは届かないので、空白は残す
test('a bare connection without the main subscription keeps the boot gap', async () => {
	const t = await boot();

	t.connected();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

// 会話画面が一つも無いあいだに起きた切断は、そのあとに作られた画面には分からない。空白は画面の外で覚えておく
test('a disconnect before any conversation existed is not forgotten by the reconnect', async () => {
	const t = await boot();
	t.subscribed();

	t.disconnected();
	t.subscribed();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('repeated reconnects without a state check keep the gap', async () => {
	const t = await boot();
	t.subscribed();
	t.disconnected();

	t.subscribed();
	t.subscribed();
	t.subscribed();

	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('an applied versioned event resolves the gap', async () => {
	const t = await boot();
	t.subscribed();
	t.disconnected();
	t.subscribed();

	t.resolveChatUnreadGap();

	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('after the gap was resolved, later subscriptions do not ask again', async () => {
	const t = await boot();
	t.subscribed();
	t.disconnected();
	t.subscribed();
	t.resolveChatUnreadGap();

	t.subscribed();
	t.subscribed();

	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('a new disconnect after the resolution opens a new gap', async () => {
	const t = await boot();
	t.subscribed();
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
