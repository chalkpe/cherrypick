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
import type { Locator, Page, WebSocketRoute } from 'playwright';

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
			// 테마 전환 화면이 입력을 가리는 동안에는 클릭을 기다리며 스크롤할 수 있다.
			await expect(page.locator('html')).not.toHaveClass(/_themeChanging_/);
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

		test('to an archived room can only be rejected from the notification, as in the list of invitations', async ({ page }) => {
			const room = await roomInvitingAlice();
			await api(BASE_URL, 'chat/rooms/update', { i: bob.token, roomId: room.id, isArchived: true });

			await page.goto(`${BASE_URL}/my/notifications`);

			// ほかの試験の招待の通知も並んでいる
			const notification = page.locator(`a[href$="/chat/room/${room.id}"]`).first().locator('xpath=ancestor::div[.//button][1]');
			const reject = notification.getByRole('button', { name: 'Reject' });
			await expect(reject).toBeVisible();
			await expect(notification.getByRole('button', { name: 'Join' })).toHaveCount(0);
			await reject.click();
			await expect(notification.getByText('Rejected', { exact: true })).toBeVisible();
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

		// 窓は動きながら開くので、止まってから読む
		async function settledTop(page: Page, username: string) {
			let last: number | undefined;
			await expect.poll(async () => {
				const top = (await row(page, username).boundingBox())?.y;
				const settled = top != null && top === last;
				last = top;
				return settled;
			}).toBe(true);
			return last;
		}

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

			// 一覧が動くと、続けて押した先が今選んだ人になって、選択が外れてしまう
			test('the rows stay in place when someone is picked or dropped', async ({ page }) => {
				await openInviteWindow(page, 'rows in place');
				await search(page, 'bob');
				const before = await settledTop(page, 'bob');

				await row(page, 'bob').click();
				await expect(picked(page)).toHaveCount(1);
				expect(await settledTop(page, 'bob')).toBe(before);

				await page.getByRole('button', { name: /^Remove .* from selection$/ }).click();
				await expect(picked(page)).toHaveCount(0);
				expect(await settledTop(page, 'bob')).toBe(before);
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
					// 今選んだ人は、送らなくても全部見えている
					await expect(page.getByRole('button', { name: /^Remove .* from selection$/ }).nth(1)).toBeInViewport({ ratio: 1 });
					// 一列に収まらない人は横に送って見る。送れば、どの人も窓の中に収まる
					for (const person of await picked(page).all()) {
						await person.scrollIntoViewIfNeeded();
						const box = await person.boundingBox();
						if (box == null) throw new Error('the person has no box');
						expect(box.x).toBeGreaterThanOrEqual(0);
						expect(box.x + box.width).toBeLessThanOrEqual(width);
					}
					await api(BASE_URL, 'i/update', { i: carol.token, name: null });
				});

				test('the rows stay in place when someone is picked', async ({ page }) => {
					await openInviteWindow(page, 'rows in place');
					await search(page, 'bob');
					const before = await settledTop(page, 'bob');

					await row(page, 'bob').tap();
					await expect(picked(page)).toHaveCount(1);

					expect(await settledTop(page, 'bob')).toBe(before);
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
	for (const [where, options, scrollAnchoring] of [
		['on a laptop', { viewport: { width: 1280, height: 720 } }, true],
		['on an Android phone', {
			viewport: { width: 412, height: 915 },
			isMobile: true,
			hasTouch: true,
			userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
		}, true],
		// Safari 18 まではスクロールアンカーがない。CI に WebKit がないので、Chromium のスクロールアンカーを切って同じ状況を作る
		['on an iPhone, without scroll anchoring', {
			viewport: { width: 390, height: 664 },
			isMobile: true,
			hasTouch: true,
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
		}, false],
	] as const) {
		test.describe(`reading a room ${where}`, () => {
			test.use(options);

			if (!scrollAnchoring) {
				test.beforeEach(async ({ page }) => {
					await page.addInitScript(() => {
						window.addEventListener('DOMContentLoaded', () => {
							const style = window.document.createElement('style');
							style.textContent = '* { overflow-anchor: none !important; }';
							window.document.head.append(style);
						});
					});
				});
			}

			const overflowAnchors = (page: Page) => page.evaluate(() => ({
				html: window.getComputedStyle(window.document.documentElement).overflowAnchor,
				body: window.getComputedStyle(window.document.body).overflowAnchor,
				messages: window.getComputedStyle(window.document.querySelector('._pageScrollableReversed') ?? window.document.body).overflowAnchor,
			}));

			const scrollMessagesTo = (page: Page, top: number) => page.evaluate(value => {
				window.document.querySelector('._pageScrollableReversed')?.scrollTo({ top: value, behavior: 'instant' });
			}, top);

			if (scrollAnchoring) test('turns off scroll anchoring for the page only while the conversation is on screen', async ({ page }) => {
				const room = await roomToReadFarAbove(page);

				// メッセージの欄では切らない。切ると、読み返しているあいだに届いた分だけ読んでいた場所がずれる
				expect(await overflowAnchors(page)).toEqual({ html: 'none', body: 'none', messages: 'auto' });

				await page.goto(`${BASE_URL}/chat`);
				await page.locator(`a[href$="/chat/room/${room.id}"]`).first().waitFor();
				expect(await overflowAnchors(page)).toMatchObject({ html: 'auto', body: 'auto' });
			});

			test('keeps the place of someone reading further up when a message comes, and follows at the bottom', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				const moved = await readFarAbove(page, room.reading);

				const whileReading = `while reading ${room.id}`;
				await room.sayAs(bob, whileReading);
				await page.getByText(whileReading, { exact: true }).waitFor({ state: 'attached' });
				await settle(page);
				expect(await moved()).toBeLessThan(2);

				await scrollMessagesTo(page, 0);
				const atTheBottom = `at the bottom ${room.id}`;
				await room.sayAs(bob, atTheBottom);
				await expect(page.getByText(atTheBottom, { exact: true })).toBeInViewport();
				expect(await page.evaluate(() => Math.abs(window.document.querySelector('._pageScrollableReversed')?.scrollTop ?? 99))).toBeLessThan(3);
			});

			test('keeps a long draft and its input in place while reading older messages', async ({ page }) => {
				await roomToReadFarAbove(page);
				const input = page.getByPlaceholder('Enter message here');
				const draft = 'A long draft to keep while reading. '.repeat(20);
				await input.fill(draft);
				const before = (await input.boundingBox())!;

				await scrollMessagesTo(page, -400);
				expect(await distanceFromNewest(page)).toBeGreaterThan(300);

				const after = (await input.boundingBox())!;
				expect(Math.abs(after.y - before.y)).toBeLessThan(2);
				await expect(input).toBeInViewport();
				await expect(input).toHaveValue(draft);
			});

			// 最新から十分に離れて読めるよう、1 通を高くする。開いたときに読み込むのは新しい 20 件
			async function roomToReadFarAbove(page: Page) {
				const room = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `far above ${Date.now()}` }) as { id: string };
				await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: room.id, userId: alice.id });
				await api(BASE_URL, 'chat/rooms/join', { i: alice.token, roomId: room.id });
				const sayAs = (user: RegisteredUser, text: string) => api(BASE_URL, 'chat/messages/create-to-room', { i: user.token, toRoomId: room.id, text }) as Promise<{ id: string }>;
				let newest = '';
				for (let i = 1; i <= 25; i++) newest = (await sayAs(bob, `line ${i} of ${room.id}\n.\n.\n.\n.`)).id;
				await page.goto(`${BASE_URL}/chat/room/${room.id}`);
				await expect(page.getByText(`line 25 of ${room.id}`)).toBeVisible();
				return { id: room.id, sayAs, newest, reading: page.getByText(`line 9 of ${room.id}`) };
			}

			const distanceFromNewest = (page: Page) => page.evaluate(() => -(window.document.querySelector('._pageScrollableReversed')?.scrollTop ?? 0));
			const newMessageNotice = (page: Page) => page.getByRole('button', { name: 'New message', exact: true });
			const settle = (page: Page) => page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 300)));

			/** @returns 読んでいた場所が今どれだけ動いたかを測る関数 */
			async function readFarAbove(page: Page, reading: Locator): Promise<() => Promise<number>> {
				await scrollMessagesTo(page, -100000);
				// 화면이 좁으면 맨 위에 왔을 때 읽을 메시지가 입력란 아래에 있을 수 있다.
				await reading.scrollIntoViewIfNeeded();
				await expect(reading).toBeInViewport();
				expect(await distanceFromNewest(page)).toBeGreaterThan(400);
				// スクロールしている途中ではなく、止まって読んでいるところ
				await settle(page);
				const before = (await reading.boundingBox())!.y;
				return async () => Math.abs((await reading.boundingBox())!.y - before);
			}

			/** @returns 描画された各フレームの中で読んでいた場所が最も動いた量を返す関数。ResizeObserver は描画の直前に呼ばれるので、そのあとで測る */
			async function watchEveryFrame(reading: Locator): Promise<() => Promise<number>> {
				const handle = await reading.evaluateHandle(el => {
					const start = el.getBoundingClientRect().top;
					const state = { worst: 0, stop: false };
					const channel = new MessageChannel();
					// 測るまでのあいだに届いた変更は、まだ描画の機会を迎えていないので数えない
					let changed = false;
					const observer = new MutationObserver(() => { changed = true; });
					observer.observe(window.document.body, { subtree: true, childList: true, characterData: true, attributes: true });
					channel.port1.onmessage = () => {
						if (!changed) state.worst = Math.max(state.worst, Math.abs(el.getBoundingClientRect().top - start));
					};
					const frame = () => {
						if (state.stop) {
							observer.disconnect();
							return;
						}
						changed = false;
						channel.port2.postMessage(null);
						window.requestAnimationFrame(frame);
					};
					window.requestAnimationFrame(frame);
					return state;
				});
				return () => handle.evaluate(state => {
					state.stop = true;
					return state.worst;
				});
			}

			/**
			 * 一番上ではないところで読む。一番上にいると、下が縮んだ分はスクロールの端に吸われて、読んでいた場所は動かない
			 * @returns 読んでいた場所が今どれだけ動いたかを測る関数
			 */
			async function readInTheMiddle(page: Page, roomId: string): Promise<() => Promise<number>> {
				await scrollMessagesTo(page, -100000);
				await settle(page);
				await page.evaluate(() => {
					const scroller = window.document.querySelector('._pageScrollableReversed')!;
					scroller.scrollTo({ top: scroller.scrollTop + 400, behavior: 'instant' });
				});
				await settle(page);
				expect(await distanceFromNewest(page)).toBeGreaterThan(400);
				const height = page.viewportSize()!.height;
				// 開いたときに読み込むのは新しい 20 件
				for (let i = 6; i <= 25; i++) {
					const line = page.getByText(`line ${i} of ${roomId}`);
					const box = await line.boundingBox();
					if (box != null && box.y > 100 && box.y < height - 300) {
						return async () => Math.abs((await line.boundingBox())!.y - box.y);
					}
				}
				throw new Error('no line on screen to read');
			}

			test('sending from far above goes to the newest message', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				await readFarAbove(page, room.reading);

				const text = `sent from here ${room.id}`;
				await page.getByPlaceholder('Enter message here').fill(text);
				const answered = page.waitForResponse(response => response.url().endsWith('/api/chat/messages/create-to-room'));
				await page.locator('button:has(i.ti-send)').click();
				expect((await answered).status()).toBe(200);

				await expect(page.getByText(text, { exact: true })).toBeInViewport();
				await expect.poll(() => distanceFromNewest(page)).toBeLessThan(3);
				await expect(newMessageNotice(page)).toBeHidden();
			});

			test('sending a picture from far above goes to the newest message', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				await readFarAbove(page, room.reading);

				await page.getByRole('button', { name: 'Select a file' }).click();
				const chooser = page.waitForEvent('filechooser');
				await page.getByText('Upload', { exact: true }).click();
				await (await chooser).setFiles({ name: 'one.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
				// 閉じる途中のメニューにも同じ名前の項目がある (あちらの役割は menuitem)
				await page.getByRole('button', { name: 'Upload' }).click();
				// アップロードが終わるとウィンドウが閉じて、添付が入力欄に入る
				await expect(page.getByText('Upload 1 files', { exact: true })).toHaveCount(0);

				const text = `picture from here ${room.id}`;
				await page.getByPlaceholder('Enter message here').fill(text);
				await page.locator('button:has(i.ti-send)').click();

				await expect(page.getByText(text, { exact: true })).toBeInViewport();
				await expect.poll(() => distanceFromNewest(page)).toBeLessThan(3);
			});

			test('a message of mine from another device leaves the place alone, and says nothing', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				const moved = await readFarAbove(page, room.reading);

				const text = `from my other device ${room.id}`;
				await room.sayAs(alice, text);
				await page.getByText(text, { exact: true }).waitFor({ state: 'attached' });
				await settle(page);

				expect(await moved()).toBeLessThan(2);
				await expect(newMessageNotice(page)).toBeHidden();
			});

			test('an edit, a reaction, a deletion and loading earlier messages leave the place alone, and say nothing', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				const moved = await readFarAbove(page, room.reading);

				const edited = `edited ${room.id}`;
				await api(BASE_URL, 'chat/messages/update', { i: bob.token, messageId: room.newest, text: edited });
				await page.getByText(edited, { exact: true }).waitFor({ state: 'attached' });
				await api(BASE_URL, 'chat/messages/react', { i: alice.token, messageId: room.newest, reaction: '👍' });
				await settle(page);
				await api(BASE_URL, 'chat/messages/delete', { i: bob.token, messageId: room.newest });
				await expect(page.getByText(edited, { exact: true })).toHaveCount(0);
				await settle(page);
				expect(await moved()).toBeLessThan(2);
				await expect(newMessageNotice(page)).toBeHidden();

				await page.getByLabel('Messages').getByRole('button', { name: 'Load more', exact: true }).click();
				await page.getByText(`line 1 of ${room.id}`).waitFor({ state: 'attached' });
				await expect.poll(moved).toBeLessThan(4);
				await expect(newMessageNotice(page)).toBeHidden();
			});

			test('a message and a change to it stay out of the place in every frame, not only in the end', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				await readFarAbove(page, room.reading);
				const worstMove = await watchEveryFrame(room.reading);

				const text = `watched ${room.id}`;
				const { id } = await room.sayAs(bob, `${text}\n.\n.\n.`);
				await page.getByText(text).waitFor({ state: 'attached' });
				await settle(page);
				await api(BASE_URL, 'chat/messages/react', { i: alice.token, messageId: id, reaction: '👍' });
				await settle(page);
				await api(BASE_URL, 'chat/messages/delete', { i: bob.token, messageId: id });
				await expect(page.getByText(text)).toHaveCount(0);
				await settle(page);

				expect(await worstMove()).toBeLessThan(2);
			});

			// Chromium と Safari 27 のスクロールアンカーは、下が縮んだときには直さないことがある
			test('something below getting shorter leaves the place alone, a reaction taken back or an edit', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				const moved = await readInTheMiddle(page, room.id);

				await api(BASE_URL, 'chat/messages/react', { i: alice.token, messageId: room.newest, reaction: '👍' });
				await settle(page);
				await api(BASE_URL, 'chat/messages/unreact', { i: alice.token, messageId: room.newest, reaction: '👍' });
				await settle(page);
				expect(await moved()).toBeLessThan(2);

				const short = `short now ${room.id}`;
				await api(BASE_URL, 'chat/messages/update', { i: bob.token, messageId: room.newest, text: short });
				await page.getByText(short, { exact: true }).waitFor({ state: 'attached' });
				await settle(page);
				expect(await moved()).toBeLessThan(2);
			});

			// ブラウザがもう直したものを、もう一度動かさない
			if (scrollAnchoring) test('leaves a message and a reaction to the browser, which keeps the place itself', async ({ page }) => {
				await page.addInitScript(() => {
					const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
					const counted = window as unknown as { scrollTopWrites: number };
					counted.scrollTopWrites = 0;
					Object.defineProperty(Element.prototype, 'scrollTop', {
						get: scrollTop.get,
						set(value: number) {
							counted.scrollTopWrites++;
							scrollTop.set!.call(this, value);
						},
						configurable: true,
					});
				});
				const room = await roomToReadFarAbove(page);
				const moved = await readInTheMiddle(page, room.id);
				const writes = () => page.evaluate(() => (window as unknown as { scrollTopWrites: number }).scrollTopWrites);
				const before = await writes();

				const text = `left to the browser ${room.id}`;
				await room.sayAs(bob, text);
				await page.getByText(text, { exact: true }).waitFor({ state: 'attached' });
				await settle(page);
				await api(BASE_URL, 'chat/messages/react', { i: alice.token, messageId: room.newest, reaction: '👍' });
				await settle(page);

				expect(await moved()).toBeLessThan(2);
				expect(await writes()).toBe(before);
			});

			test('near the newest message, follows even a tall message and says nothing', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				await scrollMessagesTo(page, -100);
				await settle(page);

				const text = `tall message ${room.id}`;
				await room.sayAs(bob, `${text}\n${'.\n'.repeat(30)}.`);
				await page.getByText(text).waitFor({ state: 'attached' });

				await expect.poll(() => distanceFromNewest(page)).toBeLessThan(3);
				await expect(newMessageNotice(page)).toBeHidden();
			});

			test('a message from someone else far above brings the notice, which goes to it when pressed', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				const moved = await readFarAbove(page, room.reading);

				const text = `while far above ${room.id}`;
				await room.sayAs(bob, text);
				const notice = newMessageNotice(page);
				await expect(notice).toBeVisible();
				await settle(page);
				expect(await moved()).toBeLessThan(2);
				await expect(page.getByText(text, { exact: true })).not.toBeInViewport();

				// 入力欄に重ならず、押せるのは案内のボタンだけ (その横のメッセージは押せるまま)
				const box = (await notice.boundingBox())!;
				const input = (await page.getByPlaceholder('Enter message here').boundingBox())!;
				expect(box.y + box.height).toBeLessThanOrEqual(input.y);
				expect(await notice.evaluate(button => {
					const r = button.getBoundingClientRect();
					const beside = window.document.elementFromPoint(r.left - 8, r.top + r.height / 2);
					return beside != null && button.parentElement!.contains(beside);
				})).toBe(false);

				await notice.click();

				await expect(notice).toBeHidden();
				await expect(page.getByText(text, { exact: true })).toBeInViewport();
				await expect.poll(() => distanceFromNewest(page)).toBeLessThan(3);
			});

			test('the notice can be used from the keyboard, and leaves the focus in the message box', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				await readFarAbove(page, room.reading);
				await room.sayAs(bob, `for the keyboard ${room.id}`);
				const notice = newMessageNotice(page);
				await expect(notice).toBeVisible();

				const input = page.getByPlaceholder('Enter message here');
				await input.focus();
				await page.keyboard.press('Shift+Tab');
				await expect(notice).toBeFocused();
				await page.keyboard.press('Enter');

				await expect(notice).toBeHidden();
				await expect.poll(() => distanceFromNewest(page)).toBeLessThan(3);
				await expect(input).toBeFocused();
			});

			test('the notice goes away on reaching the newest message by scrolling, and not on the way', async ({ page }) => {
				const room = await roomToReadFarAbove(page);
				await readFarAbove(page, room.reading);
				await room.sayAs(bob, `to scroll to ${room.id}`);
				const notice = newMessageNotice(page);
				await expect(notice).toBeVisible();

				await scrollMessagesTo(page, -100);
				await settle(page);
				await expect(notice).toBeVisible();

				await scrollMessagesTo(page, 0);
				await expect(notice).toBeHidden();
			});

			test('reading again after a reconnect keeps the place, and tells of what came meanwhile', async ({ page }) => {
				let socket: WebSocketRoute | undefined;
				await page.routeWebSocket(/\/streaming/, ws => {
					socket = ws;
					const server = ws.connectToServer();
					ws.onMessage(message => server.send(message));
					server.onMessage(message => ws.send(message));
				});
				const room = await roomToReadFarAbove(page);
				const moved = await readFarAbove(page, room.reading);

				await socket!.close();
				const text = `while disconnected ${room.id}`;
				await room.sayAs(bob, text);

				await expect(newMessageNotice(page)).toBeVisible({ timeout: 30_000 });
				await page.getByText(text, { exact: true }).waitFor({ state: 'attached' });
				await settle(page);
				expect(await moved()).toBeLessThan(2);
			});

			test('the notice stays behind on going to another room, and is gone on coming back', async ({ page }) => {
				const other = await api(BASE_URL, 'chat/rooms/create', { i: bob.token, name: `another room ${Date.now()}` }) as { id: string };
				await api(BASE_URL, 'chat/rooms/invitations/create', { i: bob.token, roomId: other.id, userId: alice.id });
				await api(BASE_URL, 'chat/rooms/join', { i: alice.token, roomId: other.id });
				await api(BASE_URL, 'chat/messages/create-to-room', { i: bob.token, toRoomId: other.id, text: `in another room ${other.id}` });
				const room = await roomToReadFarAbove(page);
				await readFarAbove(page, room.reading);
				await room.sayAs(bob, `before leaving ${room.id}`);
				const notice = newMessageNotice(page);
				await expect(notice).toBeVisible();

				// 読み込み直すと作り直されるので、画面の中から移る
				await page.locator('button:has(i.ti-arrow-left)').first().click();
				await page.locator(`a[href$="/chat/room/${other.id}"]`).first().click();
				await expect(page.getByText(`in another room ${other.id}`, { exact: true })).toBeVisible();
				await expect(notice).toBeHidden();

				await page.goBack();
				await page.goBack();
				await expect(room.reading).toBeAttached();
				await settle(page);
				await expect(notice).toBeHidden();
			});
		});
	}

	test.describe('in the dark theme', () => {
		test.use({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark' });

		// 操作できる図形に求められる 3:1 (WCAG 1.4.11)。背景は半透明のことがあるので、不透明なところまで重ねて測る
		const contrastOf = (locator: Locator) => locator.evaluate(el => {
			const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
			const over = (top: number[], below: number[]) => {
				const alpha = top[3] ?? 1;
				return [0, 1, 2].map(i => top[i] * alpha + below[i] * (1 - alpha));
			};
			const layers: number[][] = [];
			for (let at: Element | null = el; at != null; at = at.parentElement) layers.push(channels(window.getComputedStyle(at).backgroundColor));
			const background = layers.reduceRight((below, top) => over(top, below), [255, 255, 255]);
			const foreground = over(channels(window.getComputedStyle(el).color), background);
			const luminance = (rgb: number[]) => {
				const [r, g, b] = rgb.map(v => {
					const c = v / 255;
					return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * b;
			};
			const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
			return (lighter + 0.05) / (darker + 0.05);
		});

		test('the button to cancel an invitation can be told from what it is on', async ({ page }) => {
			const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: `dark room ${Date.now()}` }) as { id: string };
			await api(BASE_URL, 'chat/rooms/invitations/create', { i: alice.token, roomId: room.id, userId: bob.id });
			await page.goto(`${BASE_URL}/chat/room/${room.id}`);
			await page.locator('button:has(i.ti-users)', { hasText: 'Members' }).first().click();

			const cancel = page.getByRole('button', { name: /Cancel the invitation sent to/ });
			await expect(cancel).toBeVisible();

			expect(await contrastOf(cancel)).toBeGreaterThanOrEqual(3);
		});
	});

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
