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
import type { Page } from 'playwright';

test.describe('Chat', () => {
	let alice: RegisteredUser;
	let bob: RegisteredUser;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		bob = await registerUser('bob', 'bob12345');
		for (const user of [alice, bob]) {
			await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
			await api(BASE_URL, 'i/update', { i: user.token, chatScope: 'everyone' });
		}
		for (let i = 1; i <= 60; i++) {
			const [from, to] = i % 2 ? [alice, bob] : [bob, alice];
			await api(BASE_URL, 'chat/messages/create-to-user', { i: from.token, toUserId: to.id, text: `message ${i}` });
		}
	});

	test.beforeEach(async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');
		// ログインが終わるとホームタイムラインのヒントが出るので、それまで次の画面へ移らない
		await page.getByRole('button', { name: 'Got it!' }).click();
	});

	test.describe('on a laptop', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		test('keeps the place when earlier messages load', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			// 最初に読み込まれるのは新しい 20 件で、続きの 30 件はボタンで読み込む
			const oldestLoaded = page.getByText('message 41', { exact: true });
			await oldestLoaded.waitFor();
			const more = page.getByRole('button', { name: 'Load more', exact: true });
			await more.scrollIntoViewIfNeeded();
			const before = (await oldestLoaded.boundingBox())!.y;

			await more.click();
			await page.getByText('message 11', { exact: true }).waitFor({ state: 'attached' });

			await expect.poll(async () => Math.abs((await oldestLoaded.boundingBox())!.y - before)).toBeLessThan(4);
		});
	});

	// 招待に応じる入口は 3 つある。どれも本物のサーバーに資格情報つきで届き、そのまま話せるところまで見る
	test.describe('invitations', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		let roomNumber = 0;

		async function roomInvitingAlice(): Promise<{ id: string; name: string; }> {
			const name = `invited room ${++roomNumber}`;
			const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name }) as { id: string };
			await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
			return { id: room.id, name };
		}

		async function expectAliceAndBobTalk(page: Page, roomId: string): Promise<void> {
			await page.waitForURL(`${BASE_URL}/chat/room/${roomId}`);
			// 完了の表示が閉じてルームのチャンネルがつながるまでは、送っても画面に届かない。届くようになるまで人が言い直すのと同じように送り直す
			let attempt = 0;
			let text = '';
			await expect(async () => {
				text = `hello from alice in ${roomId} (${++attempt})`;
				await page.getByPlaceholder('Enter message here').fill(text);
				await page.getByPlaceholder('Enter message here').press('Enter');
				await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 2000 });
			}).toPass({ timeout: 30_000 });

			const seen = await api(BASE_URL, 'chat/messages/room-timeline', { i: bob.token, roomId }) as { text: string }[];
			expect(seen.map(message => message.text)).toContain(text);

			const reply = `hello from bob in ${roomId}`;
			await api(BASE_URL, 'chat/messages/create-to-room', { i: bob.token, toRoomId: roomId, text: reply });
			await expect(page.getByText(reply, { exact: true })).toBeVisible();
		}

		test('can be accepted from the invitations tab', async ({ page }) => {
			const room = await roomInvitingAlice();
			await page.goto(`${BASE_URL}/chat`);
			await page.getByText('Invite', { exact: true }).first().click();
			await page.getByText(room.name, { exact: true }).first().waitFor();

			await page.locator('button:has(i.ti-plus)', { hasText: 'Join' }).click();

			await expectAliceAndBobTalk(page, room.id);
			// 通知の一覧は別の列とウィジェットにも出ている。どこにも応じたはずの招待のボタンを残さない
			await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);
		});

		test('can be accepted by opening the room', async ({ page }) => {
			const room = await roomInvitingAlice();
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);

			await page.getByTestId('modal-dialog-ok').click();

			await expectAliceAndBobTalk(page, room.id);
		});

		test('can be accepted from a notification, which then says so', async ({ page }) => {
			const room = await roomInvitingAlice();
			await page.goto(`${BASE_URL}/my/notifications`);

			await page.getByRole('button', { name: 'Join' }).first().click();

			await expect(page.getByText('Joined', { exact: true }).first()).toBeVisible();
			await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);
			await expectAliceAndBobTalk(page, room.id);
		});

		test('can be sent to a friend by picking them, and the friend who accepts can talk', async ({ page }) => {
			const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: 'room of alice' }) as { id: string };
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);

			await page.getByRole('button', { name: 'Invite Users' }).click();
			await page.getByText('Username', { exact: true }).waitFor();
			await page.keyboard.type('bob');
			await page.locator('button', { hasText: '@bob' }).click();
			await page.getByRole('button', { name: 'Done' }).click();

			await expect.poll(async () => {
				const sent = await api(BASE_URL, 'chat/rooms/invitations/outbox', { i: alice.token, roomId: room.id }) as { userId: string }[];
				return sent.map(invitation => invitation.userId);
			}).toEqual([bob.id]);

			await api(BASE_URL, 'chat/rooms/join', { i: bob.token, roomId: room.id });
			await expectAliceAndBobTalk(page, room.id);
		});
	});

	test.describe('in a narrow window', () => {
		test.use({ viewport: { width: 412, height: 915 } });

		test('opens the second level of a menu on screen', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat`);
			await page.locator('button:has(i.ti-plus)').first().click();
			await page.getByText('Room Chat', { exact: true }).click();

			await expect(page.getByText('Create Room', { exact: true })).toBeInViewport();
		});
	});
});
