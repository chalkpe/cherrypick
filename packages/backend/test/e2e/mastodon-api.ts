/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, onTestFinished, test } from 'vitest';
import WebSocket from 'ws';
import { api, port, signup, uploadFile } from '../utils.js';
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

	describe('Pagination, filters and lookups', () => {
		let frank: misskey.entities.SignupResponse;
		let gina: misskey.entities.SignupResponse;
		let hank: misskey.entities.SignupResponse;
		let ivan: misskey.entities.SignupResponse;
		let ginaToken: string;

		beforeAll(async () => {
			frank = await signup({ username: 'frank' });
			gina = await signup({ username: 'gina' });
			hank = await signup({ username: 'hank' });
			ivan = await signup({ username: 'ivan' });
			ginaToken = await issueToken(gina);
		});

		function nextLink(res: Response): string {
			const next = /<([^>]+)>; rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
			assert.ok(next, 'no next link');
			return next;
		}

		async function sendForm(method: string, path: string, accessToken: string, body: URLSearchParams): Promise<Response> {
			return await fetch(`${host}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}` }, body });
		}

		test('shows the administrator as the contact account', async () => {
			const v1 = await (await mastodonGet('/api/v1/instance')).json() as { contact_account: { id: string } | null };
			assert.strictEqual(v1.contact_account?.id, alice.id);
			const v2 = await (await mastodonGet('/api/v2/instance')).json() as { contact: { account: { id: string } | null } };
			assert.strictEqual(v2.contact.account?.id, alice.id);
		});

		test('paginates followers by the follow relations, with links on the public URL', async () => {
			await api('following/create', { userId: frank.id }, hank);
			await api('following/create', { userId: frank.id }, ivan);

			const first = await mastodonGet(`/api/v1/accounts/${frank.id}/followers?limit=1`, ginaToken);
			assert.deepStrictEqual((await first.json() as { id: string }[]).map(a => a.id), [ivan.id]);

			const next = nextLink(first);
			assert.ok(next.startsWith('http://cherrypick.local/api/v1/accounts/'), next);
			const second = await mastodonGet(new URL(next).pathname + new URL(next).search, ginaToken);
			assert.deepStrictEqual((await second.json() as { id: string }[]).map(a => a.id), [hank.id]);
		});

		test('returns the newest statuses newer than since_id, and the oldest ones after min_id', async () => {
			const notes = [];
			for (const text of ['one', 'two', 'three']) {
				notes.push((await api('notes/create', { text }, frank)).body.createdNote);
			}

			const since = await mastodonGet(`/api/v1/accounts/${frank.id}/statuses?since_id=${notes[0].id}&limit=1`, ginaToken);
			assert.deepStrictEqual((await since.json() as { id: string }[]).map(s => s.id), [notes[2].id]);

			const min = await mastodonGet(`/api/v1/accounts/${frank.id}/statuses?min_id=${notes[0].id}&limit=2`, ginaToken);
			assert.deepStrictEqual((await min.json() as { id: string }[]).map(s => s.id), [notes[2].id, notes[1].id]);
		});

		test('filters notifications by type before paginating', async () => {
			await api('notes/create', { text: `@${gina.username} filter me` }, hank);
			await api('following/create', { userId: gina.id }, hank);

			// The follow is the newest notification, so a single notification page only has the mention after filtering on the Misskey side
			await waitFor(async () => {
				const all = await (await mastodonGet('/api/v1/notifications?limit=1', ginaToken)).json() as { type: string }[];
				return all[0]?.type === 'follow';
			});

			const v1 = await (await mastodonGet('/api/v1/notifications?types[]=mention&limit=1', ginaToken)).json() as { type: string }[];
			assert.deepStrictEqual(v1.map(n => n.type), ['mention']);

			const v2 = await (await mastodonGet('/api/v2/notifications?types[]=mention&limit=1', ginaToken)).json() as { notification_groups: { type: string }[] };
			assert.deepStrictEqual(v2.notification_groups.map(g => g.type), ['mention']);
		});

		test('lists notifications of new statuses from subscribed accounts', async () => {
			await api('following/create', { userId: ivan.id }, gina);
			await api('following/update', { userId: ivan.id, notify: 'normal' }, gina);
			const note = (await api('notes/create', { text: 'subscribed' }, ivan)).body.createdNote;

			const notification = await waitFor(async () => {
				const list = await (await mastodonGet('/api/v1/notifications?types[]=status', ginaToken)).json() as { type: string; status?: { id: string } }[];
				return list.find(n => n.status?.id === note.id);
			});
			assert.strictEqual(notification.type, 'status');
		});

		test('adds and removes list members sent as account_ids[] in a form body', async () => {
			const list = await (await sendForm('POST', '/api/v1/lists', ginaToken, new URLSearchParams({ title: 'members' }))).json() as { id: string };

			const added = await sendForm('POST', `/api/v1/lists/${list.id}/accounts`, ginaToken, new URLSearchParams([['account_ids[]', frank.id], ['account_ids[]', hank.id]]));
			assert.strictEqual(added.status, 200);
			const members = await (await mastodonGet(`/api/v1/lists/${list.id}/accounts`, ginaToken)).json() as { id: string }[];
			assert.deepStrictEqual(members.map(a => a.id).sort(), [frank.id, hank.id].sort());

			const removed = await sendForm('DELETE', `/api/v1/lists/${list.id}/accounts`, ginaToken, new URLSearchParams([['account_ids[]', hank.id]]));
			assert.strictEqual(removed.status, 200);
			const left = await (await mastodonGet(`/api/v1/lists/${list.id}/accounts`, ginaToken)).json() as { id: string }[];
			assert.deepStrictEqual(left.map(a => a.id), [frank.id]);
		});

		test('shows a quote whose quoted status the viewer cannot see', async () => {
			// Gina does not follow Frank, but sees the quote as it mentions her
			const quoted = (await api('notes/create', { text: 'followers only', visibility: 'followers' }, frank)).body.createdNote;
			const quote = (await api('notes/create', { text: `@${gina.username} quoting`, renoteId: quoted.id, visibility: 'followers' }, frank)).body.createdNote;

			const res = await mastodonGet(`/api/v1/statuses/${quote.id}`, ginaToken);
			assert.strictEqual(res.status, 200);
			const status = await res.json() as { id: string; quote: { state: string; quoted_status: unknown } };
			assert.strictEqual(status.id, quote.id);
			assert.deepStrictEqual(status.quote, { state: 'unauthorized', quoted_status: null });
		});

		test('does not fetch a URL in a search without resolve', async () => {
			const res = await mastodonGet(`/api/v2/search?q=${encodeURIComponent('https://remote.invalid/@someone')}&type=accounts`, ginaToken);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual((await res.json() as { accounts: unknown[] }).accounts, []);
		});

		test('answers CORS preflights of token revocation', async () => {
			const res = await fetch(`${host}/oauth/revoke`, {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://client.example',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'content-type',
				},
			});
			assert.strictEqual(res.status, 204);
			assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
		});
	});

	describe('Client compatibility', () => {
		let jack: misskey.entities.SignupResponse;
		let kate: misskey.entities.SignupResponse;
		let liam: misskey.entities.SignupResponse;
		let jackToken: string;

		beforeAll(async () => {
			jack = await signup({ username: 'jack' });
			kate = await signup({ username: 'kate' });
			liam = await signup({ username: 'liam' });
			jackToken = await issueToken(jack);
			await api('following/create', { userId: jack.id }, kate);
		});

		async function send<T = Record<string, unknown>>(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: T; headers: Headers }> {
			const res = await mastodonSend(method, path, jackToken, body);
			const text = await res.text();
			return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
		}

		async function get<T = Record<string, unknown>>(path: string): Promise<T> {
			const res = await send<T>('GET', path);
			assert.strictEqual(res.status, 200, path);
			return res.body;
		}

		test('answers CORS preflights of every method the Mastodon API uses', async () => {
			for (const method of ['PUT', 'PATCH', 'DELETE']) {
				const res = await fetch(`${host}/api/v1/statuses/someid`, {
					method: 'OPTIONS',
					headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization' },
				});
				assert.strictEqual(res.status, 204);
				assert.ok(res.headers.get('access-control-allow-methods')?.includes(method), method);
			}

			const missing = await fetch(`${host}/api/v1/no-such-endpoint`, { method: 'POST', headers: { Origin: 'https://client.example' } });
			assert.strictEqual(missing.status, 404);
			assert.strictEqual(missing.headers.get('access-control-allow-origin'), '*');
		});

		test('searches accounts even when searching notes is not allowed', async () => {
			const body = await get<{ accounts: { id: string }[]; statuses: unknown[] }>('/api/v2/search?q=kate');
			assert.ok(body.accounts.some(a => a.id === kate.id));
			assert.deepStrictEqual(body.statuses, []);
		});

		test('keeps local-only posts on this server', async () => {
			const res = await send<{ id: string }>('POST', '/api/v1/statuses', { status: 'local only', visibility: 'local' });
			assert.strictEqual(res.status, 200);
			const note = (await api('notes/show', { noteId: res.body.id }, jack)).body as { localOnly: boolean; visibility: string };
			assert.strictEqual(note.localOnly, true);
			assert.strictEqual(note.visibility, 'public');
		});

		test('marks the media sensitive instead of hiding the text', async () => {
			const file = (await uploadFile(jack)).body!;
			const res = await send<{ spoiler_text: string; sensitive: boolean }>('POST', '/api/v1/statuses', { status: 'with media', media_ids: [file.id], sensitive: true });
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.spoiler_text, '');
			assert.strictEqual(res.body.sensitive, true);
			const shown = (await api('drive/files/show', { fileId: file.id }, jack)).body as { isSensitive: boolean };
			assert.strictEqual(shown.isSensitive, true);
		});

		test('schedules statuses instead of posting them', async () => {
			const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const created = await send<{ id: string; scheduled_at: string; params: { text: string } }>('POST', '/api/v1/statuses', { status: 'posted later', scheduled_at: at });
			assert.strictEqual(created.status, 200);
			assert.strictEqual(created.body.params.text, 'posted later');

			const listed = await get<{ id: string }[]>('/api/v1/scheduled_statuses');
			assert.ok(listed.some(s => s.id === created.body.id));
			const posted = await get<{ content: string }[]>(`/api/v1/accounts/${jack.id}/statuses`);
			assert.ok(!posted.some(s => s.content.includes('posted later')));

			const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
			const moved = await send<{ scheduled_at: string }>('PUT', `/api/v1/scheduled_statuses/${created.body.id}`, { scheduled_at: later });
			assert.strictEqual(moved.status, 200);
			assert.strictEqual(new Date(moved.body.scheduled_at).getTime(), new Date(later).getTime());

			assert.strictEqual((await send('DELETE', `/api/v1/scheduled_statuses/${created.body.id}`)).status, 200);
			assert.ok(!(await get<{ id: string }[]>('/api/v1/scheduled_statuses')).some(s => s.id === created.body.id));
		});

		test('lists replies of an account unless they are excluded', async () => {
			const target = (await api('notes/create', { text: 'reply to me' }, kate)).body.createdNote;
			const reply = (await api('notes/create', { text: 'a reply', replyId: target.id }, jack)).body.createdNote;

			assert.ok((await get<{ id: string }[]>(`/api/v1/accounts/${jack.id}/statuses`)).some(s => s.id === reply.id));
			assert.ok(!(await get<{ id: string }[]>(`/api/v1/accounts/${jack.id}/statuses?exclude_replies=true`)).some(s => s.id === reply.id));
		});

		test('reports whether statuses are bookmarked, pinned and muted', async () => {
			const note = (await api('notes/create', { text: 'state of mine' }, jack)).body.createdNote;
			type State = { bookmarked: boolean; pinned: boolean; muted: boolean };

			assert.strictEqual((await send<State>('POST', `/api/v1/statuses/${note.id}/bookmark`)).body.bookmarked, true);
			assert.strictEqual((await send<State>('POST', `/api/v1/statuses/${note.id}/pin`)).body.pinned, true);
			assert.strictEqual((await send<State>('POST', `/api/v1/statuses/${note.id}/mute`)).body.muted, true);

			const shown = await get<State>(`/api/v1/statuses/${note.id}`);
			assert.deepStrictEqual([shown.bookmarked, shown.pinned, shown.muted], [true, true, true]);

			assert.strictEqual((await send<State>('POST', `/api/v1/statuses/${note.id}/unmute`)).body.muted, false);
			assert.strictEqual((await send<State>('POST', `/api/v1/statuses/${note.id}/unpin`)).body.pinned, false);
			assert.strictEqual((await send<State>('POST', `/api/v1/statuses/${note.id}/unbookmark`)).body.bookmarked, false);
		});

		test('changes the options of a follow by following again', async () => {
			type Relationship = { following: boolean; notifying: boolean; showing_reblogs: boolean };
			const followed = await send<Relationship>('POST', `/api/v1/accounts/${kate.id}/follow`);
			assert.deepStrictEqual([followed.body.following, followed.body.notifying, followed.body.showing_reblogs], [true, false, true]);

			const changed = await send<Relationship>('POST', `/api/v1/accounts/${kate.id}/follow`, { notify: true, reblogs: false });
			assert.strictEqual(changed.status, 200);
			assert.deepStrictEqual([changed.body.notifying, changed.body.showing_reblogs], [true, false]);

			const back = await send<Relationship>('POST', `/api/v1/accounts/${kate.id}/follow`, { notify: false, reblogs: true });
			assert.deepStrictEqual([back.body.notifying, back.body.showing_reblogs], [false, true]);
		});

		test('keeps private notes about accounts', async () => {
			const res = await send<{ note: string }>('POST', `/api/v1/accounts/${kate.id}/note`, { comment: 'met at the conference' });
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.note, 'met at the conference');
			const [relationship] = await get<{ note: string }[]>(`/api/v1/accounts/relationships?id[]=${kate.id}`);
			assert.strictEqual(relationship.note, 'met at the conference');
		});

		test('lists the lists an account is in, and familiar followers', async () => {
			const list = (await send<{ id: string }>('POST', '/api/v1/lists', { title: 'kate list' })).body;
			await send('POST', `/api/v1/lists/${list.id}/accounts`, { account_ids: [kate.id] });
			assert.ok((await get<{ id: string }[]>(`/api/v1/accounts/${kate.id}/lists`)).some(l => l.id === list.id));

			await api('following/create', { userId: liam.id }, jack);
			await api('following/create', { userId: kate.id }, liam);
			const [familiar] = await get<{ id: string; accounts: { id: string }[] }[]>(`/api/v1/accounts/familiar_followers?id[]=${kate.id}`);
			assert.strictEqual(familiar.id, kate.id);
			assert.deepStrictEqual(familiar.accounts.map(a => a.id), [liam.id]);
		});

		test('removes followers', async () => {
			const res = await send<{ followed_by: boolean }>('POST', `/api/v1/accounts/${kate.id}/remove_from_followers`);
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.followed_by, false);
		});

		test('sends a reaction once, as the reaction type the client asks for', async () => {
			const note = (await api('notes/create', { text: 'react to me' }, jack)).body.createdNote;
			await api('notes/reactions/create', { noteId: note.id, reaction: '👍' }, liam);

			type Notification = { type: string; emoji?: string; status?: { id: string } };
			const aware = await waitFor(async () => {
				const list = await get<Notification[]>('/api/v1/notifications?types[]=favourite&types[]=pleroma:emoji_reaction&types[]=reaction');
				const found = list.filter(n => n.status?.id === note.id);
				return found.length > 0 ? found : null;
			});
			assert.deepStrictEqual(aware.map(n => [n.type, n.emoji]), [['pleroma:emoji_reaction', '👍']]);

			const plain = (await get<Notification[]>('/api/v1/notifications?types[]=favourite')).filter(n => n.status?.id === note.id);
			assert.deepStrictEqual(plain.map(n => [n.type, n.emoji]), [['favourite', undefined]]);
		});

		test('shows quotes in the Mastodon 4.5 and Fedibird formats, apart from boosts', async () => {
			const original = (await api('notes/create', { text: 'quote me' }, jack)).body.createdNote;
			await api('notes/create', { renoteId: original.id }, liam);
			const quote = (await api('notes/create', { text: 'quoting jack', renoteId: original.id }, liam)).body.createdNote;

			type Status = { id: string; reblogs_count: number; quotes_count: number; quote: { id: string; state: string; quoted_status: { id: string } }; quote_approval: { current_user: string } };
			const shown = await get<Status>(`/api/v1/statuses/${quote.id}`);
			assert.strictEqual(shown.quote.state, 'accepted');
			assert.strictEqual(shown.quote.quoted_status.id, original.id);
			assert.strictEqual(shown.quote.id, original.id);

			const counted = await get<Status>(`/api/v1/statuses/${original.id}`);
			assert.deepStrictEqual([counted.reblogs_count, counted.quotes_count], [1, 1]);
			assert.strictEqual(counted.quote_approval.current_user, 'automatic');

			const quotes = await get<{ id: string }[]>(`/api/v1/statuses/${original.id}/quotes`);
			assert.deepStrictEqual(quotes.map(q => q.id), [quote.id]);

			type Notification = { type: string; status?: { id: string } };
			const asQuote = await waitFor(async () => (await get<Notification[]>('/api/v1/notifications')).find(n => n.status?.id === quote.id));
			assert.strictEqual(asQuote.type, 'quote');
			const asMention = (await get<Notification[]>('/api/v1/notifications?types[]=mention')).find(n => n.status?.id === quote.id);
			assert.strictEqual(asMention?.type, 'mention');
		});

		test('keeps keyword filters in the word mutes of the user', async () => {
			type Filter = { id: string; title: string; filter_action: string; keywords: { id: string; keyword: string }[] };
			const created = await send<Filter>('POST', '/api/v2/filters', { title: 'spoilers', context: ['home'], filter_action: 'warn', keywords_attributes: [{ keyword: 'Spoiler', whole_word: false }] });
			assert.strictEqual(created.status, 200);
			const i = (await api('i', {}, jack)).body as { mutedWords: unknown[] };
			assert.deepStrictEqual(i.mutedWords, ['/Spoiler/i']);

			// Ice Cubes adds keywords with query parameters
			const keyword = await send<{ id: string; keyword: string }>('POST', `/api/v2/filters/${created.body.id}/keywords?keyword=leak&whole_word=true`);
			assert.strictEqual(keyword.body.keyword, 'leak');

			const note = (await api('notes/create', { text: 'a spoiler here' }, kate)).body.createdNote;
			const status = await get<{ filtered: { filter: { id: string }; keyword_matches: string[] }[] }>(`/api/v1/statuses/${note.id}`);
			assert.deepStrictEqual(status.filtered.map(f => [f.filter.id, f.keyword_matches]), [[created.body.id, ['Spoiler']]]);

			assert.strictEqual((await get<unknown[]>('/api/v1/filters')).length, 2);
			assert.strictEqual((await send('DELETE', `/api/v2/filters/keywords/${keyword.body.id}`)).status, 200);
			assert.deepStrictEqual((await get<Filter>(`/api/v2/filters/${created.body.id}`)).keywords.map(k => k.keyword), ['Spoiler']);

			assert.strictEqual((await send('DELETE', `/api/v2/filters/${created.body.id}`)).status, 200);
			assert.deepStrictEqual(((await api('i', {}, jack)).body as { mutedWords: unknown[] }).mutedWords, []);
		});

		test('describes the instance for clients that enable features by version', async () => {
			const instance = await get<{ version: string; api_versions: { mastodon: number }; thumbnail: { url: string } }>('/api/v2/instance');
			assert.ok(instance.version.startsWith('4.5.0 '));
			assert.strictEqual(instance.api_versions.mastodon, 7);
			assert.ok(instance.thumbnail.url.startsWith('http'));
			assert.ok(Array.isArray(await get('/api/v1/instance/rules')));
		});

		test('shows hashtags, which cannot be followed', async () => {
			const tag = await get<{ name: string; following: boolean }>('/api/v1/tags/cherrypick');
			assert.deepStrictEqual([tag.name, tag.following], ['cherrypick', false]);
			assert.strictEqual((await send('POST', '/api/v1/tags/cherrypick/follow')).status, 422);
		});

		test('takes reports and domain blocks', async () => {
			const report = await send<{ target_account: { id: string } }>('POST', '/api/v1/reports', { account_id: liam.id, comment: 'spam' });
			assert.strictEqual(report.status, 200);
			assert.strictEqual(report.body.target_account.id, liam.id);

			assert.strictEqual((await send('POST', '/api/v1/domain_blocks', { domain: 'bad.example' })).status, 200);
			assert.deepStrictEqual(await get('/api/v1/domain_blocks'), ['bad.example']);
			assert.strictEqual((await send('DELETE', '/api/v1/domain_blocks', { domain: 'bad.example' })).status, 200);
			assert.deepStrictEqual(await get('/api/v1/domain_blocks'), []);
		});
	});

	describe('Profiles and relationships edited from clients', () => {
		let mia: misskey.entities.SignupResponse;
		let nick: misskey.entities.SignupResponse;
		let olga: misskey.entities.SignupResponse;
		let miaToken: string;

		beforeAll(async () => {
			mia = await signup({ username: 'mia' });
			nick = await signup({ username: 'nick' });
			olga = await signup({ username: 'olga' });
			miaToken = await issueToken(mia);
			await api('following/create', { userId: mia.id }, nick);
		});

		async function send<T = Record<string, unknown>>(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: T }> {
			const res = await mastodonSend(method, path, miaToken, body);
			const text = await res.text();
			return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
		}

		async function get<T>(path: string): Promise<T> {
			const res = await send<T>('GET', path);
			assert.strictEqual(res.status, 200, path);
			return res.body;
		}

		async function patchForm<T>(form: FormData): Promise<{ status: number; body: T }> {
			const res = await fetch(`${host}/api/v1/accounts/update_credentials`, { method: 'PATCH', headers: { Authorization: `Bearer ${miaToken}` }, body: form });
			return { status: res.status, body: await res.json() as T };
		}

		async function image(): Promise<Blob> {
			return new Blob([new Uint8Array(await readFile(new URL('../resources/192.jpg', import.meta.url)))], { type: 'image/jpeg' });
		}

		test('edits every part of the profile from a multipart form, as mobile clients do', async () => {
			const form = new FormData();
			form.append('display_name', 'Mia ✨');
			// Browsers send the line breaks of multipart forms as CRLF
			form.append('note', 'first line\r\nsecond line');
			form.append('fields_attributes[0][name]', 'Website');
			form.append('fields_attributes[0][value]', 'https://example.com');
			form.append('fields_attributes[1][name]', 'Pronouns');
			form.append('fields_attributes[1][value]', 'they/them');
			// Emptied rows are dropped, as in Mastodon
			form.append('fields_attributes[2][name]', '');
			form.append('fields_attributes[2][value]', '');
			form.append('locked', 'true');
			form.append('discoverable', 'false');
			form.append('bot', 'true');
			form.append('hide_collections', 'true');
			form.append('source[privacy]', 'private');
			form.append('source[sensitive]', 'true');
			form.append('avatar', await image(), 'avatar.jpg');
			form.append('header', await image(), 'header.jpg');

			type Credential = {
				display_name: string; locked: boolean; bot: boolean; discoverable: boolean; hide_collections: boolean; followers_count: number;
				source: { note: string; privacy: string; sensitive: boolean; fields: { name: string; value: string }[] };
			};
			const res = await patchForm<Credential>(form);
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.display_name, 'Mia ✨');
			assert.strictEqual(res.body.source.note, 'first line\nsecond line');
			assert.deepStrictEqual(res.body.source.fields.map(f => [f.name, f.value]), [['Website', 'https://example.com'], ['Pronouns', 'they/them']]);
			assert.deepStrictEqual([res.body.locked, res.body.bot, res.body.discoverable, res.body.hide_collections], [true, true, false, true]);
			assert.deepStrictEqual([res.body.source.privacy, res.body.source.sensitive], ['private', true]);
			// Hidden followers are still counted for the user
			assert.strictEqual(res.body.followers_count, 1);

			const me = (await api('i', {}, mia)).body as { avatarId: string | null; bannerId: string | null };
			assert.ok(me.avatarId);
			assert.ok(me.bannerId);
		});

		test('posts with the default visibility kept in the profile source', async () => {
			assert.strictEqual((await send('PATCH', '/api/v1/accounts/update_credentials', { source: { privacy: 'unlisted' } })).status, 200);
			assert.strictEqual((await get<Record<string, unknown>>('/api/v1/preferences'))['posting:default:visibility'], 'unlisted');
			const posted = await send<{ visibility: string }>('POST', '/api/v1/statuses', { status: 'default visibility' });
			assert.strictEqual(posted.body.visibility, 'unlisted');
		});

		test('clears the name and bio, and rejects a field without a value', async () => {
			assert.strictEqual((await send('PATCH', '/api/v1/accounts/update_credentials', { display_name: '', note: '' })).status, 200);
			const me = (await api('i', {}, mia)).body as { name: string | null; description: string | null };
			assert.deepStrictEqual([me.name, me.description], [null, null]);

			const invalid = await send('PATCH', '/api/v1/accounts/update_credentials', { fields_attributes: [{ name: 'Only a name', value: '' }] });
			assert.strictEqual(invalid.status, 422);
		});

		test('rejects more than four files in one request instead of hanging', async () => {
			const form = new FormData();
			for (let i = 0; i < 5; i++) form.append(`file${i}`, await image(), `${i}.jpg`);
			const res = await patchForm<{ error: string; error_description: string }>(form);
			assert.strictEqual(res.status, 413);
			assert.strictEqual(res.body.error_description, 'TOO_MANY_FILES');
		});

		test('ignores trailing slashes, and answers errors in the Mastodon format', async () => {
			// Moshidon lists mutes at "/api/v1/mutes/"
			assert.strictEqual((await send('GET', '/api/v1/mutes/?limit=80')).status, 200);

			const unknown = await send('GET', '/api/v1/no-such-endpoint');
			assert.deepStrictEqual([unknown.status, unknown.body], [404, { error: 'Not Found' }]);

			// Clients show "error" to the user, and take a 404 as a deleted status
			const missing = await send<{ error: string; error_description: string }>('GET', '/api/v1/statuses/aaaaaaaaaaaaaaaa');
			assert.deepStrictEqual([missing.status, missing.body.error, missing.body.error_description], [404, 'No such note.', 'NO_SUCH_NOTE']);
		});

		test('mutes for a while, and keeps the private note in every relationship', async () => {
			await send('POST', `/api/v1/accounts/${olga.id}/note`, { comment: 'olga note' });
			type Relationship = { muting: boolean; blocking: boolean; note: string };
			type Muted = { id: string; mute_expires_at: string | null };

			const muted = await send<Relationship>('POST', `/api/v1/accounts/${olga.id}/mute`, { duration: 3600 });
			assert.deepStrictEqual([muted.body.muting, muted.body.note], [true, 'olga note']);
			const expiresAt = (await get<Muted[]>('/api/v1/mutes')).find(a => a.id === olga.id)?.mute_expires_at;
			const remaining = new Date(expiresAt ?? 0).getTime() - Date.now();
			assert.ok(remaining > 3500 * 1000 && remaining <= 3600 * 1000, String(expiresAt));

			// Muting again replaces the duration
			assert.strictEqual((await send('POST', `/api/v1/accounts/${olga.id}/mute`, { duration: 0 })).status, 200);
			assert.strictEqual((await get<Muted[]>('/api/v1/mutes')).find(a => a.id === olga.id)?.mute_expires_at, null);

			const unmuted = await send<Relationship>('POST', `/api/v1/accounts/${olga.id}/unmute`);
			assert.deepStrictEqual([unmuted.body.muting, unmuted.body.note], [false, 'olga note']);

			// Blocking and unblocking succeed when repeated, as in Mastodon
			for (const action of ['block', 'block', 'unblock', 'unblock']) {
				const res = await send<Relationship>('POST', `/api/v1/accounts/${olga.id}/${action}`);
				assert.strictEqual(res.status, 200, action);
				assert.deepStrictEqual([res.body.blocking, res.body.note], [action === 'block', 'olga note']);
			}
		});

		test('withdraws a follow request by unfollowing', async () => {
			await api('i/update', { isLocked: true }, olga);
			type Relationship = { following: boolean; requested: boolean };
			const requested = await send<Relationship>('POST', `/api/v1/accounts/${olga.id}/follow`);
			assert.deepStrictEqual([requested.body.following, requested.body.requested], [false, true]);

			for (let i = 0; i < 2; i++) {
				const res = await send<Relationship>('POST', `/api/v1/accounts/${olga.id}/unfollow`);
				assert.strictEqual(res.status, 200);
				assert.deepStrictEqual([res.body.following, res.body.requested], [false, false]);
			}
		});

		test('lists the media of an account', async () => {
			const file = (await uploadFile(mia)).body!;
			const withMedia = (await api('notes/create', { text: 'with a photo', fileIds: [file.id] }, mia)).body.createdNote;
			await api('notes/create', { text: 'without a photo' }, mia);
			const listed = await get<{ id: string }[]>(`/api/v1/accounts/${mia.id}/statuses?only_media=true`);
			assert.deepStrictEqual(listed.map(s => s.id), [withMedia.id]);
		});

		test('marks local-only statuses, and shows the polls of scheduled statuses', async () => {
			const local = await send<{ visibility: string; local_only: boolean }>('POST', '/api/v1/statuses', { status: 'local', visibility: 'local' });
			assert.deepStrictEqual([local.body.visibility, local.body.local_only], ['public', true]);

			type Scheduled = { id: string; params: { poll: { options: string[]; expires_in: string; multiple: boolean; hide_totals: boolean } | null } };
			const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const scheduled = await send<Scheduled>('POST', '/api/v1/statuses', { status: 'vote later', scheduled_at: at, poll: { options: ['a', 'b'], expires_in: 600, multiple: true } });
			assert.strictEqual(scheduled.status, 200);
			assert.deepStrictEqual(scheduled.body.params.poll, { options: ['a', 'b'], expires_in: '600', multiple: true, hide_totals: false });
			assert.strictEqual((await send('DELETE', `/api/v1/scheduled_statuses/${scheduled.body.id}`)).status, 200);
		});

		test('keeps filters that only blur media', async () => {
			const created = await send<{ id: string; filter_action: string }>('POST', '/api/v2/filters', { title: 'blur', filter_action: 'blur', keywords_attributes: [{ keyword: 'blurme', whole_word: true }] });
			assert.strictEqual(created.body.filter_action, 'blur');
			// Misskey has no word mutes that only blur media, so the soft ones hold it
			assert.deepStrictEqual(((await api('i', {}, mia)).body as { mutedWords: unknown[] }).mutedWords, ['/\\bblurme\\b/i']);

			const note = (await api('notes/create', { text: 'please blurme now' }, nick)).body.createdNote;
			const status = await get<{ filtered: { filter: { filter_action: string } }[] }>(`/api/v1/statuses/${note.id}`);
			assert.deepStrictEqual(status.filtered.map(f => f.filter.filter_action), ['blur']);
			assert.strictEqual((await send('DELETE', `/api/v2/filters/${created.body.id}`)).status, 200);
		});

		test('puts the category of a report into its comment', async () => {
			const note = (await api('notes/create', { text: 'reported' }, olga)).body.createdNote;
			assert.strictEqual((await send('POST', '/api/v1/reports', { account_id: olga.id, status_ids: [note.id], comment: 'bad', category: 'spam' })).status, 200);

			// alice signed up first, so she is the administrator
			const reports = (await api('admin/abuse-user-reports', {}, alice)).body as { targetUserId: string; comment: string }[];
			const comment = reports.find(r => r.targetUserId === olga.id)?.comment ?? '';
			assert.ok(comment.startsWith('[spam]\nbad\n') && comment.endsWith(`/notes/${note.id}`), comment);
		});

		test('suggests neither the user themselves nor the accounts they follow', async () => {
			const pat = await signup({ username: 'pat' });
			await api('following/create', { userId: pat.id }, mia);

			const accounts = (await get<{ id: string }[]>('/api/v1/suggestions?limit=80')).map(a => a.id);
			const entries = (await get<{ account: { id: string } }[]>('/api/v2/suggestions?limit=80')).map(e => e.account.id);
			for (const ids of [accounts, entries]) {
				assert.ok(ids.includes(nick.id));
				assert.ok(!ids.includes(mia.id));
				assert.ok(!ids.includes(pat.id));
			}
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
				const latestLog = async () => ((await api('admin/show-moderation-logs', { limit: 1 }, alice)).body as { id: string }[])[0]?.id;
				const before = await latestLog();
				await api('admin/update-meta', { enableServiceWorker: false }, alice);
				// The moderation log is written after the response, so wait for it before the test server shuts down
				await waitFor(async () => (await latestLog()) !== before);
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
