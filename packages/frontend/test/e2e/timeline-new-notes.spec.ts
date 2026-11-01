/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test, expect } from './fixtures.js';
import { api } from './shared.js';
import {
	// const
	BASE_URL,
	// utils
	resetState, registerUser,
	// page utils
	signIn,
} from './utils.js';
import type { RegisteredUser } from './utils.js';
import type { Page, WebSocketRoute } from 'playwright';

const NEW_NOTES_INDICATOR = /There are \d+ new notes/;

async function scrollTimelineTo(page: Page, top: number): Promise<void> {
	await page.evaluate((top) => {
		let el = document.querySelector('[data-scroll-anchor]')?.parentElement ?? null;
		while (el != null && !(el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible')) {
			el = el.parentElement;
		}
		(el ?? document.scrollingElement!).scrollTo({ top });
	}, top);
}

// 初回ログイン時のセットアップダイアログはアカウントに保存された状態で出るかどうかが決まるので、最初から済ませておく
async function skipUserSetupDialog(user: RegisteredUser): Promise<void> {
	await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
}

// ログイン前の画面にも公開ノートが出るので、ホームタイムラインにだけ出るヒントで遷移後を待つ。
// ヒントが出ているとタイムラインの位置が下がって再現しない場合があるので、閉じておく
async function openHomeTimeline(page: Page, user: string, password: string): Promise<void> {
	await signIn(page, user, password);
	await page.getByRole('button', { name: 'Got it!' }).click();
	await page.getByText('seed note 20').waitFor();
}

async function timelineTexts(page: Page): Promise<string[]> {
	// 画面外のノートは content-visibility で描画が省略され innerText が空になるので textContent を使う
	return await page.locator('[data-scroll-anchor]').evaluateAll(els => els.map(el => el.textContent ?? ''));
}

/**
 * ストリーミングを中継し、ホームタイムラインのチャンネルへ任意のノートを流し込めるようにする
 */
async function routeStreaming(page: Page) {
	let socket: WebSocketRoute | null = null;
	let homeTimelineChannelId: string | null = null;

	await page.routeWebSocket(/\/streaming/, ws => {
		const server = ws.connectToServer();
		socket = ws;
		ws.onMessage(message => {
			const { type, body } = JSON.parse(message.toString());
			if (type === 'connect' && body.channel === 'homeTimeline') homeTimelineChannelId = body.id;
			server.send(message);
		});
	});

	return {
		async sendNote(note: unknown) {
			await expect.poll(() => socket != null && homeTimelineChannelId != null).toBe(true);
			socket!.send(JSON.stringify({ type: 'channel', body: { id: homeTimelineChannelId, type: 'note', body: note } }));
		},
	};
}

test.describe('Streaming timeline', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	let alice: RegisteredUser;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		await skipUserSetupDialog(alice);
		for (let i = 1; i <= 20; i++) {
			await api(BASE_URL, 'notes/create', { i: alice.token, text: `seed note ${i}` });
		}
	});

	test.beforeEach(async ({ page }) => {
		await openHomeTimeline(page, 'alice', 'alice1234');
	});

	// 新着ノートの通知が出ると .new2 の負の margin-top がタイムラインの外へ相殺され、
	// 先頭に戻っても isTop() が偽のままになりキューが解放されなかった
	test('releases queued notes when scrolled back to the top', async ({ page }) => {
		await scrollTimelineTo(page, 300);
		await page.waitForTimeout(500);

		await api(BASE_URL, 'notes/create', { i: alice.token, text: 'arrived while scrolled' });
		await expect(page.getByText(NEW_NOTES_INDICATOR)).toBeVisible();

		await scrollTimelineTo(page, 0);

		await expect(page.locator('[data-scroll-anchor]').first()).toContainText('arrived while scrolled');
		await expect(page.getByText(NEW_NOTES_INDICATOR)).toBeHidden();
	});
});

// リモートから遅れて届いたノートは、ID (投稿日時) が表示中の先頭より古いままストリーミングで流れてくる
test.describe('Streaming timeline with delayed notes', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	let alice: RegisteredUser;
	let bob: RegisteredUser;
	let delayedNoteId: string;
	let tooOldNoteId: string;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		await skipUserSetupDialog(alice);
		bob = await registerUser('bob', 'bob12345');
		tooOldNoteId = (await api(BASE_URL, 'notes/create', { i: bob.token, text: 'too old remote note' })).createdNote.id;
		for (let i = 1; i <= 10; i++) {
			await api(BASE_URL, 'notes/create', { i: alice.token, text: `seed note ${i}` });
		}
		delayedNoteId = (await api(BASE_URL, 'notes/create', { i: bob.token, text: 'delayed remote note' })).createdNote.id;
		for (let i = 11; i <= 20; i++) {
			await api(BASE_URL, 'notes/create', { i: alice.token, text: `seed note ${i}` });
		}
	});

	let streaming: Awaited<ReturnType<typeof routeStreaming>>;

	test.beforeEach(async ({ page }) => {
		streaming = await routeStreaming(page);
		await openHomeTimeline(page, 'alice', 'alice1234');
	});

	async function expectDelayedNoteInPlace(page: Page) {
		await expect.poll(async () => {
			const texts = await timelineTexts(page);
			const index = texts.findIndex(text => text.includes('delayed remote note'));
			return [texts[0]?.includes('seed note 20'), texts[index - 1]?.includes('seed note 11'), texts[index + 1]?.includes('seed note 10')];
		}).toEqual([true, true, true]);
	}

	test('inserts a delayed note at its position instead of the top', async ({ page }) => {
		await streaming.sendNote(await api(BASE_URL, 'notes/show', { i: alice.token, noteId: delayedNoteId }));

		await expectDelayedNoteInPlace(page);
	});

	test('inserts a queued delayed note at its position when scrolled back to the top', async ({ page }) => {
		await scrollTimelineTo(page, 300);
		await page.waitForTimeout(500);

		await streaming.sendNote(await api(BASE_URL, 'notes/show', { i: alice.token, noteId: delayedNoteId }));
		await expect(page.getByText(NEW_NOTES_INDICATOR)).toBeVisible();

		await scrollTimelineTo(page, 0);

		await expect(page.getByText(NEW_NOTES_INDICATOR)).toBeHidden();
		await expectDelayedNoteInPlace(page);
	});

	// 読み込み済みの最古より古いノートは、過去方向の読み込みで取得されるので差し込まない
	test('ignores a delayed note older than the loaded notes', async ({ page }) => {
		await streaming.sendNote(await api(BASE_URL, 'notes/show', { i: alice.token, noteId: tooOldNoteId }));
		// 後から送ったノートが反映されていれば、先に送ったノートも処理済み
		await streaming.sendNote(await api(BASE_URL, 'notes/show', { i: alice.token, noteId: delayedNoteId }));
		await expectDelayedNoteInPlace(page);

		const texts = await timelineTexts(page);
		expect(texts[0]).toContain('seed note 20');
		expect(texts.some(text => text.includes('too old remote note'))).toBe(false);
	});
});
