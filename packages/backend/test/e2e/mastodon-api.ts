/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, onTestFinished, test } from 'vitest';
import WebSocket from 'ws';
import { api, port, signup } from '../utils.js';
import type * as misskey from 'cherrypick-js';

const host = `http://127.0.0.1:${port}`;
const redirectUri = 'http://127.0.0.1/callback';

interface RegisteredApp {
	client_id: string;
	client_secret: string;
}

async function registerApp(params: Record<string, string> = {}): Promise<Response> {
	return await fetch(`${host}/api/v1/apps`, {
		method: 'POST',
		body: new URLSearchParams({
			client_name: 'Mastodon API test',
			redirect_uris: redirectUri,
			scopes: 'read write follow',
			...params,
		}),
	});
}

async function requestToken(params: Record<string, string>): Promise<Response> {
	return await fetch(`${host}/oauth/token`, {
		method: 'POST',
		body: new URLSearchParams(params),
	});
}

function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

/**
 * Runs /oauth/authorize and approves the session as the given user, like the web client does.
 * Returns the authorization code handed back to the Mastodon client.
 */
async function authorize(app: RegisteredApp, user: misskey.entities.SignupResponse, extraParams: Record<string, string> = {}): Promise<string> {
	const query = new URLSearchParams({
		client_id: app.client_id,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: 'read write follow',
		state: 'state',
		...extraParams,
	});
	const res = await fetch(`${host}/oauth/authorize?${query}`, { redirect: 'manual' });
	assert.strictEqual(res.status, 302);

	const location = new URL(res.headers.get('location')!);
	assert.strictEqual(location.searchParams.get('mastodon'), 'true');
	assert.strictEqual(location.searchParams.get('redirect_uri'), redirectUri);
	assert.strictEqual(location.searchParams.get('state'), 'state');

	const code = location.pathname.split('/').at(-1)!;
	const accept = await api('auth/accept', { token: code }, user);
	assert.strictEqual(accept.status, 204);

	return code;
}

async function issueToken(user: misskey.entities.SignupResponse): Promise<string> {
	const app = await (await registerApp()).json() as RegisteredApp;
	const code = await authorize(app, user);
	const token = await (await requestToken({
		grant_type: 'authorization_code',
		client_id: app.client_id,
		client_secret: app.client_secret,
		redirect_uri: redirectUri,
		code,
	})).json() as { access_token: string };
	return token.access_token;
}

async function mastodonSend(method: string, path: string, accessToken: string, body?: Record<string, unknown>): Promise<Response> {
	return await fetch(`${host}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>): Promise<T> {
	for (let i = 0; i < 20; i++) {
		const result = await fn();
		if (result) return result;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('condition not met');
}

async function mastodonGet(path: string, accessToken?: string): Promise<Response> {
	return await fetch(`${host}${path}`, {
		headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
	});
}

describe('Mastodon API', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
	}, 1000 * 60 * 2);

	describe('POST /api/v1/apps', () => {
		test('registers an app with the app ID as client_id', async () => {
			const res = await registerApp();
			assert.strictEqual(res.status, 200);

			const body = await res.json() as RegisteredApp & { redirect_uris: string[] };
			assert.ok(body.client_id);
			assert.ok(body.client_secret);
			assert.deepStrictEqual(body.redirect_uris, [redirectUri]);
		});

		test('rejects redirect URIs that would run in this origin', async () => {
			const res = await registerApp({ redirect_uris: 'javascript:alert(1)' });
			assert.strictEqual(res.status, 422);
		});
	});

	describe('OAuth', () => {
		let app: RegisteredApp;

		beforeAll(async () => {
			app = await (await registerApp()).json() as RegisteredApp;
		});

		test('rejects a redirect_uri that was not registered', async () => {
			const query = new URLSearchParams({
				client_id: app.client_id,
				redirect_uri: 'http://127.0.0.1/other',
				response_type: 'code',
			});
			const res = await fetch(`${host}/oauth/authorize?${query}`, { redirect: 'manual' });
			assert.strictEqual(res.status, 400);
			assert.strictEqual((await res.json() as { error: string }).error, 'invalid_request');
		});

		test('issues a token that works with the Mastodon API, only once per code', async () => {
			const code = await authorize(app, alice);

			const tokenParams = {
				grant_type: 'authorization_code',
				client_id: app.client_id,
				client_secret: app.client_secret,
				redirect_uri: redirectUri,
				code,
			};
			const tokenRes = await requestToken(tokenParams);
			assert.strictEqual(tokenRes.status, 200);
			const token = await tokenRes.json() as { access_token: string; token_type: string; scope: string };
			assert.strictEqual(token.token_type, 'Bearer');
			assert.strictEqual(token.scope, 'read write follow');

			const me = await mastodonGet('/api/v1/accounts/verify_credentials', token.access_token);
			assert.strictEqual(me.status, 200);
			assert.strictEqual((await me.json() as { acct: string }).acct, 'alice');

			const appRes = await mastodonGet('/api/v1/apps/verify_credentials', token.access_token);
			assert.strictEqual(appRes.status, 200);
			assert.strictEqual((await appRes.json() as { name: string }).name, 'Mastodon API test');

			const reused = await requestToken(tokenParams);
			assert.strictEqual(reused.status, 400);
			assert.strictEqual((await reused.json() as { error: string }).error, 'invalid_grant');
		});

		test('rejects a wrong client_secret', async () => {
			const code = await authorize(app, alice);
			const res = await requestToken({
				grant_type: 'authorization_code',
				client_id: app.client_id,
				client_secret: 'wrong',
				redirect_uri: redirectUri,
				code,
			});
			assert.strictEqual(res.status, 401);
			assert.strictEqual((await res.json() as { error: string }).error, 'invalid_client');
		});

		test('checks the PKCE code_verifier', async () => {
			const { verifier, challenge } = pkcePair();
			const code = await authorize(app, alice, { code_challenge: challenge, code_challenge_method: 'S256' });

			const params = {
				grant_type: 'authorization_code',
				client_id: app.client_id,
				client_secret: app.client_secret,
				redirect_uri: redirectUri,
				code,
			};

			const wrong = await requestToken({ ...params, code_verifier: 'wrong' });
			assert.strictEqual(wrong.status, 400);

			const right = await requestToken({ ...params, code_verifier: verifier });
			assert.strictEqual(right.status, 200);
		});

		test('revokes a token', async () => {
			const code = await authorize(app, bob);
			const token = await (await requestToken({
				grant_type: 'authorization_code',
				client_id: app.client_id,
				client_secret: app.client_secret,
				redirect_uri: redirectUri,
				code,
			})).json() as { access_token: string };

			const revoke = await fetch(`${host}/oauth/revoke`, {
				method: 'POST',
				body: new URLSearchParams({
					client_id: app.client_id,
					client_secret: app.client_secret,
					token: token.access_token,
				}),
			});
			assert.strictEqual(revoke.status, 200);

			const me = await mastodonGet('/api/v1/accounts/verify_credentials', token.access_token);
			assert.strictEqual(me.status, 401);
		});
	});

	describe('API', () => {
		let aliceToken: string;

		beforeAll(async () => {
			const app = await (await registerApp()).json() as RegisteredApp;
			const code = await authorize(app, alice);
			const token = await (await requestToken({
				grant_type: 'authorization_code',
				client_id: app.client_id,
				client_secret: app.client_secret,
				redirect_uri: redirectUri,
				code,
			})).json() as { access_token: string };
			aliceToken = token.access_token;
		});

		test('posts a status and renders MFM as HTML', async () => {
			const res = await fetch(`${host}/api/v1/statuses`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${aliceToken}` },
				body: new URLSearchParams({ status: 'Hello **world**', visibility: 'public' }),
			});
			assert.strictEqual(res.status, 200);
			const status = await res.json() as { content: string; visibility: string };
			assert.strictEqual(status.content, '<p>Hello <b>world</b></p>');
			assert.strictEqual(status.visibility, 'public');
		});

		test('lists follow notifications, which have no status', async () => {
			await api('following/create', { userId: alice.id }, bob);

			// Notifications are written asynchronously
			let found = false;
			for (let i = 0; i < 20 && !found; i++) {
				const res = await mastodonGet('/api/v1/notifications', aliceToken);
				assert.strictEqual(res.status, 200);
				const notifications = await res.json() as { type: string; account: { acct: string } }[];
				found = notifications.some(n => n.type === 'follow' && n.account.acct === 'bob');
				if (!found) await new Promise(resolve => setTimeout(resolve, 250));
			}
			assert.ok(found);
		});

		test('looks up an account without signing in', async () => {
			const res = await mastodonGet('/api/v1/accounts/lookup?acct=alice');
			assert.strictEqual(res.status, 200);
			assert.strictEqual((await res.json() as { id: string }).id, alice.id);
		});

		test('returns 401 for an unknown token', async () => {
			const res = await mastodonGet('/api/v1/timelines/home', 'unknown-token');
			assert.strictEqual(res.status, 401);
		});
	});

	describe('Streaming', () => {
		let aliceToken: string;

		beforeAll(async () => {
			const app = await (await registerApp()).json() as RegisteredApp;
			const code = await authorize(app, alice);
			const token = await (await requestToken({
				grant_type: 'authorization_code',
				client_id: app.client_id,
				client_secret: app.client_secret,
				redirect_uri: redirectUri,
				code,
			})).json() as { access_token: string };
			aliceToken = token.access_token;
		});

		interface StreamEvent { stream: string[]; event: string; payload: string }

		/**
		 * Connects like masto.js, passing the token as the WebSocket subprotocol.
		 */
		async function connect(query: string): Promise<{ ws: WebSocket; next: (event: string) => Promise<StreamEvent> }> {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/streaming${query}`, aliceToken);
			const received: StreamEvent[] = [];
			const waiters: { event: string; resolve: (e: StreamEvent) => void }[] = [];
			ws.on('message', data => {
				const message = JSON.parse(data.toString()) as StreamEvent;
				const waiter = waiters.find(w => w.event === message.event);
				if (waiter) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(message);
				} else {
					received.push(message);
				}
			});
			await new Promise((resolve, reject) => {
				ws.once('open', resolve);
				ws.once('error', reject);
			});
			assert.strictEqual(ws.protocol, aliceToken);

			const next = (event: string) => new Promise<StreamEvent>((resolve, reject) => {
				const index = received.findIndex(m => m.event === event);
				if (index >= 0) return resolve(received.splice(index, 1)[0]);
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5000);
				waiters.push({ event, resolve: e => { clearTimeout(timer); resolve(e); } });
			});
			return { ws, next };
		}

		test('streams new, edited and deleted statuses of the home timeline', async () => {
			const { ws, next } = await connect('?stream=user');
			try {
				await new Promise(resolve => setTimeout(resolve, 500));
				const note = (await api('notes/create', { text: 'streamed' }, alice)).body.createdNote;

				const update = await next('update');
				assert.deepStrictEqual(update.stream, ['user']);
				assert.strictEqual(JSON.parse(update.payload).id, note.id);

				await api('notes/update', { noteId: note.id, text: 'streamed (edited)', cw: null }, alice);
				const edited = await next('status.update');
				assert.strictEqual(JSON.parse(edited.payload).content, '<p>streamed (edited)</p>');

				await api('notes/delete', { noteId: note.id }, alice);
				const deleted = await next('delete');
				assert.strictEqual(deleted.payload, note.id);
			} finally {
				ws.close();
			}
		});

		test('streams notifications', async () => {
			const { ws, next } = await connect('');
			try {
				ws.send(JSON.stringify({ type: 'subscribe', stream: 'user:notification' }));
				await new Promise(resolve => setTimeout(resolve, 500));

				await api('following/delete', { userId: alice.id }, bob);
				await api('following/create', { userId: alice.id }, bob);

				const notification = await next('notification');
				assert.deepStrictEqual(notification.stream, ['user:notification']);
				const body = JSON.parse(notification.payload) as { type: string; account: { acct: string } };
				assert.strictEqual(body.type, 'follow');
				assert.strictEqual(body.account.acct, 'bob');
			} finally {
				ws.close();
			}
		});

		test('rejects an unknown token', async () => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/streaming?stream=user&access_token=unknown`);
			const status = await new Promise<number>(resolve => {
				ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
			});
			assert.strictEqual(status, 401);
		});
	});

	describe('Notifications and markers', () => {
		let aliceToken: string;
		let carol: misskey.entities.SignupResponse;

		interface Group { group_key: string; type: string; notifications_count: number; sample_account_ids: string[]; status_id: string | null; most_recent_notification_id: string }

		beforeAll(async () => {
			aliceToken = await issueToken(alice);
			carol = await signup({ username: 'carol' });
		});

		async function unreadCount(): Promise<number> {
			const res = await mastodonGet('/api/v2/notifications/unread_count', aliceToken);
			assert.strictEqual(res.status, 200);
			return (await res.json() as { count: number }).count;
		}

		async function latestGroups(): Promise<Group[]> {
			const res = await mastodonGet('/api/v2/notifications?limit=20', aliceToken);
			assert.strictEqual(res.status, 200);
			return (await res.json() as { notification_groups: Group[] }).notification_groups;
		}

		test('groups reactions to the same status as favourites', async () => {
			const note = (await api('notes/create', { text: 'group me' }, alice)).body.createdNote;
			await api('notes/reactions/create', { noteId: note.id, reaction: '👍' }, bob);
			await api('notes/reactions/create', { noteId: note.id, reaction: '🎉' }, carol);

			const group = await waitFor(async () => (await latestGroups()).find(g => g.status_id === note.id && g.notifications_count === 2));
			assert.strictEqual(group.type, 'favourite');
			assert.deepStrictEqual([...group.sample_account_ids].sort(), [bob.id, carol.id].sort());
		});

		test('shows, counts and dismisses single notifications without marking them read', async () => {
			await api('notes/create', { text: `@${alice.username} hi` }, carol);
			const mention = await waitFor(async () => (await latestGroups()).find(g => g.type === 'mention'));

			// Listing notifications must not mark them as read
			assert.ok(await unreadCount() > 0);

			const show = await mastodonGet(`/api/v1/notifications/${mention.most_recent_notification_id}`, aliceToken);
			assert.strictEqual(show.status, 200);
			assert.strictEqual((await show.json() as { type: string }).type, 'mention');

			const group = await mastodonGet(`/api/v2/notifications/${mention.group_key}`, aliceToken);
			assert.strictEqual(group.status, 200);

			const dismiss = await mastodonSend('POST', `/api/v1/notifications/${mention.most_recent_notification_id}/dismiss`, aliceToken);
			assert.strictEqual(dismiss.status, 200);
			const gone = await mastodonGet(`/api/v1/notifications/${mention.most_recent_notification_id}`, aliceToken);
			assert.strictEqual(gone.status, 404);
		});

		test('marks notifications read through the notifications marker, shared with the web client', async () => {
			await api('notes/create', { text: `@${alice.username} marker` }, bob);
			const mention = await waitFor(async () => (await latestGroups()).find(g => g.type === 'mention'));
			assert.ok(await unreadCount() > 0);

			const save = await mastodonSend('POST', '/api/v1/markers', aliceToken, {
				home: { last_read_id: 'somestatusid' },
				notifications: { last_read_id: mention.most_recent_notification_id },
			});
			assert.strictEqual(save.status, 200);

			assert.strictEqual(await unreadCount(), 0);
			const me = await api('i', {}, alice);
			assert.strictEqual((me.body as { hasUnreadNotification: boolean }).hasUnreadNotification, false);

			const markers = await mastodonGet('/api/v1/markers?timeline[]=home&timeline[]=notifications', aliceToken);
			const body = await markers.json() as Record<string, { last_read_id: string; version: number }>;
			assert.strictEqual(body.home.last_read_id, 'somestatusid');
			assert.strictEqual(body.notifications.last_read_id, mention.most_recent_notification_id);
		});

		test('reports no keyword filters', async () => {
			const res = await mastodonGet('/api/v1/filters', aliceToken);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(await res.json(), []);
		});
	});

	describe('Web Push subscriptions', () => {
		let aliceToken: string;
		const subscription = {
			// Refuses connections, so no push ever leaves the machine
			endpoint: 'https://127.0.0.1:1/push',
			keys: {
				// Any valid P-256 public key and 16-byte auth secret
				p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
				auth: 'tBHItJI5svbpez7KI4CCXg',
			},
		};

		beforeAll(async () => {
			aliceToken = await issueToken(alice);
		});

		test('is unavailable until the administrator enables push notifications', async () => {
			const res = await mastodonSend('POST', '/api/v1/push/subscription', aliceToken, { subscription, data: { alerts: { mention: true } } });
			assert.strictEqual(res.status, 422);
		});

		test('creates, updates and removes the subscription of a token', async () => {
			// Misskey's own push rejects the test server's http:// URL as a VAPID subject,
			// so let pushes of earlier notifications (sent 2 seconds late) pass before enabling push, and disable it right after.
			await new Promise(resolve => setTimeout(resolve, 3000));
			// alice signed up first, so she is the administrator
			await api('admin/update-meta', {
				enableServiceWorker: true,
				swPublicKey: 'BKjbdo6Jn1Qb0hCTc6fW3Zx8bfA6Nq6N9eL8C0pfYCNyAkNUYmSmhiWlOXjvLHeM8L5xNwpA6cpp9Ym0T3VYdl8',
				swPrivateKey: 'ZOLlfjg2srqBfv7zzBO8YiZTSN5-jsTpkAv2JtvqSNE',
			}, alice);
			onTestFinished(async () => {
				await api('admin/update-meta', { enableServiceWorker: false }, alice);
			});

			const created = await mastodonSend('POST', '/api/v1/push/subscription', aliceToken, {
				subscription,
				data: { alerts: { mention: true, follow: true }, policy: 'followed' },
			});
			assert.strictEqual(created.status, 200);
			const body = await created.json() as { id: number; alerts: Record<string, boolean>; policy: string; server_key: string };
			assert.strictEqual(typeof body.id, 'number');
			assert.strictEqual(body.alerts.mention, true);
			assert.strictEqual(body.alerts.favourite, false);
			assert.strictEqual(body.policy, 'followed');
			assert.ok(body.server_key);

			const updated = await mastodonSend('PUT', '/api/v1/push/subscription', aliceToken, { data: { alerts: { favourite: true } } });
			assert.strictEqual(((await updated.json()) as { alerts: Record<string, boolean> }).alerts.favourite, true);

			const removed = await mastodonSend('DELETE', '/api/v1/push/subscription', aliceToken);
			assert.strictEqual(removed.status, 200);
			const gone = await mastodonGet('/api/v1/push/subscription', aliceToken);
			assert.strictEqual(gone.status, 404);
		});
	});
});
