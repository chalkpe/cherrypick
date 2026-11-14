/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { api, resetState, ADMIN_SETUP_PASSWORD } from './shared.js';
import type { Page } from 'playwright';
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
	await Promise.allSettled(evidence.responses);
	await testInfo.attach('chat-http-stream', { body: JSON.stringify(evidence.records, null, 2), contentType: 'application/json' });
});

test('narrow navigation has separate group, channel and conversation depths', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await open(page, '/chat');
	await page.locator(`a[href="${path(group.id)}"]`).click();
	await expect(page).toHaveURL(base + path(group.id));
	await expect(page.getByPlaceholder('Enter message here')).toHaveCount(0);
	await page.getByRole('link', { name: '#work', exact: true }).click();
	await expect(page).toHaveURL(base + path(group.id, channels[1].id));
	await expect(page.getByText('scope needle work', { exact: true })).toBeVisible();
	await page.locator('button:has(.ti-arrow-left):visible').last().click();
	await expect(page).toHaveURL(base + path(group.id));
	await expect(page.getByRole('link', { name: '#general', exact: true })).toBeVisible();
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
	await page.getByRole('link', { name: '#general', exact: true }).click();
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
	await expect(page.getByRole('link', { name: '#work', exact: true })).toBeVisible();
	await page.getByRole('link', { name: '#general', exact: true }).click();
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
