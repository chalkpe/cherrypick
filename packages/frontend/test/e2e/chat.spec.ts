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

		test('a mouse still selects by dragging, and a right click keeps the menu of the browser on a selection', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const message = page.getByText('message 60', { exact: true });
			await expect(message).toBeVisible();
			const box = await message.boundingBox();
			if (box == null) throw new Error('the message has no box');
			const y = box.y + box.height / 2;
			const menu = page.getByText('Copy contents', { exact: true });

			await page.mouse.move(box.x + 1, y);
			await page.mouse.down();
			await page.mouse.move(box.x + box.width - 1, y, { steps: 8 });
			await page.mouse.up();
			expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('message');

			await page.mouse.click(box.x + box.width / 2, y, { button: 'right' });
			await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 300)));
			await expect(menu).toHaveCount(0);
			expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('message');

			await page.evaluate(() => window.getSelection()?.removeAllRanges());
			await page.mouse.click(box.x + box.width / 2, y, { button: 'right' });
			await expect(menu).toBeVisible();
		});

		test('keeps the place when earlier messages load', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			// 最初に読み込まれるのは新しい 20 件で、続きの 30 件はボタンで読み込む
			const oldestLoaded = page.getByText('message 41', { exact: true });
			await oldestLoaded.waitFor();
			// 横の通知ウィジェットにも、読み込みの途中で同じ名前のボタンが出ることがある
			const more = page.getByLabel('Messages').getByRole('button', { name: 'Load more', exact: true });
			await more.scrollIntoViewIfNeeded();
			const before = (await oldestLoaded.boundingBox())!.y;

			await more.click();
			await page.getByText('message 11', { exact: true }).waitFor({ state: 'attached' });

			await expect.poll(async () => Math.abs((await oldestLoaded.boundingBox())!.y - before)).toBeLessThan(4);
		});

		// 新しいメッセージを増やすので、最初に読み込まれる範囲を数える上のテストより後に置く
		test('the send button works from the keyboard and keeps the focus it was given', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const input = page.getByPlaceholder('Enter message here');
			const send = page.locator('button:has(i.ti-send)');
			const text = `sent from the keyboard ${Date.now()}`;
			await input.fill(text);
			await send.focus();

			await page.keyboard.press('Enter');

			await expect(page.getByText(text, { exact: true })).toBeVisible();
			await expect(send).toBeFocused();
			await expect(input).toHaveValue('');
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
			const text = `hello from alice in ${roomId}`;
			const input = page.getByPlaceholder('Enter message here');
			// 完了の表示が閉じるのを待つ。閉じるまでは入力欄を押せない
			await input.click();
			await input.fill(text);
			await input.press('Enter');
			await expect(page.getByText(text, { exact: true })).toBeVisible();

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

	test.describe('an empty room', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		const INVITE_PROMPT = 'Invite users to start chatting';

		async function inviteBobFromTheRoom(page: Page): Promise<string> {
			const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: `empty room ${Date.now()}` }) as { id: string };
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);
			await expect(page.getByText(INVITE_PROMPT, { exact: true })).toBeVisible();

			await page.getByRole('button', { name: 'Invite Users' }).click();
			await page.getByText('Username', { exact: true }).waitFor();
			await page.keyboard.type('bob');
			await page.locator('button', { hasText: '@bob' }).click();
			await page.getByRole('button', { name: 'Done' }).click();
			return room.id;
		}

		test('tells its owner who was invited, and follows the answer as it comes', async ({ page }) => {
			const roomId = await inviteBobFromTheRoom(page);

			const waiting = page.getByText(/^Invited 1\./);
			await expect(waiting).toBeVisible();
			await expect(page.getByText(INVITE_PROMPT, { exact: true })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Invite Users' })).toBeVisible();

			await api(BASE_URL, 'chat/rooms/join', { i: bob.token, roomId });

			const joined = page.getByText(/^1 joined/);
			await expect(joined).toBeVisible();
			await expect(waiting).toHaveCount(0);
			await expect(page.getByText(INVITE_PROMPT, { exact: true })).toHaveCount(0);

			await page.reload();
			await expect(joined).toBeVisible();
			await expect(waiting).toHaveCount(0);

			await page.getByRole('button', { name: 'View members' }).click();
			await expect(page.getByText('@bob').first()).toBeVisible();
		});

		test('says so again after opening it anew, and asks again once the invitation is turned down', async ({ page }) => {
			const roomId = await inviteBobFromTheRoom(page);
			const waiting = page.getByText(/^Invited 1\./);
			await expect(waiting).toBeVisible();

			await page.reload();
			await expect(waiting).toBeVisible();

			await api(BASE_URL, 'chat/rooms/invitations/reject', { i: bob.token, roomId });

			await expect(page.getByText(INVITE_PROMPT, { exact: true })).toBeVisible();
			await expect(waiting).toHaveCount(0);
		});

		test('does not ask a member to invite anyone', async ({ page }) => {
			const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `room of bob ${Date.now()}` }) as { id: string };
			await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
			await api(BASE_URL, 'chat/rooms/join', { i: alice.token, roomId: room.id });

			await page.goto(`${BASE_URL}/chat/room/${room.id}`);

			await expect(page.getByText('No messages yet', { exact: true })).toBeVisible();
			await expect(page.getByText(INVITE_PROMPT, { exact: true })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Invite Users' })).toHaveCount(0);
		});
	});

	test.describe('a conversation that has just opened', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		type Frame = { type: string; body?: { id?: string; channel?: string; type?: string } };

		async function conversationWithBob(kind: 'room' | 'user'): Promise<{ path: string; send: (text: string) => Promise<unknown> }> {
			if (kind === 'user') {
				return {
					path: `/chat/user/${bob.id}`,
					send: text => api(BASE_URL, 'chat/messages/create-to-user', { i: bob.token, toUserId: alice.id, text }),
				};
			}
			const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `talk with bob ${Date.now()}` }) as { id: string };
			await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
			await api(BASE_URL, 'chat/rooms/join', { i: alice.token, roomId: room.id });
			return {
				path: `/chat/room/${room.id}`,
				send: text => api(BASE_URL, 'chat/messages/create-to-room', { i: bob.token, toRoomId: room.id, text }),
			};
		}

		// 開いている画面の中から移る。ページを読み込み直すとストリームがつながるのを待つことになり、この隙間が隠れる
		async function openFromTheList(page: Page, path: string): Promise<void> {
			await page.goto(`${BASE_URL}/chat`);
			await page.locator(`a[href$="${path}"]`).first().click();
		}

		for (const kind of ['room', 'user'] as const) {
			test(`${kind}: shows what arrives before its channel is connected, once and in order`, async ({ page }) => {
				const conversation = await conversationWithBob(kind);
				const opening = `opening ${kind} ${Date.now()}`;
				await conversation.send(opening);

				// サーバーがチャンネルを購読する前に届く順番を確実に作る。サーバーは本物で、遅らせるのは接続の要求だけ
				let release = () => {};
				const held = new Promise<void>(resolve => { release = resolve; });
				await page.routeWebSocket(/\/streaming/, ws => {
					const server = ws.connectToServer();
					ws.onMessage(async message => {
						const frame = JSON.parse(String(message)) as Frame;
						if (frame.type === 'connect' && frame.body?.channel?.startsWith('chat')) await held;
						server.send(message);
					});
					server.onMessage(message => ws.send(message));
				});

				await openFromTheList(page, conversation.path);
				await expect(page.getByText(opening, { exact: true })).toBeVisible();

				const during = `while connecting ${kind} ${Date.now()}`;
				await conversation.send(during);
				release();
				await expect(page.getByText(during, { exact: true })).toHaveCount(1);

				const after = `after connecting ${kind} ${Date.now()}`;
				await conversation.send(after);
				await expect(page.getByText(after, { exact: true })).toHaveCount(1);
				await expect(page.getByText(during, { exact: true })).toHaveCount(1);

				const tops = await Promise.all([opening, during, after].map(async text => (await page.getByText(text, { exact: true }).boundingBox())?.y ?? 0));
				expect(tops).toEqual(tops.toSorted((a, b) => a - b));
			});
		}

		test('does not repeat a message that both the read and the channel bring', async ({ page }) => {
			const conversation = await conversationWithBob('room');
			const opening = `opening both ${Date.now()}`;
			await conversation.send(opening);

			// チャンネルがつながったという知らせと新しいメッセージの両方を止める。先に読み直させてから、同じメッセージをチャンネルからも届ける
			let channelId: string | undefined;
			let releaseConnected = () => {};
			const connectedHeld = new Promise<void>(resolve => { releaseConnected = resolve; });
			let connectedArrived = () => {};
			const connectedSeen = new Promise<void>(resolve => { connectedArrived = resolve; });
			let messageArrived = (_frame: string) => {};
			const messageSeen = new Promise<string>(resolve => { messageArrived = resolve; });
			let forwardToPage = (_frame: string) => {};
			await page.routeWebSocket(/\/streaming/, ws => {
				const server = ws.connectToServer();
				forwardToPage = frame => ws.send(frame);
				ws.onMessage(message => {
					const frame = JSON.parse(String(message)) as Frame;
					if (frame.type === 'connect' && frame.body?.channel === 'chatRoom') channelId = frame.body.id;
					server.send(message);
				});
				server.onMessage(async message => {
					const frame = JSON.parse(String(message)) as Frame;
					if (frame.type === 'connected' && frame.body?.id === channelId) {
						connectedArrived();
						await connectedHeld;
					} else if (frame.type === 'channel' && frame.body?.id === channelId && frame.body?.type === 'message') {
						messageArrived(String(message));
						return;
					}
					ws.send(message);
				});
			});

			await openFromTheList(page, conversation.path);
			await expect(page.getByText(opening, { exact: true })).toBeVisible();
			await connectedSeen;

			const both = `both ways ${Date.now()}`;
			await conversation.send(both);
			const frame = await messageSeen;

			const read = page.waitForResponse(response => response.url().endsWith('/api/chat/messages/room-timeline'));
			releaseConnected();
			await read;
			await expect(page.getByText(both, { exact: true })).toHaveCount(1);

			forwardToPage(frame);
			await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 200)));
			await expect(page.getByText(both, { exact: true })).toHaveCount(1);
		});
	});

	test.describe('who invited', () => {
		for (const [where, viewport] of [['beside the other columns', { width: 1366, height: 768 }], ['on a narrow phone', { width: 360, height: 740 }]] as const) {
			test.describe(where, () => {
				test.use({ viewport });

				test('a notification names them, and a long name stays inside it', async ({ page }) => {
					const longName = 'AVeryLongNameWithoutAnySpaceInItThatGoesOnAndOnAnd';
					await api(BASE_URL, 'i/update', { i: bob.token, name: longName });
					try {
						const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `named inviter ${Date.now()}` }) as { id: string };
						await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
						await page.goto(`${BASE_URL}/my/notifications`);

						const line = page.getByText('Invited by').first();
						await expect(line).toContainText(longName);
						await expect(line).toContainText('@bob');

						const fits = await line.evaluate(element => {
							const box = element.getBoundingClientRect();
							const card = element.parentElement!.getBoundingClientRect();
							return box.right <= card.right + 1 && window.document.documentElement.scrollWidth <= window.innerWidth + 1;
						});
						expect(fits).toBe(true);
					} finally {
						await api(BASE_URL, 'i/update', { i: bob.token, name: null });
					}
				});
			});
		}
	});

	test.describe('inviting several people', () => {
		let carol: RegisteredUser;

		test.beforeAll(async () => {
			carol = await registerUser('carol', 'carol1234');
			await api(BASE_URL, 'i/registry/set', { i: carol.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
			await api(BASE_URL, 'i/update', { i: carol.token, chatScope: 'everyone' });
		});

		async function openInviteWindow(page: Page, name: string): Promise<string> {
			const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: `${name} ${Date.now()}` }) as { id: string };
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);
			await page.getByRole('button', { name: 'Invite Users' }).click();
			await page.getByText('Username', { exact: true }).waitFor();
			return room.id;
		}

		async function search(page: Page, username: string) {
			await page.getByText('Username', { exact: true }).click();
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.type(username);
		}

		const row = (page: Page, username: string) => page.locator('button', { hasText: `@${username}` });
		const picked = (page: Page) => page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Remove .* from selection$/ }) });

		async function outbox(roomId: string) {
			const sent = await api(BASE_URL, 'chat/rooms/invitations/outbox', { i: alice.token, roomId }) as { userId: string }[];
			return sent.map(invitation => invitation.userId).toSorted();
		}

		test.describe('on a laptop', () => {
			test.use({ viewport: { width: 1280, height: 720 } });

			test('keeps who was picked while searching for the next, and invites them all', async ({ page }) => {
				const roomId = await openInviteWindow(page, 'two friends');

				await search(page, 'bob');
				await row(page, 'bob').click();
				await search(page, 'carol');
				await row(page, 'carol').click();

				await expect(picked(page)).toHaveCount(2);
				await expect(picked(page).filter({ hasText: '@bob' })).toBeVisible();
				await expect(picked(page).filter({ hasText: '@carol' })).toBeVisible();

				await page.getByRole('button', { name: 'Done' }).click();

				await expect.poll(() => outbox(roomId)).toEqual([bob.id, carol.id].toSorted());
				// 空のルームの案内も、開いたままのメンバータブも読み直さなくても合っている
				await expect(page.getByText(/^Invited 2\./)).toBeVisible();
				await page.getByRole('button', { name: 'View members' }).click();
				await expect(page.getByText('@bob').first()).toBeVisible();
				await expect(page.getByText('@carol').first()).toBeVisible();
			});

			test('someone can be dropped again before the invitations go out', async ({ page }) => {
				const roomId = await openInviteWindow(page, 'changed my mind');

				await search(page, 'bob');
				await row(page, 'bob').click();
				await search(page, 'carol');
				await row(page, 'carol').click();
				await page.getByRole('button', { name: /^Remove .* from selection$/ }).first().click();
				await expect(picked(page)).toHaveCount(1);

				await page.getByRole('button', { name: 'Done' }).click();

				await expect.poll(() => outbox(roomId)).toEqual([carol.id]);
			});

			test('does not offer someone who is already invited or already a member, and says why', async ({ page }) => {
				const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: `already ${Date.now()}` }) as { id: string };
				await api(BASE_URL, 'chat/rooms/invitations/create', { i: alice.token, roomId: room.id, userId: bob.id });
				await api(BASE_URL, 'chat/rooms/invitations/create', { i: alice.token, roomId: room.id, userId: carol.id });
				await api(BASE_URL, 'chat/rooms/join', { i: carol.token, roomId: room.id });
				await page.goto(`${BASE_URL}/chat/room/${room.id}`);
				await page.getByRole('button', { name: 'Invite Users' }).click();
				await page.getByText('Username', { exact: true }).waitFor();

				await search(page, 'bob');
				await expect(row(page, 'bob')).toContainText('already been invited');
				// aria-disabled の行は Playwright が押せるようになるまで待ち続ける。利用者は押せるので、そのまま押す
				await row(page, 'bob').click({ force: true });
				await search(page, 'carol');
				await expect(row(page, 'carol')).toContainText('already a member');
				await row(page, 'carol').click({ force: true });

				await expect(picked(page)).toHaveCount(0);
				await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
			});

			test('when one invitation fails, says who and why, and keeps the other', async ({ page }) => {
				const roomId = await openInviteWindow(page, 'one fails');

				await search(page, 'bob');
				await row(page, 'bob').click();
				await search(page, 'carol');
				await row(page, 'carol').click();
				// 窓を開いたあとで招待されたので、窓では止められない
				await api(BASE_URL, 'chat/rooms/invitations/create', { i: alice.token, roomId, userId: bob.id });
				await page.getByRole('button', { name: 'Done' }).click();

				await expect(page.getByText('Could not invite 1')).toBeVisible();
				await expect(page.getByText(/Invited 1\..*@bob.*already been invited/)).toBeVisible();
				await expect.poll(() => outbox(roomId)).toEqual([bob.id, carol.id].toSorted());
			});

			test('while the search is on its way, keeps the last results and does not say nobody', async ({ page }) => {
				await openInviteWindow(page, 'slow search');
				let release = () => {};
				const held = new Promise<void>(resolve => { release = resolve; });

				await search(page, 'bob');
				await row(page, 'bob').click();
				await page.route('**/api/users/search-by-username-and-host', async route => {
					await held;
					await route.fallback();
				});

				await search(page, 'nobodyhere');

				await expect(row(page, 'bob')).toBeVisible();
				await expect(page.getByText('No users', { exact: false })).toHaveCount(0);

				release();
				await expect(row(page, 'bob')).toHaveCount(0);
				await expect(page.getByText(/No users|not found/i).first()).toBeVisible();
			});

			test('at the limit of invitations, says so in the language of the screen and stops asking', async ({ page }) => {
				const roomId = await openInviteWindow(page, 'limit');
				let asked = 0;
				await page.route('**/api/chat/rooms/invitations/create', route => {
					asked++;
					return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Rate limit exceeded. Please try again later.', code: 'RATE_LIMIT_EXCEEDED', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef' } }) });
				});

				await search(page, 'bob');
				await row(page, 'bob').click();
				await search(page, 'carol');
				await row(page, 'carol').click();
				await page.getByRole('button', { name: 'Done' }).click();

				await expect(page.getByText('Could not invite 2')).toBeVisible();
				await expect(page.getByText(/exceeding the execution limit/)).toBeVisible();
				await expect(page.getByText('Rate limit exceeded')).toHaveCount(0);
				expect(asked).toBe(1);
				await expect.poll(() => outbox(roomId)).toEqual([]);
			});
		});

		for (const width of [412, 360]) {
			test.describe(`at a width of ${width}`, () => {
				test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

				test('people with long names stay inside the window, and the page does not scroll sideways', async ({ page }) => {
					await api(BASE_URL, 'i/update', { i: carol.token, name: 'c'.repeat(50) });
					await openInviteWindow(page, 'long names');

					await search(page, 'bob');
					await row(page, 'bob').tap();
					await search(page, 'carol');
					await row(page, 'carol').tap();
					await expect(picked(page)).toHaveCount(2);

					const overflow = await page.evaluate(() => window.document.documentElement.scrollWidth - window.innerWidth);
					expect(overflow).toBeLessThanOrEqual(0);
					for (const person of await picked(page).all()) {
						const box = await person.boundingBox();
						if (box == null) throw new Error('the person has no box');
						expect(box.x).toBeGreaterThanOrEqual(0);
						expect(box.x + box.width).toBeLessThanOrEqual(width);
					}
					await expect(page.getByRole('button', { name: /^Remove .* from selection$/ }).nth(1)).toBeInViewport();
					await api(BASE_URL, 'i/update', { i: carol.token, name: null });
				});
			});
		}
	});

	test.describe('the window of files to upload', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		test('counts a file added from inside the window in its title', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const png = { name: 'one.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') };

			await page.getByRole('button', { name: 'Select a file' }).click();
			const first = page.waitForEvent('filechooser');
			await page.getByText('Upload', { exact: true }).click();
			await (await first).setFiles(png);
			await expect(page.getByText('Upload 1 files', { exact: true })).toBeVisible();

			const second = page.waitForEvent('filechooser');
			await page.locator('button:has(.ti-plus):visible').last().click();
			await (await second).setFiles({ ...png, name: 'two.png' });

			await expect(page.getByText('Upload 2 files', { exact: true })).toBeVisible();
		});
	});

	test.describe('the person picked for an invitation', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		for (const colorScheme of ['light', 'dark'] as const) {
			test(`can be read on the accent color in the ${colorScheme} theme`, async ({ page }) => {
				await page.emulateMedia({ colorScheme });
				const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: `picking ${colorScheme} ${Date.now()}` }) as { id: string };
				await page.goto(`${BASE_URL}/chat/room/${room.id}`);
				await page.getByRole('button', { name: 'Invite Users' }).click();
				await page.getByText('Username', { exact: true }).waitFor();
				await page.keyboard.type('bob');
				const row = page.locator('button', { hasText: '@bob' });
				await row.click();

				const shown = await row.evaluate(element => {
					const probe = window.document.createElement('i');
					probe.style.color = 'var(--MI_THEME-fgOnAccent)';
					window.document.body.append(probe);
					const fgOnAccent = window.getComputedStyle(probe).color;
					probe.remove();
					const opacityOf = (from: Element) => {
						let opacity = 1;
						for (let e: Element | null = from; e != null && e !== element; e = e.parentElement) opacity *= Number(window.getComputedStyle(e).opacity);
						return opacity;
					};
					const account = [...element.querySelectorAll('span')].filter(span => span.children.length === 0 && span.textContent?.startsWith('@'));
					return { color: window.getComputedStyle(element).color, fgOnAccent, opacities: account.map(opacityOf) };
				});

				expect(shown.color).toBe(shown.fgOnAccent);
				expect(shown.opacities.length).toBeGreaterThan(0);
				expect(shown.opacities.every(opacity => opacity === 1)).toBe(true);
			});
		}
	});

	// スマートフォンのキーボードは打った文字をほとんど常に変換中のままにする。insertText では変換が起きないので、変換を直接作る
	for (const [where, options] of [
		['on a laptop', { viewport: { width: 1280, height: 720 } }],
		['on an Android phone', {
			viewport: { width: 412, height: 915 },
			isMobile: true,
			hasTouch: true,
			userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
		}],
	] as const) {
		test.describe(`letters still in composition ${where}`, () => {
			test.use(options);

			test('go out with one press of send, once, and the box starts anew', async ({ page, context }) => {
				const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: `composing ${Date.now()}` }) as { id: string };
				await page.goto(`${BASE_URL}/chat/room/${room.id}`);
				const input = page.getByPlaceholder('Enter message here');
				const send = page.locator('button:has(i.ti-send)');
				await input.click();
				const cdp = await context.newCDPSession(page);
				const compose = (text: string) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
				const pressSend = async () => {
					const box = await send.boundingBox();
					if (box == null) throw new Error('the button has no box');
					const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
					if (where === 'on a laptop') await page.mouse.click(x, y);
					else await page.touchscreen.tap(x, y);
				};
				const sentTexts = async () => (await api(BASE_URL, 'chat/messages/room-timeline', { i: alice.token, roomId: room.id }) as { text: string }[]).map(message => message.text);

				const word = `Dk${where.length}`;
				await compose('D');
				await compose(word);
				await expect(input).toHaveValue(word);
				await expect(send).toHaveAttribute('aria-disabled', 'false');

				await pressSend();

				await expect(page.getByText(word, { exact: true })).toBeVisible();
				await expect(input).toHaveValue('');
				await expect(input).toBeFocused();
				expect(await sentTexts()).toEqual([word]);

				// 変換が終わっているので、次の文字は前の文字につながらない
				await compose('s');
				await expect(input).toHaveValue('s');
				await compose('');
				await expect(input).toHaveValue('');

				// 韓国語は最後の音節が変換中のまま残る
				await cdp.send('Input.insertText', { text: '안녕' });
				await compose('ㅎ');
				await compose('하');
				await expect(input).toHaveValue('안녕하');
				await pressSend();

				await expect(page.getByText('안녕하', { exact: true })).toBeVisible();
				await expect(input).toHaveValue('');
				expect(await sentTexts()).toEqual(['안녕하', word]);
			});
		});
	}

	// 画面キーボードは試験で出せないので、スクロールアンカーの効き方と、読んでいる場所が動かないことを確かめる
	for (const [where, options] of [
		['on a laptop', { viewport: { width: 1280, height: 720 } }],
		['on an Android phone', {
			viewport: { width: 412, height: 915 },
			isMobile: true,
			hasTouch: true,
			userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
		}],
	] as const) {
		test.describe(`reading a room ${where}`, () => {
			test.use(options);

			const overflowAnchors = (page: Page) => page.evaluate(() => ({
				html: window.getComputedStyle(window.document.documentElement).overflowAnchor,
				body: window.getComputedStyle(window.document.body).overflowAnchor,
				messages: window.getComputedStyle(window.document.querySelector('._pageScrollableReversed') ?? window.document.body).overflowAnchor,
			}));

			async function roomWithMessages(page: Page): Promise<{ id: string; say: (text: string) => Promise<unknown>; first: string }> {
				const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `long talk ${Date.now()}` }) as { id: string };
				await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
				await api(BASE_URL, 'chat/rooms/join', { i: alice.token, roomId: room.id });
				const say = (text: string) => api(BASE_URL, 'chat/messages/create-to-room', { i: bob.token, toRoomId: room.id, text });
				for (let i = 1; i <= 25; i++) await say(`line ${i} of ${room.id}`);
				await page.goto(`${BASE_URL}/chat/room/${room.id}`);
				const first = `line 25 of ${room.id}`;
				await expect(page.getByText(first, { exact: true })).toBeVisible();
				return { id: room.id, say, first };
			}

			const scrollMessagesTo = (page: Page, top: number) => page.evaluate(value => {
				window.document.querySelector('._pageScrollableReversed')?.scrollTo({ top: value, behavior: 'instant' });
			}, top);

			test('turns off scroll anchoring for the page only while the conversation is on screen', async ({ page }) => {
				const room = await roomWithMessages(page);

				// メッセージの欄では切らない。切ると、読み返しているあいだに届いた分だけ読んでいた場所がずれる
				expect(await overflowAnchors(page)).toEqual({ html: 'none', body: 'none', messages: 'auto' });

				await page.goto(`${BASE_URL}/chat`);
				await page.locator(`a[href$="/chat/room/${room.id}"]`).first().waitFor();
				expect(await overflowAnchors(page)).toMatchObject({ html: 'auto', body: 'auto' });
			});

			test('keeps the place of someone reading further up when a message comes, and follows at the bottom', async ({ page }) => {
				const room = await roomWithMessages(page);
				await scrollMessagesTo(page, -300);
				const reading = page.getByText(`line 15 of ${room.id}`, { exact: true });
				await reading.scrollIntoViewIfNeeded();
				const before = (await reading.boundingBox())!.y;

				const whileReading = `while reading ${room.id}`;
				await room.say(whileReading);
				await page.getByText(whileReading, { exact: true }).waitFor({ state: 'attached' });
				await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 300)));
				expect(Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(2);

				await scrollMessagesTo(page, 0);
				const atTheBottom = `at the bottom ${room.id}`;
				await room.say(atTheBottom);
				await expect(page.getByText(atTheBottom, { exact: true })).toBeInViewport();
				expect(await page.evaluate(() => Math.abs(window.document.querySelector('._pageScrollableReversed')?.scrollTop ?? 99))).toBeLessThan(3);
			});
		});
	}

	test.describe('a failure from the server', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		test('is told in the language of the screen, not the English of the server', async ({ page }) => {
			const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `room leaving ${Date.now()}` }) as { id: string };
			await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
			await api(BASE_URL, 'chat/rooms/join', { i: alice.token, roomId: room.id });

			// ストリームを止めて、外されたことを画面が知らないままにする。古いタブと同じ状態で、エラーは本物のサーバーが返す
			await page.routeWebSocket(/\/streaming/, () => {});
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);
			await expect(page.getByText('No messages yet', { exact: true })).toBeVisible();
			await api(BASE_URL, 'chat/rooms/kick', { i: bob.token, roomId: room.id, userId: alice.id });

			await page.locator('button:has(i.ti-dots)').last().click();
			await page.getByText('Leave room', { exact: true }).click();
			const left = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/leave'));
			await page.getByTestId('modal-dialog-ok').click();
			expect((await left).status()).toBe(400);

			await expect(page.getByText('This room cannot be opened. It was deleted, or you are not a member.')).toBeVisible();
			await expect(page.getByText('No such room.')).toHaveCount(0);
		});
	});

	test.describe('on an Android phone', () => {
		test.use({
			viewport: { width: 412, height: 915 },
			isMobile: true,
			hasTouch: true,
			userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
		});

		// Linux の Chromium は合成した長押しから contextmenu を出さないので、実際の指の操作はそれ以外の環境でだけ確かめる
		test('a long press on a message opens its menu and selects nothing', async ({ page, context }) => {
			test.skip(process.platform === 'linux', 'Chromium on Linux does not turn a synthesized long press into a contextmenu');

			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const message = page.getByText('message 60', { exact: true });
			await expect(message).toBeVisible();
			const box = await message.boundingBox();
			if (box == null) throw new Error('the message has no box');

			const cdp = await context.newCDPSession(page);
			await cdp.send('Input.synthesizeTapGesture', { x: box.x + 16, y: box.y + box.height / 2, duration: 800, gestureSourceType: 'touch' });

			await expect(page.getByText('Copy contents', { exact: true })).toBeVisible();
			expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
		});

		// Android の Chrome は、長押しで言葉を選んでから contextmenu を出す (実機で測った順番)
		test('the contextmenu Android Chrome sends after selecting a word opens the menu and leaves nothing selected', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const message = page.getByText('message 60', { exact: true });
			await expect(message).toBeVisible();

			await message.evaluate(element => {
				const range = window.document.createRange();
				range.selectNodeContents(element);
				window.getSelection()!.removeAllRanges();
				window.getSelection()!.addRange(range);
				const box = element.getBoundingClientRect();
				element.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: box.x + 16, clientY: box.y + 8 }));
			});

			await expect(page.getByText('Copy contents', { exact: true })).toBeVisible();
			expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
		});

		// ソフトウェアキーボードは入力欄のフォーカスについてくるので、フォーカスで確かめる
		test('sending with a finger keeps the focus in the message box, and does not bring it there', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const input = page.getByPlaceholder('Enter message here');
			await input.tap();
			await expect(input).toBeFocused();
			const send = page.locator('button:has(i.ti-send)');
			const tapSend = async () => {
				const box = await send.boundingBox();
				if (box == null) throw new Error('the button has no box');
				await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
			};

			const text = `sent with a finger ${Date.now()}`;
			await page.keyboard.insertText(text);
			await tapSend();
			await expect(page.getByText(text, { exact: true })).toBeVisible();
			await expect(input).toBeFocused();

			// 押せないときも外れない
			await tapSend();
			await expect(input).toBeFocused();

			const another = `sent with nothing focused ${Date.now()}`;
			await page.keyboard.insertText(another);
			await input.blur();
			await tapSend();
			await expect(page.getByText(another, { exact: true })).toBeVisible();
			await expect(input).not.toBeFocused();
		});

		test('the text of a message does not offer itself for selection to a finger', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			const message = page.getByText('message 60', { exact: true });
			await expect(message).toBeVisible();

			expect(await message.evaluate(element => window.getComputedStyle(element).userSelect)).toBe('none');
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
