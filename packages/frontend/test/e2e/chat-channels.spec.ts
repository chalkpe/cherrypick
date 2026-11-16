/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { api, resetState, ADMIN_SETUP_PASSWORD } from './shared.js';
import type { Locator, Page } from 'playwright';
import type * as Misskey from 'cherrypick-js';

type Account = Misskey.entities.MeDetailed & { token: string };
const base = process.env.CHAT_CHANNEL_BASE_URL ?? 'http://localhost:61812';
const path = (roomId: string, channelId?: string) => `/chat/room/${roomId}/channels${channelId ? `/${channelId}` : ''}`;
let owner: Account;
let member: Account;
let group: Misskey.entities.ChatRoom;
let ordinary: Misskey.entities.ChatRoom;
let channels: Misskey.entities.ChatRoomChannel[];

async function createGroup(name: string, convert = true) {
	const room = await api(base, 'chat/rooms/create', { i: owner.token, name });
	await api(base, 'chat/rooms/invitations/create', { i: owner.token, roomId: room.id, userId: member.id });
	await api(base, 'chat/rooms/join', { i: member.token, roomId: room.id });
	if (convert) await api(base, 'chat/rooms/convert-to-channels', { i: owner.token, roomId: room.id });
	return room as Misskey.entities.ChatRoom;
}

async function login(page: Page, account = owner, lang = 'en-US') {
	await page.addInitScript(({ account, lang }) => {
		localStorage.setItem('account', JSON.stringify(account));
		localStorage.setItem('lang', lang);
		localStorage.setItem('ui', 'friendly');
		localStorage.setItem('neverShowDonationInfo', 'true');
		localStorage.setItem('modifiedVersionMustProminentlyOfferInAgplV3Section13Read', 'true');
	}, { account, lang });
}

// 메뉴 항목의 접근성 이름은 아이콘 글리프 뒤에 채널 이름이 붙는다.
function channelLink(page: Page, name: string) {
	return page.getByRole('link', { name: new RegExp(`(^|\\s)${name}$`) });
}

async function open(page: Page, target: string) {
	await page.goto(base + target);
	await expect(page.locator('[data-testid="modal-dialog-ok"]')).toHaveCount(0);
}

async function send(page: Page, text: string) {
	const input = page.getByPlaceholder('Enter message here');
	await input.fill(text);
	const response = page.waitForResponse(response => response.url().endsWith('/api/chat/messages/create-to-room') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Send', exact: true }).click();
	const sent = await response;
	expect(sent.status()).toBe(200);
	return { message: await sent.json() as Misskey.entities.ChatMessage, request: sent.request().postDataJSON() };
}

type SocketTrackingWindow = Window & { __ws: WebSocket[] };

// 생성되는 WebSocket을 추적한다. 오프라인만으로는 기존 소켓이 닫히지 않아 재연결을 만들 수 없다.
async function trackSockets(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as SocketTrackingWindow;
		w.__ws = [];
		const Native = window.WebSocket;
		const Wrapped = function (url: string | URL, protocols?: string | string[]) {
			const ws = new Native(url, protocols);
			w.__ws.push(ws);
			return ws;
		} as unknown as typeof WebSocket;
		Object.assign(Wrapped, { prototype: Native.prototype, CONNECTING: Native.CONNECTING, OPEN: Native.OPEN, CLOSING: Native.CLOSING, CLOSED: Native.CLOSED });
		window.WebSocket = Wrapped;
	});
}

async function cutStream(page: Page) {
	await page.context().setOffline(true);
	await page.evaluate(() => {
		const w = window as unknown as SocketTrackingWindow;
		for (const ws of w.__ws) if (ws.readyState <= WebSocket.OPEN) ws.close();
	});
}

test.beforeAll(async () => {
	const fixtureFile = process.env.CHAT_CHANNEL_FIXTURE;
	if (fixtureFile && existsSync(fixtureFile)) {
		({ owner, member, group, ordinary, channels } = JSON.parse(await readFile(fixtureFile, 'utf8')));
		return;
	}
	if (!fixtureFile) await resetState(base);
	const admin = await api(base, 'admin/accounts/create', { username: 'channeladmin', password: 'channel-test-password', setupPassword: ADMIN_SETUP_PASSWORD });
	owner = await api(base, 'admin/accounts/create', { i: admin.token, username: 'channelowner', password: 'channel-test-password' });
	member = await api(base, 'admin/accounts/create', { i: admin.token, username: 'channelmember', password: 'channel-test-password' });
	for (const account of [owner, member]) {
		await api(base, 'i/registry/set', { i: account.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
		await api(base, 'i/update', { i: account.token, chatScope: 'everyone' });
	}
	group = await createGroup('Channel navigation');
	ordinary = await createGroup('Ordinary group', false);
	channels = await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: group.id });
	channels.push(await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: group.id, name: 'work' }));
	for (const [index, channel] of channels.entries()) {
		await api(base, 'chat/messages/create-to-room', { i: member.token, toRoomId: group.id, toRoomChannelId: channel.id, text: `scope needle ${index === 0 ? 'general' : 'work'}` });
	}
	await api(base, 'chat/messages/create-to-room', { i: member.token, toRoomId: ordinary.id, text: 'ordinary group message' });
	await api(base, 'chat/messages/create-to-user', { i: member.token, toUserId: owner.id, text: 'individual message' });
	if (fixtureFile) await writeFile(fixtureFile, JSON.stringify({ owner, member, group, ordinary, channels }));
});

const networkEvidence = new WeakMap<Page, { records: Record<string, unknown>[]; responses: Promise<void>[] }>();

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, data]) => [key, /^(i|token|password)$/i.test(key) ? '[redacted]' : redact(data)]));
	return value;
}

test.beforeEach(async ({ page }) => {
	const evidence = { records: [] as Record<string, unknown>[], responses: [] as Promise<void>[] };
	networkEvidence.set(page, evidence);
	page.on('request', request => {
		if (!new URL(request.url()).pathname.startsWith('/api/chat/')) return;
		evidence.records.push({ direction: 'request', path: new URL(request.url()).pathname, data: redact(request.postDataJSON()) });
	});
	page.on('response', response => {
		if (!new URL(response.url()).pathname.startsWith('/api/chat/')) return;
		evidence.responses.push((async () => {
			const body = response.status() === 204 ? null : await response.json().catch(() => null);
			evidence.records.push({ direction: 'response', path: new URL(response.url()).pathname, status: response.status(), data: redact(body) });
		})());
	});
	page.on('websocket', socket => {
		socket.on('framereceived', event => {
			try { evidence.records.push({ direction: 'stream', data: redact(JSON.parse(event.payload.toString())) }); } catch { /* JSON 외 프레임은 기록하지 않는다. */ }
		});
	});
});

test.afterEach(async ({ page }, testInfo) => {
	const evidence = networkEvidence.get(page)!;
	// 페이지 이동으로 끊긴 응답 본문을 기다리다 시험이 멈추지 않게 대기 시간을 제한한다.
	await Promise.race([Promise.allSettled(evidence.responses), new Promise(resolve => setTimeout(resolve, 5000))]);
	await testInfo.attach('chat-http-stream', { body: JSON.stringify(evidence.records, null, 2), contentType: 'application/json' });
});

test('narrow navigation has separate group, channel and conversation depths', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await open(page, '/chat');
	await page.locator(`a[href="${path(group.id)}"]`).click();
	await expect(page).toHaveURL(base + path(group.id));
	await expect(page.getByPlaceholder('Enter message here')).toHaveCount(0);
	await channelLink(page, 'work').click();
	await expect(page).toHaveURL(base + path(group.id, channels[1].id));
	await expect(page.getByText('scope needle work', { exact: true })).toBeVisible();
	await page.locator('button:has(.ti-arrow-left):visible').last().click();
	await expect(page).toHaveURL(base + path(group.id));
	await expect(channelLink(page, 'general')).toBeVisible();
});

test('direct addresses, refresh and browser history retain the selected channel', async ({ page }) => {
	await page.setViewportSize({ width: 1600, height: 1000 });
	await login(page);
	await open(page, path(group.id, channels[1].id));
	await expect(page.getByPlaceholder('Enter message here')).toBeInViewport();
	const sent = await send(page, 'channel-specific message');
	expect(sent.request.toRoomChannelId).toBe(channels[1].id);
	await page.reload();
	await expect(page).toHaveURL(base + path(group.id, channels[1].id));
	await expect(page.getByText('channel-specific message', { exact: true })).toBeVisible();
	await page.locator('button:has(.ti-arrow-left):visible').last().click();
	await expect(page).toHaveURL(base + path(group.id));
	await channelLink(page, 'general').click();
	await expect(page.getByText('scope needle general', { exact: true })).toBeVisible();
	await expect(page.getByText('channel-specific message', { exact: true })).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(base + path(group.id));
	await page.goBack();
	await expect(page).toHaveURL(base + path(group.id, channels[1].id));
	await page.goForward();
	await expect(page).toHaveURL(base + path(group.id));
	await page.goForward();
	await expect(page).toHaveURL(base + path(group.id, channels[0].id));
	await page.goto(`${base}/chat/room/${group.id}`);
	await expect(page).toHaveURL(base + path(group.id, channels[0].id));
});

test('the wide conversation shows the channel rail and navigates between channels', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 2000, height: 1000 });
	await login(page);
	await open(page, path(group.id, channels[1].id));
	await expect(channelLink(page, 'work')).toBeVisible();
	await channelLink(page, 'general').click();
	await expect(page).toHaveURL(base + path(group.id, channels[0].id));
	await expect(page.getByText('scope needle general', { exact: true })).toBeVisible();
	await expect(page.locator('#splash')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('wide-channel-rail.png'), fullPage: false });
	await page.goBack();
	await expect(page).toHaveURL(base + path(group.id, channels[1].id));
	await page.goForward();
	await expect(page).toHaveURL(base + path(group.id, channels[0].id));
});

test('channel attachments, saved dice and reactions use the real message endpoints', async ({ page }) => {
	await login(page);
	await open(page, path(group.id, channels[1].id));
	await page.getByRole('button', { name: 'Select a file', exact: true }).click();
	const chooser = page.waitForEvent('filechooser');
	await page.getByText('Upload', { exact: true }).click();
	await (await chooser).setFiles({ name: 'blue-square.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
	await page.getByRole('button', { name: /Upload$/ }).click();
	await expect(page.getByText('Upload 1 files', { exact: true })).toHaveCount(0);
	const attached = await send(page, 'channel attachment');
	expect(attached.request.toRoomChannelId).toBe(channels[1].id);
	expect(attached.message.files).toHaveLength(1);
	await expect(page.locator(`[data-chat-message-id="${attached.message.id}"] img`)).toBeVisible();

	const rolled = await send(page, '/dice 1d6');
	expect(rolled.message.dice).not.toBeNull();
	await expect(page.locator(`[data-chat-message-id="${rolled.message.id}"] details`)).toBeVisible();
	const incoming = await api(base, 'chat/messages/create-to-room', { i: member.token, toRoomId: group.id, toRoomChannelId: channels[1].id, text: 'reaction target' });
	await api(base, 'chat/messages/react', { i: owner.token, messageId: incoming.id, reaction: '👍' });
	const reaction = page.locator(`[data-chat-message-id="${incoming.id}"]`).getByRole('img', { name: '👍' });
	await expect(reaction).toBeVisible();
	const unreacted = page.waitForResponse(response => response.url().endsWith('/api/chat/messages/unreact'));
	await reaction.click();
	expect((await unreacted).request().postDataJSON()).toMatchObject({ messageId: incoming.id, reaction: '👍' });
	await expect(reaction).toHaveCount(0);
});

test('selected references keep duplicate IDs, survive edits and follow renaming and deletion', async ({ page }) => {
	const duplicate1 = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: group.id, name: 'same' });
	const duplicate2 = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: group.id, name: 'same' });
	await login(page);
	await open(page, path(group.id, channels[1].id));
	const input = page.getByPlaceholder('Enter message here');
	await input.fill('😀 #sa');
	await page.getByRole('listbox').getByRole('option').nth(1).click();
	const response = page.waitForResponse(response => response.url().endsWith('/api/chat/messages/create-to-room'));
	await page.getByRole('button', { name: 'Send', exact: true }).click();
	const sent = await response;
	expect(sent.request().postDataJSON().channelRefs).toEqual([{ channelId: duplicate2.id, start: 3, length: 5 }]);
	const message = await sent.json();
	const bubble = page.locator(`[data-chat-message-id="${message.id}"]`);
	await expect(bubble.locator(`a[href="${path(group.id, duplicate2.id)}"]`)).toBeVisible();
	await bubble.getByRole('img', { name: '😀' }).click({ button: 'right' });
	await page.getByText('Edit', { exact: true }).click();
	await input.press('Home');
	await input.press('Control+Home');
	await input.pressSequentially('hello ');
	const edited = page.waitForResponse(response => response.url().endsWith('/api/chat/messages/update'));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await edited).request().postDataJSON().channelRefs).toEqual([{ channelId: duplicate2.id, start: 9, length: 5 }]);
	await api(base, 'chat/rooms/channels/update', { i: owner.token, channelId: duplicate2.id, name: 'Renamed' });
	await expect(bubble.getByRole('link', { name: '#Renamed', exact: true })).toHaveAttribute('href', path(group.id, duplicate2.id));
	await api(base, 'chat/rooms/channels/delete', { i: owner.token, channelId: duplicate2.id });
	await expect(bubble.getByText('Deleted channel', { exact: false })).toBeVisible();
	await expect(bubble.locator(`a[href="${path(group.id, duplicate2.id)}"]`)).toHaveCount(0);
	await api(base, 'chat/rooms/channels/delete', { i: owner.token, channelId: duplicate1.id });
});

test('conversion shows the confirmed Korean warning and management uses channel IDs', async ({ page }) => {
	const room = await createGroup('Management', false);
	await login(page, owner, 'ko-KR');
	await open(page, `/chat/room/${room.id}`);
	await page.getByText('정보', { exact: true }).click();
	await page.getByRole('button', { name: '채널형으로 전환', exact: true }).click();
	await expect(page.getByText('기존 대화 기록이 모두 #general 채널로 옮겨져요.', { exact: false })).toBeVisible();
	await expect(page.getByText('전환 후에는 다시 단일 대화방으로 되돌릴 수 없어요.', { exact: false })).toBeVisible();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(page).toHaveURL(new RegExp(`/chat/room/${room.id}/channels/`));
	await page.getByText('정보', { exact: true }).click();
	await page.getByRole('button', { name: '채널 만들기', exact: true }).click();
	const nameDialog = page.locator('header:visible').filter({ hasText: '채널 이름' }).locator('..').filter({ has: page.locator('input:focus') });
	await nameDialog.getByRole('textbox').fill('  same  ');
	const created = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/channels/create'));
	await nameDialog.getByTestId('modal-dialog-ok').click();
	const channel = await (await created).json();
	expect(channel.name).toBe('same');
	const row = page.locator(`[data-chat-channel-id="${channel.id}"]`);
	await row.getByRole('button', { name: '위로 이동', exact: true }).click();
	await expect.poll(async () => (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0].id).toBe(channel.id);
	await row.getByRole('button', { name: '이름 변경', exact: true }).click();
	await nameDialog.getByRole('textbox').fill('renamed');
	const renamed = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/channels/update'));
	await nameDialog.getByTestId('modal-dialog-ok').click();
	expect((await (await renamed).json()).name).toBe('renamed');
	const legacy = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id })).find((channel: Misskey.entities.ChatRoomChannel) => channel.isLegacy);
	await page.locator(`[data-chat-channel-id="${legacy.id}"]`).getByRole('button', { name: '삭제', exact: true }).click();
	const legacyWarning = page.getByText('이 채널을 삭제하면 구버전 서버와 앱에서 대화할 수 없어요.', { exact: false });
	await expect(legacyWarning).toBeVisible();
	const legacyDialog = legacyWarning.locator('xpath=ancestor::div[.//button[@data-testid="modal-dialog-cancel"]][1]');
	await legacyDialog.getByTestId('modal-dialog-cancel').click();
	await row.getByRole('button', { name: '삭제', exact: true }).click();
	const deleteWarning = page.getByText('#renamed 채널과 모든 메시지를 영구 삭제할까요?', { exact: false });
	const deleteDialog = deleteWarning.locator('xpath=ancestor::div[.//button[@data-testid="modal-dialog-ok"]][1]');
	const deleted = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/channels/delete'));
	await deleteDialog.getByTestId('modal-dialog-ok').click();
	expect((await deleted).status()).toBe(204);
	await expect(page.locator(`[data-chat-channel-id="${legacy.id}"]`).getByRole('button', { name: '삭제', exact: true })).toBeDisabled();
	await api(base, 'chat/rooms/update', { i: owner.token, roomId: room.id, isArchived: true });
	await expect(page.getByRole('button', { name: '채널 만들기', exact: true })).toBeDisabled();
});

async function dragByMouse(page: Page, source: Locator, target: Locator) {
	const s = await source.boundingBox();
	const t = await target.boundingBox();
	if (!s || !t) throw new Error('drag bounds missing');
	await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
	await page.mouse.down();
	await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 12, { steps: 6 });
	await page.waitForTimeout(80);
	await page.mouse.move(t.x + t.width / 2, t.y + t.height - 4, { steps: 24 });
	await page.waitForTimeout(80);
	await page.mouse.up();
}

// 레일은 overflow-y:auto 스크롤 컨테이너라 headless Chromium에서 네이티브 끌기 시작이 막힌다.
// 실제 DragEvent를 흘려 MkDraggable의 끌기 처리를 그대로 검증한다.
async function dispatchRailDrag(page: Page, source: Locator, target: Locator) {
	const s = await source.elementHandle();
	const t = await target.elementHandle();
	await page.evaluate(([sEl, tEl]) => {
		const item = tEl.parentElement!.parentElement!.parentElement!;
		const area = item.lastElementChild as HTMLElement;
		const dataTransfer = new DataTransfer();
		sEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
		area.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
		area.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	}, [s, t]);
}

test('owner reorders channels by dragging in management and the wide rail, and the order persists', async ({ page }) => {
	const room = await createGroup('Drag reorder');
	const beta = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'beta' });
	const initial = await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id });
	await login(page, owner, 'en-US');
	await page.setViewportSize({ width: 2000, height: 1000 });

	// Management screen: drag the first channel below the second.
	await open(page, `/chat/room/${room.id}`);
	await page.getByText('About', { exact: true }).click();
	const rows = page.locator('[data-chat-channel-id]');
	await expect(rows).toHaveCount(2);
	await dragByMouse(page, rows.nth(0).getByRole('button', { name: 'Drag to reorder' }), rows.nth(1));
	await expect.poll(async () => (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0].id).toBe(beta.id);

	// Wide rail: drag the first channel below the second to swap back.
	await open(page, path(room.id, beta.id));
	const rail = page.getByRole('navigation', { name: 'Channels' });
	const railLinks = rail.getByRole('link');
	await expect(railLinks).toHaveCount(2);
	await dispatchRailDrag(page, rail.getByRole('button', { name: 'Drag to reorder' }).nth(0), railLinks.nth(1));
	await expect.poll(async () => (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0].id).toBe(initial[0].id);

	// The new order survives a reload.
	await page.waitForLoadState('networkidle');
	await page.reload();
	await expect(railLinks.nth(0)).toHaveText(initial[0].name);
});

test('members cannot drag channels in the rail or the management screen', async ({ page }) => {
	await page.setViewportSize({ width: 2000, height: 1000 });
	await login(page, member, 'en-US');
	await open(page, path(group.id, channels[1].id));
	const rail = page.getByRole('navigation', { name: 'Channels' });
	const link = rail.getByRole('link').first();
	await expect(link).toBeVisible();
	expect(await link.getAttribute('draggable')).not.toBe('true');

	await page.getByText('About', { exact: true }).click();
	await expect(page.getByRole('button', { name: 'Create channel' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Drag to reorder' })).toHaveCount(0);
});

test('rail dots blink only for notification targets and the current channel is marked', async ({ page }) => {
	const room = await createGroup('Evening plans');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	const quiet = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'beta' });
	const loud = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'gamma' });
	await api(base, 'chat/rooms/notifications', { i: owner.token, roomId: room.id, channelId: quiet.id, level: 'mentions' });
	await api(base, 'chat/rooms/notifications', { i: member.token, roomId: room.id, channelId: quiet.id, level: 'mentions' });
	await api(base, 'chat/messages/create-to-room', { i: member.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: 'plain update' });
	await api(base, 'chat/messages/create-to-room', { i: member.token, toRoomId: room.id, toRoomChannelId: loud.id, text: 'another update' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: 'reply one' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: loud.id, text: 'reply two' });

	await page.setViewportSize({ width: 2000, height: 1000 });
	for (const account of [owner, member]) {
		await login(page, account, 'en-US');
		await open(page, path(room.id, general.id));
		const rail = page.getByRole('navigation', { name: 'Channels' });
		const quietLink = rail.locator(`a[href="${path(room.id, quiet.id)}"]`);
		const loudLink = rail.locator(`a[href="${path(room.id, loud.id)}"]`);
		await expect(quietLink.locator('.itemIndicator')).toBeVisible();
		await expect(quietLink.locator('.itemIndicator')).not.toHaveClass(/_blink/);
		await expect(loudLink.locator('.itemIndicator')).toHaveClass(/_blink/);
		await expect(rail.locator(`a[href="${path(room.id, general.id)}"]`)).toHaveAttribute('aria-current', 'page');
		await expect(quietLink).not.toHaveAttribute('aria-current', 'page');
		await expect(loudLink).not.toHaveAttribute('aria-current', 'page');
	}
});

test('the narrow channel list re-reads unread markers after the stream reconnects', async ({ page }) => {
	const room = await createGroup('Reconnect markers');
	const quiet = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'beta' });
	await api(base, 'chat/rooms/notifications', { i: member.token, roomId: room.id, channelId: quiet.id, level: 'mentions' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: 'plain note' });

	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await trackSockets(page);
	await open(page, path(room.id));
	const list = page.getByRole('navigation', { name: 'Channels' });
	const quietLink = list.locator(`a[href="${path(room.id, quiet.id)}"]`);
	await expect(quietLink.locator('.itemIndicator')).toBeVisible();
	await expect(quietLink.locator('.itemIndicator')).not.toHaveClass(/_blink/);

	// 연결을 끊는 동안 다른 계정의 실제 API로 멘션이 도착한다.
	await cutStream(page);
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: `ping @${member.username}` });
	const unreadAfterReconnect = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/unread') && response.request().method() === 'POST', { timeout: 15_000 });
	await page.context().setOffline(false);
	await unreadAfterReconnect;
	await expect(quietLink.locator('.itemIndicator')).toHaveClass(/_blink/);
});

test('the narrow channel list clears unread markers after the stream reconnects when read elsewhere', async ({ page }) => {
	const room = await createGroup('Reconnect clear');
	const loud = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'gamma' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: loud.id, text: 'news' });

	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await trackSockets(page);
	await open(page, path(room.id));
	const list = page.getByRole('navigation', { name: 'Channels' });
	const loudLink = list.locator(`a[href="${path(room.id, loud.id)}"]`);
	await expect(loudLink.locator('.itemIndicator')).toHaveClass(/_blink/);

	// 끊긴 동안 같은 계정이 다른 기기에서 읽는다.
	await cutStream(page);
	await api(base, 'chat/rooms/read', { i: member.token, roomId: room.id, channelId: loud.id });
	const unreadAfterReconnect = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/unread') && response.request().method() === 'POST', { timeout: 15_000 });
	await page.context().setOffline(false);
	await unreadAfterReconnect;
	await expect(loudLink.locator('.itemIndicator')).toHaveCount(0);
});

test('the wide rail re-reads unread markers after the stream reconnects', async ({ page }) => {
	const room = await createGroup('Reconnect rail');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	const quiet = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'beta' });
	await api(base, 'chat/rooms/notifications', { i: member.token, roomId: room.id, channelId: quiet.id, level: 'mentions' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: 'plain note' });

	await page.setViewportSize({ width: 2000, height: 1000 });
	await login(page, member, 'en-US');
	await trackSockets(page);
	await open(page, path(room.id, general.id));
	const rail = page.getByRole('navigation', { name: 'Channels' });
	const quietLink = rail.locator(`a[href="${path(room.id, quiet.id)}"]`);
	await expect(quietLink.locator('.itemIndicator')).toBeVisible();
	await expect(quietLink.locator('.itemIndicator')).not.toHaveClass(/_blink/);

	await cutStream(page);
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: `ping @${member.username}` });
	const unreadAfterReconnect = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/unread') && response.request().method() === 'POST', { timeout: 15_000 });
	await page.context().setOffline(false);
	await unreadAfterReconnect;
	await expect(quietLink.locator('.itemIndicator')).toHaveClass(/_blink/);
});

test('the narrow channel list drops a channel deleted while the stream was down after reconnecting', async ({ page }) => {
	const room = await createGroup('Reconnect delete');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	const quiet = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'beta' });
	await api(base, 'chat/rooms/notifications', { i: member.token, roomId: room.id, channelId: quiet.id, level: 'mentions' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: 'plain note' });

	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await trackSockets(page);
	await open(page, path(room.id));
	const list = page.getByRole('navigation', { name: 'Channels' });
	const generalLink = list.locator(`a[href="${path(room.id, general.id)}"]`);
	const quietLink = list.locator(`a[href="${path(room.id, quiet.id)}"]`);
	await expect(generalLink).toBeVisible();
	await expect(quietLink.locator('.itemIndicator')).toBeVisible();
	await expect(quietLink.locator('.itemIndicator')).not.toHaveClass(/_blink/);

	// 끊긴 동안 그룹장이 실제 API로 맨 위 채널을 삭제하고, 남은 채널에 멘션이 도착한다.
	await cutStream(page);
	await api(base, 'chat/rooms/channels/delete', { i: owner.token, channelId: general.id });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: `ping @${member.username}` });
	const unreadAfterReconnect = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/unread') && response.request().method() === 'POST', { timeout: 15_000 });
	await page.context().setOffline(false);
	await unreadAfterReconnect;
	await expect(generalLink).toHaveCount(0);
	await expect(quietLink.locator('.itemIndicator')).toHaveClass(/_blink/);
});

test('the wide rail drops a channel deleted while the stream was down after reconnecting', async ({ page }) => {
	const room = await createGroup('Reconnect rail delete');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	const quiet = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'beta' });
	const loud = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'gamma' });
	await api(base, 'chat/rooms/notifications', { i: member.token, roomId: room.id, channelId: quiet.id, level: 'mentions' });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: quiet.id, text: 'plain note' });

	await page.setViewportSize({ width: 2000, height: 1000 });
	await login(page, member, 'en-US');
	await trackSockets(page);
	// 구독 기준(맨 위 general)이 아닌 quiet 대화를 열어 레일을 본다.
	await open(page, path(room.id, quiet.id));
	const rail = page.getByRole('navigation', { name: 'Channels' });
	const generalLink = rail.locator(`a[href="${path(room.id, general.id)}"]`);
	const loudLink = rail.locator(`a[href="${path(room.id, loud.id)}"]`);
	await expect(generalLink).toBeVisible();
	await expect(loudLink.locator('.itemIndicator')).toHaveCount(0);

	await cutStream(page);
	await api(base, 'chat/rooms/channels/delete', { i: owner.token, channelId: general.id });
	await api(base, 'chat/messages/create-to-room', { i: owner.token, toRoomId: room.id, toRoomChannelId: loud.id, text: `ping @${member.username}` });
	const unreadAfterReconnect = page.waitForResponse(response => response.url().endsWith('/api/chat/rooms/unread') && response.request().method() === 'POST', { timeout: 15_000 });
	await page.context().setOffline(false);
	await unreadAfterReconnect;
	await expect(generalLink).toHaveCount(0);
	await expect(loudLink.locator('.itemIndicator')).toHaveClass(/_blink/);
	await expect(page).toHaveURL(base + path(room.id, quiet.id));
});

// 화면 쌓기(experimental.stackingRouterView)에서는 이전 페이지가 마운트된 채 남는다.
async function enableStacking(page: Page) {
	await page.addInitScript(() => {
		const raw = localStorage.getItem('preferences');
		const profile = raw ? JSON.parse(raw) : { preferences: {} };
		profile.preferences ??= {};
		profile.preferences['experimental.stackingRouterView'] = [[{}, true, {}]];
		localStorage.setItem('preferences', JSON.stringify(profile));
	});
}

// 좁은 목록을 스택 뒤에 남기고 설정 화면을 앞에 둔다(실제 화면 조작).
async function leaveListBehind(page: Page) {
	await page.locator('button:has(.ti-messages)').click();
	await expect(page).toHaveURL(base + '/chat');
	const navButton = page.locator('button:has(img)').first();
	await expect(navButton).toBeVisible();
	await navButton.click();
	const settingsLink = page.getByRole('link', { name: 'Settings' });
	await expect(settingsLink).toBeVisible();
	await settingsLink.click();
	await expect(page).toHaveURL(/\/settings(\/|$)/);
}

// 연결 복구를 기다린 뒤, 뒤 목록의 재조회가 없는지 관찰 창으로 확인한다.
async function reconnectAndExpectNoListReread(page: Page, roomId: string) {
	const roomShows: number[] = [];
	page.on('request', request => {
		if (new URL(request.url()).pathname === '/api/chat/rooms/show' && request.postDataJSON()?.roomId === roomId) roomShows.push(Date.now());
	});
	const wsCountAtCut = await page.evaluate(() => (window as unknown as SocketTrackingWindow).__ws.length);
	const mark = Date.now();
	await page.context().setOffline(false);
	// 단절 뒤 새로 생긴 소켓이 열릴 때까지 기다린다(재연결 성공 신호).
	await expect.poll(() => page.evaluate(n => {
		const sockets = (window as unknown as SocketTrackingWindow).__ws;
		return sockets.slice(n).some(s => s.readyState === WebSocket.OPEN);
	}, wsCountAtCut), { timeout: 15_000 }).toBe(true);
	const openAt = Date.now();
	// 복구 뒤 뒤 목록의 방 조회가 없어야 한다. 3초는 관찰 창, 10초는 실패 상한이다.
	await expect.poll(async () => {
		if (roomShows.some(t => t >= mark)) return 'reread';
		return Date.now() - openAt >= 3000 ? 'quiet' : 'waiting';
	}, { timeout: 10_000, intervals: [250] }).toBe('quiet');
	return mark;
}

test('a stacked channel list behind another screen keeps the current screen on reconnect after its room was deleted', async ({ page }) => {
	const room = await createGroup('Weekend catchup');
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	await trackSockets(page);
	await open(page, path(room.id));
	await expect(channelLink(page, 'general')).toBeVisible();
	await leaveListBehind(page);

	// 끊긴 동안 그룹장이 실제 API로 그룹을 삭제한다.
	await cutStream(page);
	await api(base, 'chat/rooms/delete', { i: owner.token, roomId: room.id });
	await reconnectAndExpectNoListReread(page, room.id);

	await expect(page).toHaveURL(/\/settings(\/|$)/);
	await expect(page.getByText('The room was deleted')).toHaveCount(0);
});

test('returning to a stacked channel list reads the latest state and handles the deleted room', async ({ page }) => {
	const room = await createGroup('Morning notes');
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	await trackSockets(page);
	await open(page, path(room.id));
	await expect(channelLink(page, 'general')).toBeVisible();
	await leaveListBehind(page);

	await cutStream(page);
	await api(base, 'chat/rooms/delete', { i: owner.token, roomId: room.id });
	const mark = await reconnectAndExpectNoListReread(page, room.id);
	await expect(page).toHaveURL(/\/settings(\/|$)/);
	const okButton = page.locator('[data-testid="modal-dialog-ok"]');
	if (await okButton.isVisible().catch(() => false)) await okButton.click();

	// 스택 탭을 닫아 목록이 앞에 오게 한다.
	const roomShows: number[] = [];
	page.on('request', request => {
		if (new URL(request.url()).pathname === '/api/chat/rooms/show' && request.postDataJSON()?.roomId === room.id) roomShows.push(Date.now());
	});
	await page.locator('button:has(.ti-x)').last().click();
	await page.waitForURL(url => url.href === base + '/chat' || url.href.startsWith(base + path(room.id)), { timeout: 10_000 });
	if (page.url() === base + '/chat' && await page.locator('button:has(.ti-x)').count() > 0) {
		await page.locator('button:has(.ti-x)').last().click();
	}

	// 돌아온 시점에 최신 상태를 읽어 삭제 안내를 표시하고 목록을 닫는다.
	await expect(page.getByText('The room was deleted')).toBeVisible({ timeout: 10_000 });
	await expect(page).toHaveURL(base + '/chat');
	expect(roomShows.some(t => t >= mark)).toBe(true);
});

test('a stacked channel rail and conversation behind another screen keep the current screen on reconnect after their room was deleted', async ({ page }) => {
	const room = await createGroup('Evening catchup');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	await page.setViewportSize({ width: 2000, height: 1000 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	await trackSockets(page);
	await open(page, path(room.id, general.id));
	await expect(page.getByRole('navigation', { name: 'Channels' })).toBeVisible();
	// 넓은 화면에서는 설정 링크가 사이드바에 있다.
	await page.locator('a[href="/settings"]').first().click();
	await expect(page).toHaveURL(/\/settings(\/|$)/);

	await cutStream(page);
	await api(base, 'chat/rooms/delete', { i: owner.token, roomId: room.id });
	await reconnectAndExpectNoListReread(page, room.id);
	await expect(page).toHaveURL(/\/settings(\/|$)/);
	await expect(page.getByText('The room was deleted')).toHaveCount(0);

	// 스택 탭 닫기로 레일과 대화에 돌아오면 그때 삭제를 처리한다.
	// 레일과 대화가 각각 삭제 안내를 띄울 수 있으므로 첫 안내로 확인한다.
	await page.locator('button:has(.ti-x)').last().click();
	await expect(page.getByText('The room was deleted').first()).toBeVisible({ timeout: 10_000 });
	await expect(page).toHaveURL(base + '/chat');
});

// 연결 중 실시간 이벤트가 뒤에 남은 화면에 닿았는지 프레임으로 확인한다(고정 대기가 아닌 도착 신호).
function trackStreamTypes(page: Page) {
	const types: string[] = [];
	page.on('websocket', ws => ws.on('framereceived', ev => {
		try {
			const frame = JSON.parse(ev.payload.toString());
			// 채널 이벤트는 {type:'channel', body:{type, body}} 형태로 온다.
			if (frame.type === 'channel' && frame.body?.type) types.push(frame.body.type);
			else if (frame.type) types.push(frame.type);
		} catch { /* JSON 외 프레임은 기록하지 않는다. */ }
	}));
	return types;
}

// 뒤에 남은 화면이 실시간 이벤트 뒤에도 현재 화면을 바꾸지 않는지 관찰 창으로 확인한다.
async function expectFrontStays(page: Page, urlRe: RegExp) {
	const start = Date.now();
	await expect.poll(async () => {
		if (!urlRe.test(page.url())) return 'navigated';
		if (await page.locator('[data-testid="modal-dialog-ok"]').count() > 0) return 'dialog';
		return Date.now() - start >= 2500 ? 'stable' : 'waiting';
	}, { timeout: 12_000, intervals: [250] }).toBe('stable');
}

test('a stacked channel list behind another screen keeps the current screen when its room is deleted while connected', async ({ page }) => {
	const room = await createGroup('Connected deletion list');
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	const types = trackStreamTypes(page);
	await open(page, path(room.id));
	await expect(channelLink(page, 'general')).toBeVisible();
	await leaveListBehind(page);

	// 연결된 상태에서 그룹장이 실제 API로 그룹을 삭제한다.
	await api(base, 'chat/rooms/delete', { i: owner.token, roomId: room.id });
	await expect.poll(() => types.includes('roomDeleted'), { timeout: 10_000 }).toBe(true);
	await expectFrontStays(page, /\/settings(\/|$)/);
	await expect(page.getByText('The room was deleted')).toHaveCount(0);

	// 스택 탭을 닫아 목록으로 돌아오면 그때 삭제를 처리한다(중간 /chat 탭이 있으면 함께 닫는다).
	await page.locator('button:has(.ti-x)').last().click();
	await page.waitForURL(url => url.href === base + '/chat' || url.href.startsWith(base + path(room.id)), { timeout: 10_000 });
	if (page.url() === base + '/chat' && await page.locator('button:has(.ti-x)').count() > 0) {
		await page.locator('button:has(.ti-x)').last().click();
	}
	await expect(page.getByText('The room was deleted')).toBeVisible({ timeout: 10_000 });
	await expect(page).toHaveURL(base + '/chat');
});

test('a stacked channel list behind another screen keeps the current screen when its member is removed while connected', async ({ page }) => {
	const room = await createGroup('Connected removal list');
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	const types = trackStreamTypes(page);
	await open(page, path(room.id));
	await expect(channelLink(page, 'general')).toBeVisible();
	await leaveListBehind(page);

	await api(base, 'chat/rooms/kick', { i: owner.token, roomId: room.id, userId: member.id });
	await expect.poll(() => types.includes('membershipEnded'), { timeout: 10_000 }).toBe(true);
	await expectFrontStays(page, /\/settings(\/|$)/);

	await page.locator('button:has(.ti-x)').last().click();
	await page.waitForURL(url => url.href === base + '/chat' || url.href.startsWith(base + path(room.id)), { timeout: 10_000 });
	if (page.url() === base + '/chat' && await page.locator('button:has(.ti-x)').count() > 0) {
		await page.locator('button:has(.ti-x)').last().click();
	}
	await expect(page.getByText('This room cannot be opened.', { exact: false })).toBeVisible({ timeout: 10_000 });
	await expect(page).toHaveURL(base + '/chat');
});

test('a stacked channel rail and conversation behind another screen keep the current screen when their room is deleted while connected', async ({ page }) => {
	const room = await createGroup('Connected deletion rail');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	await page.setViewportSize({ width: 2000, height: 1000 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	const types = trackStreamTypes(page);
	await open(page, path(room.id, general.id));
	await expect(page.getByRole('navigation', { name: 'Channels' })).toBeVisible();
	await page.locator('a[href="/settings"]').first().click();
	await expect(page).toHaveURL(/\/settings(\/|$)/);

	await api(base, 'chat/rooms/delete', { i: owner.token, roomId: room.id });
	await expect.poll(() => types.includes('roomDeleted'), { timeout: 10_000 }).toBe(true);
	await expectFrontStays(page, /\/settings(\/|$)/);
	await expect(page.getByText('The room was deleted')).toHaveCount(0);

	// 레일과 대화가 각각 안내를 띄울 수 있으므로 첫 안내로 확인한다.
	await page.locator('button:has(.ti-x)').last().click();
	await expect(page.getByText('The room was deleted').first()).toBeVisible({ timeout: 10_000 });
	await expect(page).toHaveURL(base + '/chat');
});

test('a stacked plain group conversation behind another screen keeps the current screen when converted to channels while connected', async ({ page }) => {
	const room = await createGroup('Connected conversion', false);
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page, member, 'en-US');
	await enableStacking(page);
	const types = trackStreamTypes(page);
	await open(page, `/chat/room/${room.id}`);
	await expect(page.getByPlaceholder('Enter message here')).toBeInViewport();
	await page.locator('a[href="/settings"]').first().click();
	await expect(page).toHaveURL(/\/settings(\/|$)/);

	await api(base, 'chat/rooms/convert-to-channels', { i: owner.token, roomId: room.id });
	await expect.poll(() => types.includes('channelsUpdated'), { timeout: 10_000 }).toBe(true);
	await expectFrontStays(page, /\/settings(\/|$)/);

	// 돌아온 시점의 재초기화가 맨 위 채널을 연다.
	const first = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	await page.locator('button:has(.ti-x)').last().click();
	await expect(page).toHaveURL(base + path(room.id, first.id), { timeout: 10_000 });
});

test('long channel names wrap within the rail and the narrow list', async ({ page }) => {
	const room = await createGroup('Weekend notes');
	const general = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	const longName = 'abcdefghijklmnopqrstuvwxyz'.repeat(5).slice(0, 128);
	const long = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: longName });
	const measure = (nav: Locator) => nav.evaluate(navEl => {
		const container = navEl.closest('aside') ?? navEl;
		const cr = container.getBoundingClientRect();
		const items = [...navEl.querySelectorAll('.item')].map(item => {
			const text = item.querySelector('.text')!;
			const tr = text.getBoundingClientRect();
			return { length: text.textContent!.length, height: tr.height, rightOver: +(tr.right - cr.right).toFixed(1) };
		});
		return { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth, pageScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, items };
	});

	await page.setViewportSize({ width: 2000, height: 1000 });
	for (const account of [owner, member]) {
		await login(page, account, 'en-US');
		await open(page, path(room.id, general.id));
		const rail = page.getByRole('navigation', { name: 'Channels' });
		await expect(rail.locator(`a[href="${path(room.id, long.id)}"]`)).toBeVisible();
		const wide = await measure(rail);
		expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
		const longItem = wide.items.find(item => item.length === 128)!;
		expect(longItem.rightOver).toBeLessThanOrEqual(0);
		expect(longItem.height).toBeGreaterThan(30);
	}

	await page.setViewportSize({ width: 390, height: 844 });
	await login(page, owner, 'en-US');
	await open(page, path(room.id));
	const grid = page.getByRole('navigation', { name: 'Channels' });
	await expect(grid.locator(`a[href="${path(room.id, long.id)}"]`)).toBeVisible();
	const narrow = await measure(grid);
	expect(narrow.pageScrollWidth).toBeLessThanOrEqual(narrow.innerWidth);
	expect(narrow.items.find(item => item.length === 128)!.height).toBeGreaterThan(30);
});

test('a newly accepted invitation opens the first channel conversation', async ({ page }) => {
	const room = await api(base, 'chat/rooms/create', { i: owner.token, name: 'Join channels' });
	await api(base, 'chat/rooms/convert-to-channels', { i: owner.token, roomId: room.id });
	const first = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	await api(base, 'chat/rooms/invitations/create', { i: owner.token, roomId: room.id, userId: member.id });
	await login(page, member);
	await page.goto(`${base}/chat/room/${room.id}`);
	await expect(page.getByText('Do you accept the invitation?', { exact: false })).toBeVisible();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(page).toHaveURL(base + path(room.id, first.id));
	await expect(page.getByPlaceholder('Enter message here')).toBeInViewport();
	await page.getByText('About', { exact: true }).click();
	await expect(page.getByRole('button', { name: 'Create channel', exact: true })).toHaveCount(0);
});

test('deleted current and direct channel addresses return to the first remaining channel', async ({ page }) => {
	const room = await createGroup('Deletion');
	const first = (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room.id }))[0];
	const selected = await api(base, 'chat/rooms/channels/create', { i: owner.token, roomId: room.id, name: 'Delete me' });
	await login(page);
	await open(page, path(room.id, selected.id));
	await expect(page.getByPlaceholder('Enter message here')).toBeInViewport();
	await api(base, 'chat/rooms/channels/delete', { i: owner.token, channelId: selected.id });
	await expect(page.getByText('This channel was deleted. Opening the first remaining channel.', { exact: true })).toBeVisible();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(page).toHaveURL(base + path(room.id, first.id));
	await page.goto(base + path(room.id, selected.id));
	await expect(page.getByText('This channel was deleted. Opening the first remaining channel.', { exact: true })).toBeVisible();
	await page.getByTestId('modal-dialog-ok').click();
	await expect(page).toHaveURL(base + path(room.id, first.id));
});

test('search covers every channel and can filter one channel through the product select', async ({ page }) => {
	await login(page);
	await open(page, path(group.id, channels[1].id));
	await page.locator('button[aria-label="Menu"]:not([data-chat-message-id] button)').click();
	await page.getByRole('menuitem', { name: /Search$/ }).click();
	await page.getByPlaceholder('Search messages').fill('scope needle');
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(page.getByText('scope needle general', { exact: true })).toBeVisible();
	await expect(page.getByText('scope needle work', { exact: true })).toBeVisible();
	await page.getByText('All channels', { exact: true }).locator('xpath=ancestor::div[@tabindex="0"][1]').click();
	await page.getByText('#work · 2', { exact: true }).click();
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(page.getByText('scope needle general', { exact: true })).toHaveCount(0);
	await expect(page.getByText('scope needle work', { exact: true })).toBeVisible();
});

for (const name of ['channel', 'group', 'individual'] as const) test(`the narrow composer keeps its controls usable in a ${name} conversation`, async ({ page }, testInfo) => {
	await login(page);
	const room = name === 'individual' ? null : await createGroup(`Composer ${name}`, name === 'channel');
	const channel = name === 'channel' ? (await api(base, 'chat/rooms/channels/list', { i: owner.token, roomId: room!.id }))[0] : null;
	const other = name === 'individual'
		? await api(base, 'signup', { username: 'composeruser', password: 'composer-test-password' }) as Account
		: member;
	if (name === 'individual') await api(base, 'i/update', { i: other.token, chatScope: 'everyone' });
	for (let index = 0; index < 16; index++) {
		const sender = index % 2 === 0 ? owner : other;
		const text = `composer history ${index}`;
		if (name === 'channel') await api(base, 'chat/messages/create-to-room', { i: sender.token, toRoomId: room!.id, toRoomChannelId: channel.id, text });
		else if (name === 'group') await api(base, 'chat/messages/create-to-room', { i: sender.token, toRoomId: room!.id, text });
		else await api(base, 'chat/messages/create-to-user', { i: sender.token, toUserId: sender.id === owner.id ? other.id : owner.id, text });
	}
	const target = name === 'channel' ? path(room!.id, channel.id) : name === 'group' ? `/chat/room/${room!.id}` : `/chat/user/${other.id}`;
	const endpoint = name === 'individual' ? 'create-to-user' : 'create-to-room';
	for (const height of [844, 1000]) {
		await page.setViewportSize({ width: 390, height });
		await open(page, target);
		const file = page.getByRole('button', { name: 'Select a file', exact: true });
		const emoji = page.getByRole('button', { name: 'Emoji', exact: true });
		const sendButton = page.getByRole('button', { name: 'Send', exact: true });
		const layout = await file.evaluate(element => {
			const result: object[] = [];
			for (let node: Element | null = element; node; node = node.parentElement) {
				const rect = node.getBoundingClientRect();
				const style = getComputedStyle(node);
				result.push({ tag: node.tagName, className: node.getAttribute('class'), top: rect.top, height: rect.height, scrollHeight: node.scrollHeight, overflowY: style.overflowY, position: style.position });
			}
			return result;
		});
		await testInfo.attach(`composer-layout-${name}-${height}`, { body: JSON.stringify(layout), contentType: 'application/json' });
		await expect(file).toBeInViewport({ ratio: 1 });
		await expect(emoji).toBeInViewport({ ratio: 1 });
		await expect(sendButton).toBeInViewport({ ratio: 1 });
		const sendBounds = await sendButton.boundingBox();
		const navigationBounds = await page.locator('button:has(i.ti-messages)').filter({ hasNotText: 'Messages' }).boundingBox();
		expect(sendBounds).not.toBeNull();
		expect(navigationBounds).not.toBeNull();
		expect(Math.abs(sendBounds!.y + sendBounds!.height - navigationBounds!.y)).toBeLessThanOrEqual(2);
		await file.click();
		await expect(page.getByText('Upload', { exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await emoji.click();
		await expect(page.locator('.omfetrab').getByPlaceholder('Search')).toBeVisible();
		await page.keyboard.press('Escape');
		const text = `narrow composer ${name} ${height}`;
		await page.getByPlaceholder('Enter message here').fill(text);
		await expect(page.locator('#splash')).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath(`composer-${name}-${height}.png`), fullPage: false });
		const response = page.waitForResponse(result => result.url().endsWith(`/api/chat/messages/${endpoint}`) && result.request().method() === 'POST');
		await sendButton.click();
		expect((await response).status()).toBe(200);
		await expect(page.getByText(text, { exact: true })).toBeVisible();
	}
});

for (const width of [390, 820, 1600]) {
	for (const theme of ['light', 'dark'] as const) {
		test(`channel, ordinary group and individual conversation at ${width}px in ${theme}`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 1000 });
			await page.emulateMedia({ colorScheme: theme });
			await login(page);
			for (const [name, target, text] of [
				['channel', path(group.id, channels[1].id), 'scope needle work'],
				['ordinary', `/chat/room/${ordinary.id}`, 'ordinary group message'],
				['individual', `/chat/user/${member.id}`, 'individual message'],
			]) {
				await open(page, target);
				await expect(page.getByText(text, { exact: true })).toBeVisible();
				await expect(page.getByPlaceholder('Enter message here')).toBeInViewport();
				await expect(page.locator('html')).toHaveAttribute('data-color-scheme', theme);
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
				await expect(page.locator('#splash')).toHaveCount(0);
				await page.screenshot({ path: testInfo.outputPath(`${name}-${width}-${theme}.png`), fullPage: true });
			}
		});
	}
}
