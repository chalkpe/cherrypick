/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';

const LOCAL = 'https://local.test';

type TestUser = {
	id: string;
	host: string | null;
	uri: string | null;
	keyId: string;
	privateKeyPem: string;
	publicKeyPem: string;
};

function createUser(id: string, host: string | null, uri: string | null): TestUser {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	return {
		id,
		host,
		uri,
		keyId: `${uri}#main-key`,
		privateKeyPem: privateKey,
		publicKeyPem: publicKey,
	};
}

const alice = createUser('alice', null, null);
const carol = createUser('carol', 'remote.test', 'https://remote.test/users/carol');
const bob = createUser('bob', 'other.test', 'https://other.test/users/bob');

const message = {
	id: 'message1',
	fromUserId: alice.id,
	toUserId: carol.id,
	toRoomId: null,
	fileId: null,
	uri: null,
	emojis: [],
};

const roomMessage = {
	...message,
	id: 'message2',
	toUserId: null,
	toRoomId: 'room1',
};

const messages = new Map([message, roomMessage].map(m => [m.id, m]));

function createService(overrides: Record<string, unknown> = {}) {
	const users = new Map([alice, carol, bob].map(user => [user.id, user]));
	const authUsers = new Map([alice, carol, bob].map(user => [user.keyId, {
		user,
		key: { keyPem: user.publicKeyPem },
	}]));

	return Object.assign(Object.create(ActivityPubServerService.prototype), {
		config: {
			host: new URL(LOCAL).host,
			url: LOCAL,
		},
		meta: { federation: 'all' },
		chatMessagesRepository: {
			findOneBy: async (where: { id: string }) => messages.get(where.id) ?? null,
		},
		usersRepository: {
			findOneBy: async (where: { id: string }) => users.get(where.id) ?? null,
		},
		activityPubAccessControlService: {
			checkAccess: async () => null,
			extractHostFromKeyId: (keyId: string) => new URL(keyId).hostname,
			checkHostAccess: async () => null,
		},
		apDbResolverService: {
			getAuthUserFromKeyId: async (keyId: string) => authUsers.get(keyId) ?? null,
		},
		apRendererService: {
			addContext: (object: unknown) => object,
			renderChatMessage: async () => ({ id: `${LOCAL}/chat/messages/${message.id}`, type: 'Note', content: 'secret' }),
		},
		queueService: {
			inbox: () => {},
		},
		...overrides,
	}) as ActivityPubServerService;
}

async function signedHeaders(user: TestUser, options: { date?: string } = {}): Promise<Record<string, string>> {
	const url = `${LOCAL}/chat/messages/${message.id}`;
	const signed = await ApRequestCreator.createSignedGet({
		key: { keyId: user.keyId, privateKeyPem: user.privateKeyPem },
		url,
		additionalHeaders: options.date == null ? {} : { date: options.date },
	});

	return {
		...signed.request.headers,
		host: new URL(url).host,
		accept: 'application/activity+json',
	};
}

/**
 * Builds a draft-cavage HTTP Signature by hand, so that individual parts can be tampered with.
 */
function handSignedHeaders(signer: TestUser, options: {
	keyId?: string;
	signedPath?: string;
	host?: string;
	date?: Date;
	include?: string[];
} = {}): Record<string, string> {
	const host = options.host ?? new URL(LOCAL).host;
	const date = (options.date ?? new Date()).toUTCString();
	const include = options.include ?? ['(request-target)', 'date', 'host'];
	const values: Record<string, string> = {
		'(request-target)': `get ${options.signedPath ?? `/chat/messages/${message.id}`}`,
		date,
		host,
	};
	const signingString = include.map(name => `${name}: ${values[name]}`).join('\n');
	const signature = crypto.sign('sha256', Buffer.from(signingString), signer.privateKeyPem).toString('base64');

	return {
		date,
		host,
		accept: 'application/activity+json',
		signature: `keyId="${options.keyId ?? signer.keyId}",algorithm="rsa-sha256",headers="${include.join(' ')}",signature="${signature}"`,
	};
}

async function startApp(overrides: Record<string, unknown> = {}) {
	const app = Fastify();
	const service = createService(overrides);
	await app.register((instance, _options, done) => {
		service.createServer(instance, {}, done);
	});
	await app.ready();
	return app;
}

describe('ActivityPub chat message fetch authorization', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = await startApp();
	});

	afterEach(async () => {
		await app.close();
	});

	test('does not return a message to an unsigned request', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: { accept: 'application/activity+json' },
		});

		expect(response.statusCode).toBe(404);
	});

	test('does not return a message to an unrelated signed actor', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: await signedHeaders(bob),
		});

		expect(response.statusCode).toBe(404);
	});

	test('returns the message to a participant without public caching', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: await signedHeaders(carol),
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ type: 'Note', content: 'secret' });
		expect(response.headers['cache-control']).toBe('private, no-store');
	});
});

describe('ActivityPub chat message fetch authorization: edge cases', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = await startApp();
	});

	afterEach(async () => {
		await app.close();
	});

	async function fetchMessage(headers: Record<string, string>, id = message.id) {
		return await app.inject({ method: 'GET', url: `/chat/messages/${id}`, headers });
	}

	test('accepts a well-formed hand-built signature from a participant', async () => {
		// Guards the helper below: the 404s in this block must come from the tampering, not from a broken signature.
		const response = await fetchMessage(handSignedHeaders(carol));

		expect(response.statusCode).toBe(200);
	});

	test('does not accept a participant\'s keyId signed with another actor\'s key', async () => {
		const response = await fetchMessage(handSignedHeaders(bob, { keyId: carol.keyId }));

		expect(response.statusCode).toBe(404);
		expect(response.body).not.toContain('secret');
	});

	test('does not accept a participant\'s signature replayed against another path', async () => {
		const response = await fetchMessage(handSignedHeaders(carol, { signedPath: '/chat/messages/other' }));

		expect(response.statusCode).toBe(404);
	});

	test('does not accept a signature that does not cover the host header', async () => {
		const response = await fetchMessage(handSignedHeaders(carol, { include: ['(request-target)', 'date'] }));

		expect(response.statusCode).toBe(404);
	});

	test('does not accept a signature that does not cover the date header', async () => {
		const response = await fetchMessage(handSignedHeaders(carol, { include: ['(request-target)', 'host'] }));

		expect(response.statusCode).toBe(404);
	});

	test('does not accept a signature made for another host', async () => {
		const response = await fetchMessage(handSignedHeaders(carol, { host: 'evil.test' }));

		expect(response.statusCode).toBe(404);
	});

	test('does not accept a stale signature', async () => {
		const response = await fetchMessage(handSignedHeaders(carol, { date: new Date(Date.now() - 60 * 60 * 1000) }));

		expect(response.statusCode).toBe(404);
	});

	test('does not return a group room message even to a signed actor', async () => {
		const response = await fetchMessage(handSignedHeaders(carol, { signedPath: `/chat/messages/${roomMessage.id}` }), roomMessage.id);

		expect(response.statusCode).toBe(404);
	});

	test.each<[string, () => Record<string, string>, string]>([
		['unsigned', () => ({ accept: 'application/activity+json' }), message.id],
		['unrelated signer', () => handSignedHeaders(bob), message.id],
		['missing message', () => handSignedHeaders(carol, { signedPath: '/chat/messages/missing' }), 'missing'],
	])('never allows public caching of a 404 (%s)', async (_label, headers, id) => {
		const response = await fetchMessage(headers(), id);

		expect(response.statusCode).toBe(404);
		expect(response.headers['cache-control']).toBe('private, no-store');
	});
});

describe('ActivityPub chat message fetch authorization: denied requests', () => {
	test.each([
		['federation is disabled', { meta: { federation: 'none' } }],
		['access control denies the request', { activityPubAccessControlService: { checkAccess: async () => ({ reason: 'blocked' }) } }],
	])('does not return a message and is not publicly cached when %s', async (_label, overrides) => {
		const app = await startApp(overrides);
		try {
			const response = await app.inject({ method: 'GET', url: `/chat/messages/${message.id}`, headers: handSignedHeaders(carol) });

			expect(response.statusCode).toBe(403);
			expect(response.body).not.toContain('secret');
			expect(response.headers['cache-control']).toBe('private, no-store');
		} finally {
			await app.close();
		}
	});
});

const OLD_DATE = new Date(Date.now() - 60 * 60 * 1000).toUTCString();

async function postToInbox(
	service: ActivityPubServerService,
	user: TestUser,
	options: { date?: string; xDate?: string } = {},
): Promise<number | undefined> {
	const body = JSON.stringify({ type: 'Create', actor: user.uri });
	const url = `${LOCAL}/inbox`;
	const signed = await ApRequestCreator.createSignedPost({
		key: { keyId: user.keyId, privateKeyPem: user.privateKeyPem },
		url,
		body,
		additionalHeaders: options.date == null ? {} : { date: options.date },
	});
	const headers: Record<string, string> = {
		...signed.request.headers,
		host: new URL(url).host,
	};
	if (options.xDate != null) headers['x-date'] = options.xDate;

	const request = {
		raw: { method: 'POST', url: '/inbox', httpVersion: '1.1', headers },
		headers,
		rawBody: Buffer.from(body),
		body: JSON.parse(body),
	};
	let status: number | undefined;
	const reply = {
		code: (statusCode: number) => {
			status = statusCode;
			return reply;
		},
		header: () => reply,
	};

	await (service as unknown as { inbox: (request: unknown, reply: unknown) => void }).inbox(request, reply);
	return status;
}

describe('ActivityPub signed request date freshness', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = await startApp();
	});

	afterEach(async () => {
		await app.close();
	});

	test('rejects an old signed request even with a fresh unsigned X-Date', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: {
				...await signedHeaders(carol, { date: OLD_DATE }),
				'x-date': new Date().toUTCString(),
			},
		});

		expect(response.statusCode).toBe(404);
	});

	test('rejects an old signed request', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: await signedHeaders(carol, { date: OLD_DATE }),
		});

		expect(response.statusCode).toBe(404);
	});

	test('rejects a signed request with an invalid Date', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: await signedHeaders(carol, { date: 'not-a-date' }),
		});

		expect(response.statusCode).toBe(404);
	});

	test('rejects a signed request without a Date header', async () => {
		const headers = await signedHeaders(carol);
		delete headers.date;

		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers,
		});

		expect(response.statusCode).toBe(404);
	});

	test('rejects a signed request that carries an X-Date header', async () => {
		const response = await app.inject({
			method: 'GET',
			url: `/chat/messages/${message.id}`,
			headers: {
				...await signedHeaders(carol),
				'x-date': new Date().toUTCString(),
			},
		});

		expect(response.statusCode).toBe(404);
	});
});

describe('ActivityPub inbox signed date freshness', () => {
	test('rejects an old signed activity even with a fresh unsigned X-Date', async () => {
		const service = createService();

		const status = await postToInbox(service, carol, { date: OLD_DATE, xDate: new Date().toUTCString() });

		expect(status).toBe(401);
	});

	test('rejects an old signed activity', async () => {
		const service = createService();

		const status = await postToInbox(service, carol, { date: OLD_DATE });

		expect(status).toBe(401);
	});

	test('rejects a signed activity that carries an X-Date header', async () => {
		const service = createService();

		const status = await postToInbox(service, carol, { xDate: new Date().toUTCString() });

		expect(status).toBe(401);
	});

	test('rejects a signed activity with an invalid Date', async () => {
		const service = createService();

		const status = await postToInbox(service, carol, { date: 'not-a-date' });

		expect(status).toBe(401);
	});

	test('accepts a fresh signed activity', async () => {
		const service = createService();

		const status = await postToInbox(service, carol);

		expect(status).toBe(202);
	});
});
