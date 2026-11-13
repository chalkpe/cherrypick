/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test, expect } from './fixtures.js';
import { api, signIn as signInAt } from './shared.js';
import { BASE_URL, resetState, registerUser, signIn } from './utils.js';
import type { RegisteredUser } from './utils.js';
import type { Page, TestInfo } from '@playwright/test';

type Room = { id: string; name: string };
type InviteLink = { url: string; code: string; createdAt: string };

const VIEWPORTS = [
	{ name: 'narrow', width: 390, height: 844 },
	{ name: 'medium', width: 820, height: 1180 },
	{ name: 'wide', width: 1600, height: 1000 },
] as const;
const COLOR_SCHEMES = ['light', 'dark'] as const;

async function createRoom(owner: RegisteredUser, name: string, description: string): Promise<Room> {
	return await api(BASE_URL, 'chat/rooms/create', { i: owner.token, name, description }) as Room;
}

async function createLink(owner: RegisteredUser, room: Room): Promise<InviteLink> {
	return await api(BASE_URL, 'chat/rooms/invite-link/create', { i: owner.token, roomId: room.id }) as InviteLink;
}

async function memberIds(owner: RegisteredUser, room: Room): Promise<string[]> {
	const members = await api(BASE_URL, 'chat/rooms/members', { i: owner.token, roomId: room.id, limit: 100 }) as { userId: string }[];
	return members.map(member => member.userId);
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.describe('Group invite links', () => {
	let owner: RegisteredUser;
	let bob: RegisteredUser;
	let carol: RegisteredUser;
	let dave: RegisteredUser;
	let erin: RegisteredUser;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		owner = await registerUser('alice', 'alice1234');
		bob = await registerUser('bob', 'bob12345');
		carol = await registerUser('carol', 'carol1234');
		dave = await registerUser('dave', 'dave12345');
		erin = await registerUser('erin', 'erin12345');
		for (const user of [owner, bob, carol, dave, erin]) {
			await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
			await api(BASE_URL, 'i/update', { i: user.token, chatScope: 'everyone' });
		}
	});

	test.describe('the owner', () => {
		test.use({ viewport: { width: 1280, height: 800 } });

		for (const kind of ['plain', 'channels'] as const) {
			test(`keeps one active link, issued and revoked as separate actions (${kind} group)`, async ({ page, context }) => {
				const room = await createRoom(owner, `manage ${kind} ${Date.now()}`, 'Shapes only.');
				if (kind === 'channels') await api(BASE_URL, 'chat/rooms/convert-to-channels', { i: owner.token, roomId: room.id });
				await context.grantPermissions(['clipboard-read', 'clipboard-write']);
				await signIn(page, 'alice', 'alice1234');

				await page.goto(`${BASE_URL}/chat/room/${room.id}`);
				// 그룹 정보 탭(About)에서 관리한다
				await page.getByText('About', { exact: true }).click();
				await expect(page.getByText('No invite link has been issued.')).toBeVisible();

				await page.getByRole('button', { name: 'Issue invite link' }).click();
				const shown = page.getByText(/\/chat\/invite\/[0-9A-Za-z]{16}$/);
				await expect(shown).toBeVisible();
				await expect(page.getByRole('button', { name: 'Issue invite link' })).toHaveCount(0);
				const issued = await api(BASE_URL, 'chat/rooms/invite-link/show', { i: owner.token, roomId: room.id }) as InviteLink;
				await expect(shown).toHaveText(issued.url);

				await page.getByRole('button', { name: 'Copy link' }).click();
				expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issued.url);

				await page.getByRole('button', { name: 'Revoke invite link' }).click();
				await page.getByTestId('modal-dialog-ok').click();
				await expect(page.getByText('No invite link has been issued.')).toBeVisible();
				// 폐기한 뒤 저절로 다시 발급하지 않는다
				expect(await api(BASE_URL, 'chat/rooms/invite-link/show', { i: owner.token, roomId: room.id })).toBeNull();
			});
		}

		test('sees the link of an archived group but has to unarchive it to issue or revoke', async ({ page }) => {
			const room = await createRoom(owner, `archived ${Date.now()}`, '');
			const link = await createLink(owner, room);
			await api(BASE_URL, 'chat/rooms/update', { i: owner.token, roomId: room.id, isArchived: true });
			await signIn(page, 'alice', 'alice1234');

			await page.goto(`${BASE_URL}/chat/room/${room.id}`);
			await page.getByText('About', { exact: true }).click();
			await expect(page.getByText(link.url)).toBeVisible();

			await expect(page.getByRole('button', { name: 'Revoke invite link' })).toBeDisabled();
			await expect(page.getByText('Unarchive the room to issue or revoke its invite link.')).toBeVisible();
		});
	});

	test.describe('the invite page opened directly', () => {
		test('shows only the name, description and member count to a visitor, and joins nobody', async ({ browser }, testInfo) => {
			const room = await createRoom(owner, `square club ${Date.now()}`, 'We talk about squares.');
			const link = await createLink(owner, room);
			const before = await memberIds(owner, room);
			const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
			const page = await context.newPage();
			const joinRequests: string[] = [];
			page.on('request', request => {
				if (request.url().endsWith('/api/chat/invite-link/join')) joinRequests.push(request.url());
			});

			await page.goto(link.url);

			await expect(page.getByText(room.name)).toBeVisible();
			await expect(page.getByText('We talk about squares.')).toBeVisible();
			await expect(page.getByText(`${before.length + 1} members`)).toBeVisible();
			await expect(page.getByText('alice')).toHaveCount(0);
			await shot(page, testInfo, 'invite-page-visitor');

			await page.getByRole('button', { name: 'Join' }).click();
			await expect(page.getByTestId('signin-page-input')).toBeVisible();
			expect(joinRequests).toEqual([]);
			expect(await memberIds(owner, room)).toEqual(before);
			await context.close();
		});

		test('lets a signed-in account join and opens the group, then offers to open it again', async ({ page }) => {
			const room = await createRoom(owner, `direct join ${Date.now()}`, '');
			const link = await createLink(owner, room);
			await signIn(page, 'bob', 'bob12345');

			await page.goto(link.url);
			await page.getByRole('button', { name: 'Join' }).click();

			await expect(page).toHaveURL(new RegExp(`/chat/room/${room.id}`));
			expect(await memberIds(owner, room)).toContain(bob.id);

			await page.goto(link.url);
			await expect(page.getByRole('button', { name: 'Open room' })).toBeVisible();
			await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);
		});

		test('says why it cannot join', async ({ page }) => {
			const blockedRoom = await createRoom(owner, `blocked ${Date.now()}`, '');
			const blockedLink = await createLink(owner, blockedRoom);
			await api(BASE_URL, 'blocking/create', { i: owner.token, userId: erin.id });
			const archivedRoom = await createRoom(owner, `archived join ${Date.now()}`, '');
			const archivedLink = await createLink(owner, archivedRoom);
			await api(BASE_URL, 'chat/rooms/update', { i: owner.token, roomId: archivedRoom.id, isArchived: true });
			const revokedRoom = await createRoom(owner, `revoked ${Date.now()}`, '');
			const revokedLink = await createLink(owner, revokedRoom);
			await api(BASE_URL, 'chat/rooms/invite-link/revoke', { i: owner.token, roomId: revokedRoom.id });
			await signIn(page, 'erin', 'erin12345');

			await page.goto(blockedLink.url);
			await page.getByRole('button', { name: 'Join' }).click();
			await expect(page.getByText('You cannot join because the room owner has blocked this account.')).toBeVisible();
			await page.getByTestId('modal-dialog-ok').click();

			await page.goto(archivedLink.url);
			await page.getByRole('button', { name: 'Join' }).click();
			await expect(page.getByText('You cannot join because the room is archived.')).toBeVisible();
			await page.getByTestId('modal-dialog-ok').click();

			await page.goto(revokedLink.url);
			await expect(page.getByText('The invite link could not be found. It may have been revoked, or the room may have been deleted.')).toBeVisible();

			await api(BASE_URL, 'blocking/delete', { i: owner.token, userId: erin.id });
		});
	});

	test.describe('the card in a note and in a message', () => {
		test('joins from a note in the timeline', async ({ page }) => {
			const room = await createRoom(owner, `timeline card ${Date.now()}`, 'Circles welcome.');
			const link = await createLink(owner, room);
			await api(BASE_URL, 'notes/create', { i: owner.token, text: `Come in ${link.url}`, visibility: 'public' });
			await signIn(page, 'carol', 'carol1234');

			await page.goto(`${BASE_URL}/@alice`);
			const card = page.locator('article', { hasText: room.name }).first();
			await expect(page.getByText(room.name)).toBeVisible();
			await expect(page.getByText(/1 members/)).toBeVisible();
			await page.getByRole('button', { name: 'Join' }).first().click();

			await expect(page).toHaveURL(new RegExp(`/chat/room/${room.id}`));
			expect(await memberIds(owner, room)).toContain(carol.id);
			await expect(card).toHaveCount(0);
		});

		test('joins from a message, and a plain link next to it stays a plain card', async ({ page }) => {
			const room = await createRoom(owner, `message card ${Date.now()}`, '');
			const link = await createLink(owner, room);
			await api(BASE_URL, 'chat/messages/create-to-user', { i: owner.token, toUserId: dave.id, text: `${link.url}\n${BASE_URL}/about` });
			await signIn(page, 'dave', 'dave12345');

			await page.goto(`${BASE_URL}/chat/user/${owner.id}`);
			await expect(page.getByText(room.name)).toBeVisible();
			// 초대가 아닌 링크 카드에는 참여 버튼이 없다
			await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(1);
			await page.getByRole('button', { name: 'Join' }).click();

			await expect(page).toHaveURL(new RegExp(`/chat/room/${room.id}`));
			expect(await memberIds(owner, room)).toContain(dave.id);
		});
	});

	test.describe('looks', () => {
		for (const viewport of VIEWPORTS) {
			for (const colorScheme of COLOR_SCHEMES) {
				test(`card, management and invite page at ${viewport.name} in ${colorScheme}`, async ({ page }, testInfo) => {
					await page.setViewportSize({ width: viewport.width, height: viewport.height });
					await page.emulateMedia({ colorScheme });
					const room = await createRoom(owner, `looks ${viewport.name} ${colorScheme} ${Date.now()}`, 'A long description of triangles, squares and circles that wraps on a narrow screen.');
					const link = await createLink(owner, room);
					await api(BASE_URL, 'notes/create', { i: owner.token, text: `Looks ${link.url}`, visibility: 'public' });
					await signIn(page, 'alice', 'alice1234');

					await page.goto(`${BASE_URL}/@alice`);
					await expect(page.getByText(room.name).first()).toBeVisible();
					await shot(page, testInfo, `card-${viewport.name}-${colorScheme}`);

					await page.goto(`${BASE_URL}/chat/room/${room.id}`);
					await page.getByText('About', { exact: true }).click();
					await expect(page.getByText(link.url)).toBeVisible();
					await shot(page, testInfo, `manage-${viewport.name}-${colorScheme}`);

					await page.goto(link.url);
					await expect(page.getByRole('button', { name: 'Open room' })).toBeVisible();
					await shot(page, testInfo, `invite-page-${viewport.name}-${colorScheme}`);
				});
			}
		}
	});
});

// 다른 서버의 그룹에 카드로 참여하는 흐름. 두 HTTPS 서버가 준비된 검증 환경에서만 돈다
const remote = {
	inviteUrl: process.env.INVITE_E2E_REMOTE_INVITE_URL,
	unsupportedUrl: process.env.INVITE_E2E_UNSUPPORTED_URL,
	userName: process.env.INVITE_E2E_LOCAL_USER,
	password: process.env.INVITE_E2E_LOCAL_PASSWORD,
	baseUrl: process.env.INVITE_E2E_LOCAL_BASE_URL,
};

test.describe('the card for a group on another server', () => {
	test.skip(remote.inviteUrl == null || remote.userName == null || remote.password == null || remote.baseUrl == null, 'needs two HTTPS servers');

	test('requests to join, shows the result from the stream, and keeps it after a reload', async ({ page }) => {
		const joinBodies: unknown[] = [];
		page.on('request', request => {
			if (request.url().endsWith('/api/chat/invite-link/join')) joinBodies.push(request.postDataJSON());
			// 브라우저가 발급 서버로 직접 요청하지 않는다
			if (remote.inviteUrl != null && new URL(request.url()).host === new URL(remote.inviteUrl).host) throw new Error(`direct request to the other server: ${request.url()}`);
		});
		await signInAt(page, remote.baseUrl!, remote.userName!, remote.password!);
		await api(remote.baseUrl!, 'notes/create', { i: process.env.INVITE_E2E_LOCAL_TOKEN, text: `Remote ${remote.inviteUrl}`, visibility: 'public' });

		await page.goto(`${remote.baseUrl}/@${remote.userName}`);
		await page.getByRole('button', { name: 'Join' }).first().click();

		await expect(page.getByRole('button', { name: 'Open room' }).first()).toBeVisible({ timeout: 60_000 });
		expect(joinBodies).toHaveLength(1);
		await page.reload();
		await expect(page.getByRole('button', { name: 'Open room' }).first()).toBeVisible();
	});

	test('keeps a server without support as a plain link', async ({ page }) => {
		test.skip(remote.unsupportedUrl == null, 'needs a server without invite support');
		await signInAt(page, remote.baseUrl!, remote.userName!, remote.password!);
		await api(remote.baseUrl!, 'notes/create', { i: process.env.INVITE_E2E_LOCAL_TOKEN, text: `Old ${remote.unsupportedUrl}`, visibility: 'public' });

		await page.goto(`${remote.baseUrl}/@${remote.userName}`);
		await expect(page.getByText(new URL(remote.unsupportedUrl!).host).first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);
	});
});
