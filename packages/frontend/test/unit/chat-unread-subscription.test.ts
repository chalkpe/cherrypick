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

// 연결 상태와 요청 결과의 구분: 단절 중 발행한 확인은 복구 뒤 첫 열기의 확인 의무를 없애지 않는다
test('a recheck issued while disconnected keeps the gap for the first open after reconnect', async () => {
	const t = await boot();
	t.disconnected();

	const whileDown = t.beginChatUnreadRecheck();
	expect(whileDown.issue).toBe(true);
	expect(whileDown.failToken).toBeNull();
	expect(t.chatUnreadSubscriptionGap()).toBe(true);

	t.connected();
	expect(t.chatUnreadSubscriptionGap()).toBe(true);

	const afterReconnect = t.beginChatUnreadRecheck();
	expect(afterReconnect.issue).toBe(true);
	expect(afterReconnect.failToken).not.toBeNull();
	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('repeated opens while disconnected suppress duplicate rechecks', async () => {
	const t = await boot();
	t.disconnected();

	expect(t.beginChatUnreadRecheck().issue).toBe(true);
	expect(t.beginChatUnreadRecheck().issue).toBe(false);
	expect(t.beginChatUnreadRecheck().issue).toBe(false);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('the check after reconnect is allowed even though one was issued while down', async () => {
	const t = await boot();
	t.disconnected();
	t.beginChatUnreadRecheck();
	t.connected();

	const after = t.beginChatUnreadRecheck();
	expect(after.issue).toBe(true);
	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('a new disconnect allows one more recheck while down', async () => {
	const t = await boot();
	t.disconnected();
	expect(t.beginChatUnreadRecheck().issue).toBe(true);
	expect(t.beginChatUnreadRecheck().issue).toBe(false);

	t.connected();
	t.disconnected();
	expect(t.beginChatUnreadRecheck().issue).toBe(true);
	expect(t.beginChatUnreadRecheck().issue).toBe(false);
});

// 모두읽음 폴백은 같은 세대에 열기 재확인이 이미 발행됐어도 건너뛰지 않는다
test('the read-all fallback bypasses the open dedup while disconnected', async () => {
	const t = await boot();
	t.disconnected();
	t.beginChatUnreadRecheck();
	expect(t.beginChatUnreadRecheck().issue).toBe(false);

	const fallback = t.beginChatUnreadRecheck({ bypassDedup: true });
	expect(fallback.issue).toBe(true);
	expect(fallback.failToken).toBeNull();
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('a failed recheck issued while connected restores the gap', async () => {
	const t = await boot();
	t.connected();
	const { failToken } = t.beginChatUnreadRecheck();
	expect(t.chatUnreadSubscriptionGap()).toBe(false);

	t.restoreChatUnreadGapIfUnchanged(failToken);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('a newer versioned event prevents a failed recheck from restoring the gap', async () => {
	const t = await boot();
	t.connected();
	const { failToken } = t.beginChatUnreadRecheck();

	t.resolveChatUnreadGap();
	t.restoreChatUnreadGapIfUnchanged(failToken);
	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('a newer protected check prevents an older failure from restoring the gap', async () => {
	const t = await boot();
	t.connected();
	const older = t.beginChatUnreadRecheck();
	const newer = t.beginChatUnreadRecheck();

	t.restoreChatUnreadGapIfUnchanged(older.failToken);
	expect(t.chatUnreadSubscriptionGap()).toBe(false);

	t.restoreChatUnreadGapIfUnchanged(newer.failToken);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('a failed recheck issued while disconnected leaves the gap as it was', async () => {
	const t = await boot();
	t.disconnected();
	const { failToken } = t.beginChatUnreadRecheck();
	expect(failToken).toBeNull();

	t.restoreChatUnreadGapIfUnchanged(failToken);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});

test('after a failed recheck restores the gap, the next open asks again', async () => {
	const t = await boot();
	t.connected();
	const first = t.beginChatUnreadRecheck();
	t.restoreChatUnreadGapIfUnchanged(first.failToken);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);

	const retry = t.beginChatUnreadRecheck();
	expect(retry.issue).toBe(true);
	expect(t.chatUnreadSubscriptionGap()).toBe(false);
});

test('with realtime mode off a recheck always issues and resolves the gap', async () => {
	const t = await boot({ realtimeMode: false });
	const first = t.beginChatUnreadRecheck();
	expect(first.issue).toBe(true);
	expect(first.failToken).not.toBeNull();
	expect(t.chatUnreadSubscriptionGap()).toBe(false);

	const second = t.beginChatUnreadRecheck();
	expect(second.issue).toBe(true);
});

// 부팅 직후 아직 연결 전이면, 그때 발행한 확인도 부팅 공백을 해소하지 못한다
test('a recheck issued before the first connection keeps the boot gap', async () => {
	const t = await boot();
	const beforeConnect = t.beginChatUnreadRecheck();
	expect(beforeConnect.issue).toBe(true);
	expect(beforeConnect.failToken).toBeNull();
	expect(t.chatUnreadSubscriptionGap()).toBe(true);

	t.connected();
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
	expect(t.beginChatUnreadRecheck().issue).toBe(true);
});

// 단절 중 재확인은 공백을 해소하지 않으므로, 모두읽음 대기는 끝내 시간 초과가 되어 폴백으로 이어진다
test('the read-all wait times out while disconnected even after a recheck was issued', async () => {
	vi.useFakeTimers();
	const t = await boot();
	t.disconnected();
	t.beginChatUnreadRecheck();
	const waiting = t.waitChatUnreadGapResolved(5000);

	await vi.advanceTimersByTimeAsync(5000);
	await expect(waiting).resolves.toBe(false);
	expect(t.chatUnreadSubscriptionGap()).toBe(true);
});
