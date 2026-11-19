/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, connectStream, createAppToken, initTestDb, post, signup, successfulApiCall } from '../utils.js';
import type { UserToken } from '../utils.js';

type User = Awaited<ReturnType<typeof signup>>;

const waitUntil = async <T>(fn: () => Promise<T | null | undefined | false>): Promise<T | null> => {
	for (let i = 0; i < 60; i++) {
		const v = await fn();
		if (v) return v;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return null;
};

describe('通知の取得', () => {
	let alice: User;
	let bob: User;
	let carol: User;
	let db: Awaited<ReturnType<typeof initTestDb>>;

	const notificationsOf = async (user: UserToken, endpoint: 'i/notifications' | 'i/notifications-grouped' = 'i/notifications') => {
		const res = await api(endpoint, { limit: 100 }, user);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		return res.body as any[];
	};

	const invite = async (owner: User, member: User, groupId: string) => {
		await successfulApiCall({ endpoint: 'users/groups/invite', parameters: { groupId, userId: member.id }, user: owner }, { status: 204 });
		return await waitUntil(async () => (await notificationsOf(member)).find(x => x.type === 'groupInvited'));
	};

	beforeAll(async () => {
		alice = await signup({ username: 'notifpackalice' });
		bob = await signup({ username: 'notifpackbob' });
		carol = await signup({ username: 'notifpackcarol' });
		db = await initTestDb(true);
	});

	afterAll(async () => {
		if (db?.isInitialized) await db.destroy();
	});

	describe('グループへの招待', () => {
		test('招待したグループを削除しても、招待された人の通知一覧は取得できて他の通知もそのまま出る', async () => {
			const group = await successfulApiCall({ endpoint: 'users/groups/create', parameters: { name: 'invite group' }, user: alice });
			assert.ok(await invite(alice, bob, group.id));
			await post(carol, { text: `hello @${bob.username}` });
			assert.ok(await waitUntil(async () => (await notificationsOf(bob)).find(x => x.type === 'mention')));

			await successfulApiCall({ endpoint: 'users/groups/delete', parameters: { groupId: group.id }, user: alice }, { status: 204 });

			for (const endpoint of ['i/notifications', 'i/notifications-grouped'] as const) {
				const list = await notificationsOf(bob, endpoint);
				assert.ok(list.some(x => x.type === 'mention'), `${endpoint} should keep other notifications`);
				assert.ok(!list.some(x => x.type === 'groupInvited'), `${endpoint} should drop the stale invitation`);
			}
		});

		test('招待の行だけが失われた場合も、その通知だけが省かれる', async () => {
			const group = await successfulApiCall({ endpoint: 'users/groups/create', parameters: { name: 'invite group 2' }, user: alice });
			const notification = await invite(alice, bob, group.id);
			assert.ok(notification);
			await db.query('DELETE FROM "user_group_invitation" WHERE "userGroupId" = $1', [group.id]);

			for (const endpoint of ['i/notifications', 'i/notifications-grouped'] as const) {
				const list = await notificationsOf(bob, endpoint);
				assert.ok(list.some(x => x.type === 'mention'), `${endpoint} should keep other notifications`);
				assert.ok(!list.some(x => x.type === 'groupInvited' && x.id === notification.id));
			}
		});

		test('有効な招待の通知はこれまで通り出る', async () => {
			const group = await successfulApiCall({ endpoint: 'users/groups/create', parameters: { name: 'invite group 3' }, user: alice });
			const notification = await invite(alice, carol, group.id);
			assert.ok(notification);
			assert.strictEqual(notification.invitation.group.id, group.id);
		});
	});

	describe('ログインの通知の ip', () => {
		let appToken: UserToken;

		const signin = async () => {
			const res = await api('signin-flow', { username: 'notifpackalice', password: 'test' } as any);
			assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		};

		beforeAll(async () => {
			appToken = { token: await createAppToken(alice, ['read:notifications', 'read:account']), bearer: true } as UserToken;
			await signin();
			assert.ok(await waitUntil(async () => (await notificationsOf(alice)).find(x => x.type === 'login')));
		});

		test('本人のセッションには ip が載る', async () => {
			for (const endpoint of ['i/notifications', 'i/notifications-grouped'] as const) {
				const login = (await notificationsOf(alice, endpoint)).find(x => x.type === 'login');
				assert.ok(login, endpoint);
				assert.strictEqual(typeof login.ip, 'string', endpoint);
			}
		});

		test('アプリのトークンで読んだ通知には ip が載らない', async () => {
			for (const endpoint of ['i/notifications', 'i/notifications-grouped'] as const) {
				const login = (await notificationsOf(appToken, endpoint)).find(x => x.type === 'login');
				assert.ok(login, endpoint);
				assert.ok(!('ip' in login), `${endpoint} should not carry ip for app tokens`);
			}
		});

		test('ログイン記録のストリームイベントは本人のセッションだけに届く', async () => {
			const ownSignins: { ip: string; headers: Record<string, unknown> }[] = [];
			const appEvents: string[] = [];
			const ownSocket = await connectStream(alice, 'main', msg => {
				if (msg.type === 'signin') ownSignins.push(msg.body);
			});
			const appSocket = await connectStream(appToken, 'main', msg => { appEvents.push(msg.type); });
			try {
				await signin();
				const record = await waitUntil(async () => ownSignins[0]);
				assert.ok(record);
				assert.strictEqual(typeof record.ip, 'string');
				assert.strictEqual(record.headers['content-type'], 'application/json');

				await successfulApiCall({ endpoint: 'following/create', parameters: { userId: alice.id }, user: bob });
				assert.ok(await waitUntil(async () => appEvents.includes('followed')));
				assert.ok(!appEvents.includes('signin'));
			} finally {
				ownSocket.close();
				appSocket.close();
			}
		});

		test('ストリームでは、本人のセッションに ip が載り、アプリのトークンには載らない', async () => {
			const own: any[] = [];
			const app: any[] = [];
			const ownSocket = await connectStream(alice, 'main', msg => { if (msg.type === 'notification') own.push(msg.body); });
			const appSocket = await connectStream(appToken, 'main', msg => { if (msg.type === 'notification') app.push(msg.body); });
			try {
				await signin();
				await waitUntil(async () => own.some(x => x.type === 'login') && app.some(x => x.type === 'login'));
				const ownLogin = own.find(x => x.type === 'login');
				const appLogin = app.find(x => x.type === 'login');
				assert.ok(ownLogin && appLogin);
				assert.strictEqual(typeof ownLogin.ip, 'string');
				assert.ok(!('ip' in appLogin));
			} finally {
				ownSocket.close();
				appSocket.close();
			}
		});

		test('未読の通知のイベントでも、本人のセッションに ip が載り、アプリのトークンには載らない', async () => {
			const own: any[] = [];
			const app: any[] = [];
			const ownSocket = await connectStream(alice, 'main', msg => { if (msg.type === 'unreadNotification') own.push(msg.body); });
			const appSocket = await connectStream(appToken, 'main', msg => { if (msg.type === 'unreadNotification') app.push(msg.body); });
			try {
				await signin();
				await waitUntil(async () => own.some(x => x.type === 'login') && app.some(x => x.type === 'login'));
				const ownLogin = own.find(x => x.type === 'login');
				const appLogin = app.find(x => x.type === 'login');
				assert.ok(ownLogin && appLogin);
				assert.strictEqual(typeof ownLogin.ip, 'string');
				assert.ok(!('ip' in appLogin));
			} finally {
				ownSocket.close();
				appSocket.close();
			}
		});
	});
});
