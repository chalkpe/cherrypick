/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { Test } from '@nestjs/testing';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import { ActivityPubAccessControlService } from '@/core/ActivityPubAccessControlService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { genRsaKeyPair } from '@/misc/gen-key-pair.js';
import { DI } from '@/di-symbols.js';
import type { MiNote } from '@/models/Note.js';

const LOCAL_HOST = 'test.example.com';
const AP_ACCEPT = 'application/activity+json';

type KeyPair = { publicKey: string; privateKey: string };

type Actor = {
	keyId: string;
	actorUri: string;
	keypair: KeyPair;
};

function createNote(id: string, deliveryTargets: MiNote['deliveryTargets']): MiNote {
	return {
		id,
		userId: 'user1',
		userHost: null,
		uri: null,
		visibility: 'public',
		localOnly: false,
		renoteId: null,
		replyId: null,
		text: `text of ${id}`,
		cw: null,
		fileIds: [],
		poll: null,
		deliveryTargets,
	} as unknown as MiNote;
}

/**
 * ActivityPubServerService のルートを実際の Fastify に登録し、
 * 本物の ActivityPubAccessControlService / UtilityService を通して検証するためのハーネス。
 * DB・リモート取得は行わず、鍵は ApDbResolverService のモックで既知のものだけを返す。
 */
describe('ActivityPub delivery targets and access control (routes)', () => {
	let fastify: FastifyInstance;
	let notes: Map<string, MiNote>;
	let pinnedNoteIds: string[];
	let fanoutNotes: MiNote[];
	let knownKeys: Map<string, { user: { uri: string; host: string }; key: { keyPem: string } }>;
	let meta: { federation: string; blockedHosts: string[]; silencedHosts: string[]; enableFanoutTimeline: boolean };
	let instancesRepository: { findOneBy: ReturnType<typeof vi.fn> };
	let queueService: { inbox: ReturnType<typeof vi.fn> };
	let dbWhereClauses: string[];

	let allowedActor: Actor;
	let otherActor: Actor;
	let blockedActor: Actor;

	beforeAll(async () => {
		const [allowedKeys, otherKeys, blockedKeys] = await Promise.all([genRsaKeyPair(), genRsaKeyPair(), genRsaKeyPair()]);
		allowedActor = { keyId: 'https://allowed.example/users/alice#main-key', actorUri: 'https://allowed.example/users/alice', keypair: allowedKeys };
		otherActor = { keyId: 'https://other.example/users/bob#main-key', actorUri: 'https://other.example/users/bob', keypair: otherKeys };
		blockedActor = { keyId: 'https://blocked.example/users/eve#main-key', actorUri: 'https://blocked.example/users/eve', keypair: blockedKeys };
	});

	function registerKey(actor: Actor, overrides?: { actorUri?: string; keyPem?: string }) {
		const actorUri = overrides?.actorUri ?? actor.actorUri;
		knownKeys.set(actor.keyId, {
			user: { uri: actorUri, host: new URL(actorUri).host },
			key: { keyPem: overrides?.keyPem ?? actor.keypair.publicKey },
		});
	}

	beforeEach(async () => {
		notes = new Map();
		pinnedNoteIds = [];
		fanoutNotes = [];
		knownKeys = new Map();
		meta = { federation: 'all', blockedHosts: [], silencedHosts: [], enableFanoutTimeline: true };
		instancesRepository = { findOneBy: vi.fn(async () => null) };
		queueService = { inbox: vi.fn() };
		dbWhereClauses = [];

		const config = { host: LOCAL_HOST, url: `https://${LOCAL_HOST}` };
		const loggerService = {
			getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), succ: vi.fn() }),
		};
		const apDbResolverService = {
			getAuthUserFromKeyId: vi.fn(async (keyId: string) => knownKeys.get(keyId) ?? null),
		};

		const module = await Test.createTestingModule({
			providers: [
				ActivityPubAccessControlService,
				UtilityService,
				{ provide: DI.config, useValue: config },
				{ provide: DI.meta, useValue: meta },
				{ provide: DI.instancesRepository, useValue: instancesRepository },
				{ provide: LoggerService, useValue: loggerService },
				{ provide: ApDbResolverService, useValue: apDbResolverService },
			],
		}).compile();

		const utilityService = module.get(UtilityService);
		const activityPubAccessControlService = module.get(ActivityPubAccessControlService);

		const notesRepository = {
			createQueryBuilder: vi.fn(() => ({})),
			findOneBy: vi.fn(async (where: { id: string }) => notes.get(where.id) ?? null),
			findOneByOrFail: vi.fn(async (where: { id: string }) => {
				const note = notes.get(where.id);
				if (note == null) throw new Error('not found');
				return note;
			}),
		};

		const apRendererService = {
			addContext: (x: object) => ({ '@context': 'https://www.w3.org/ns/activitystreams', ...x }),
			renderNote: async (note: MiNote) => ({ type: 'Note', id: `${config.url}/notes/${note.id}` }),
			renderCreate: (object: unknown) => ({ type: 'Create', object }),
			renderOrderedCollection: (id: string, totalItems: number, first?: string, last?: string, orderedItems?: unknown[]) => ({ type: 'OrderedCollection', id, totalItems, first, last, orderedItems }),
			renderOrderedCollectionPage: (id: string, totalItems: number, orderedItems: unknown[]) => ({ type: 'OrderedCollectionPage', id, totalItems, orderedItems }),
		};

		// outbox の DB フォールバック経路で組み立てられた WHERE 句を記録する
		const queryBuilder = {
			andWhere: vi.fn((where: unknown) => {
				if (typeof where === 'string') dbWhereClauses.push(where);
				return queryBuilder;
			}),
			limit: vi.fn(() => queryBuilder),
			getMany: vi.fn(async () => []),
		};

		const service = Object.assign(Object.create(ActivityPubServerService.prototype), {
			config,
			meta,
			utilityService,
			activityPubAccessControlService,
			notesRepository,
			queueService,
			apRendererService,
			queryService: {
				makePaginationQuery: vi.fn(() => queryBuilder),
			},
			usersRepository: {
				findOneBy: vi.fn(async (where: { id: string }) => where.id === 'user1' ? { id: 'user1', host: null, notesCount: 3 } : null),
			},
			userNotePiningsRepository: {
				find: vi.fn(async () => pinnedNoteIds.map((noteId, i) => ({ id: `pin${i}`, noteId }))),
			},
			fanoutTimelineEndpointService: {
				getMiNotes: vi.fn(async (ps: { noteFilter: (note: MiNote) => boolean }) => fanoutNotes.filter(ps.noteFilter)),
			},
		}) as ActivityPubServerService;

		fastify = Fastify();
		await fastify.register(fastifyRawBody, { global: false, encoding: null, runFirst: true });
		await fastify.register((instance, options, done) => service.createServer(instance, options, done));
		await fastify.ready();
	});

	afterEach(async () => {
		await fastify.close();
	});

	async function signedGetHeaders(actor: Actor, path: string, additionalHeaders: Record<string, string> = {}) {
		const signed = await ApRequestCreator.createSignedGet({
			key: { keyId: actor.keyId, privateKeyPem: actor.keypair.privateKey },
			url: `https://${LOCAL_HOST}${path}`,
			additionalHeaders,
		});
		return { ...signed.request.headers, host: LOCAL_HOST };
	}

	async function get(path: string, headers: Record<string, string> = {}) {
		return await fastify.inject({
			method: 'GET',
			url: path,
			headers: { accept: AP_ACCEPT, host: LOCAL_HOST, ...headers },
		});
	}

	async function postInbox(actor: Actor, options: { path?: string; userAgent?: string } = {}) {
		const path = options.path ?? '/inbox';
		const body = JSON.stringify({
			id: `${actor.actorUri}/activities/1`,
			type: 'Create',
			actor: actor.actorUri,
		});
		const signed = await ApRequestCreator.createSignedPost({
			key: { keyId: actor.keyId, privateKeyPem: actor.keypair.privateKey },
			url: `https://${LOCAL_HOST}${path}`,
			body,
			additionalHeaders: options.userAgent ? { 'User-Agent': options.userAgent } : {},
		});

		return await fastify.inject({
			method: 'POST',
			url: path,
			headers: { ...signed.request.headers, host: LOCAL_HOST, 'content-type': 'application/activity+json' },
			payload: body,
		});
	}

	describe('GET /notes/:note', () => {
		test('denies an unsigned request that spoofs an allowed host in User-Agent', async () => {
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted', {
				'user-agent': 'http.rb/5.3.0 (Mastodon/4.2.0; +https://allowed.example/)',
			});

			expect(res.statusCode).toBe(404);
		});

		test('denies an unsigned request without User-Agent for an include-restricted note', async () => {
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted');

			expect(res.statusCode).toBe(404);
		});

		test('denies an unsigned request without User-Agent for an exclude-restricted note', async () => {
			notes.set('restricted', createNote('restricted', { mode: 'exclude', hosts: ['other.example'] }));

			const res = await get('/notes/restricted');

			expect(res.statusCode).toBe(404);
		});

		test('denies a signed request from a host outside the include list even with a spoofed User-Agent', async () => {
			registerKey(otherActor);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(otherActor, '/notes/restricted', {
				'User-Agent': 'http.rb/5.3.0 (Mastodon/4.2.0; +https://allowed.example/)',
			}));

			expect(res.statusCode).toBe(404);
		});

		test('serves an include-restricted note to a signed request from an allowed host without shared caching', async () => {
			registerKey(allowedActor);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(allowedActor, '/notes/restricted'));

			expect(res.statusCode).toBe(200);
			expect(res.json().id).toBe(`https://${LOCAL_HOST}/notes/restricted`);
			expect(res.headers['cache-control']).toBe('private, no-store');
		});

		test('still serves an unrestricted note to an unsigned request with public caching', async () => {
			notes.set('public', createNote('public', null));

			const res = await get('/notes/public');

			expect(res.statusCode).toBe(200);
			expect(res.headers['cache-control']).toBe('public, max-age=180');
		});

		test('denies a signed request from a blocked host even with a spoofed User-Agent', async () => {
			meta.blockedHosts = ['blocked.example'];
			registerKey(blockedActor);
			notes.set('public', createNote('public', null));

			const res = await get('/notes/public', await signedGetHeaders(blockedActor, '/notes/public', {
				'User-Agent': 'http.rb/5.3.0 (Mastodon/4.2.0; +https://allowed.example/)',
			}));

			expect(res.statusCode).toBe(403);
		});
	});

	describe('GET /notes/:note/activity', () => {
		test('denies an unsigned request for a restricted note', async () => {
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted/activity');

			expect(res.statusCode).toBe(404);
		});

		test('denies a signed request from a host outside the include list', async () => {
			registerKey(otherActor);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted/activity', await signedGetHeaders(otherActor, '/notes/restricted/activity'));

			expect(res.statusCode).toBe(404);
		});

		test('denies a signed request from a host in the exclude list', async () => {
			registerKey(otherActor);
			notes.set('restricted', createNote('restricted', { mode: 'exclude', hosts: ['other.example'] }));

			const res = await get('/notes/restricted/activity', await signedGetHeaders(otherActor, '/notes/restricted/activity'));

			expect(res.statusCode).toBe(404);
		});

		test('serves a restricted note activity to a signed request from an allowed host without shared caching', async () => {
			registerKey(allowedActor);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted/activity', await signedGetHeaders(allowedActor, '/notes/restricted/activity'));

			expect(res.statusCode).toBe(200);
			expect(res.json().type).toBe('Create');
			expect(res.headers['cache-control']).toBe('private, no-store');
		});
	});

	describe('public collections', () => {
		test('featured collection excludes pinned notes with delivery targets', async () => {
			notes.set('public', createNote('public', null));
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));
			pinnedNoteIds = ['restricted', 'public'];

			const res = await get('/users/user1/collections/featured');

			expect(res.statusCode).toBe(200);
			const ids = res.json().orderedItems.map((item: { id: string }) => item.id);
			expect(ids).toEqual([`https://${LOCAL_HOST}/notes/public`]);
		});

		test('outbox page excludes notes with delivery targets', async () => {
			fanoutNotes = [
				createNote('public', null),
				createNote('restricted', { mode: 'exclude', hosts: ['other.example'] }),
			];
			notes.set('public', fanoutNotes[0]);
			notes.set('restricted', fanoutNotes[1]);

			const res = await get('/users/user1/outbox?page=true');

			expect(res.statusCode).toBe(200);
			const objectIds = res.json().orderedItems.map((item: { object: { id: string } }) => item.object.id);
			expect(objectIds).toEqual([`https://${LOCAL_HOST}/notes/public`]);
		});
	});

	describe('POST /inbox', () => {
		test('rejects an activity signed by a blocked host before queueing, even with a spoofed User-Agent', async () => {
			meta.blockedHosts = ['blocked.example'];

			const res = await postInbox(blockedActor, { userAgent: 'http.rb/5.3.0 (Mastodon/4.2.0; +https://allowed.example/)' });

			expect(res.statusCode).toBe(403);
			expect(queueService.inbox).not.toHaveBeenCalled();
		});

		test('queues an activity signed by an allowed host', async () => {
			meta.blockedHosts = ['blocked.example'];

			const res = await postInbox(allowedActor);

			expect(res.statusCode).toBe(202);
			expect(queueService.inbox).toHaveBeenCalledTimes(1);
		});
	});

	describe('bypass variants', () => {
		function actorAt(base: Actor, actorUri: string, keyId = `${actorUri}#main-key`): Actor {
			return { keyId, actorUri, keypair: base.keypair };
		}

		test('denies a restricted note when the keyId host differs from the actor host', async () => {
			// other.example の鍵が allowed.example の actor に紐付いていても、allowed.example としては扱わない
			registerKey(otherActor, { actorUri: allowedActor.actorUri });
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(otherActor, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('denies a restricted note when an allowed keyId is signed with a forged private key', async () => {
			registerKey(allowedActor);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));
			const forger = { ...allowedActor, keypair: otherActor.keypair };

			const res = await get('/notes/restricted', await signedGetHeaders(forger, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('denies a restricted note when the signing key is unknown', async () => {
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(allowedActor, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('denies a restricted note when a signature for another note is replayed', async () => {
			registerKey(allowedActor);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted/activity', await signedGetHeaders(allowedActor, '/notes/public/activity'));

			expect(res.statusCode).toBe(404);
		});

		test('still serves an unrestricted note when the signing key is unknown', async () => {
			notes.set('public', createNote('public', null));

			const res = await get('/notes/public', await signedGetHeaders(allowedActor, '/notes/public'));

			expect(res.statusCode).toBe(200);
			expect(res.headers['cache-control']).toBe('public, max-age=180');
		});

		test('denies an unsigned HEAD request for a restricted note', async () => {
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await fastify.inject({
				method: 'HEAD',
				url: '/notes/restricted',
				headers: { accept: AP_ACCEPT, host: LOCAL_HOST },
			});

			expect(res.statusCode).toBe(404);
		});

		test('does not treat a subdomain of an included host as included', async () => {
			const sub = actorAt(allowedActor, 'https://evil.allowed.example/users/mallory');
			registerKey(sub);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['allowed.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(sub, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('matches include targets case-insensitively', async () => {
			const mixed = actorAt(allowedActor, 'https://Allowed.EXAMPLE/users/alice');
			registerKey(mixed);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['ALLOWED.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(mixed, '/notes/restricted'));

			expect(res.statusCode).toBe(200);
		});

		test('denies an excluded host whose target is stored with different case', async () => {
			registerKey(otherActor);
			notes.set('restricted', createNote('restricted', { mode: 'exclude', hosts: ['OTHER.Example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(otherActor, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('denies an excluded IDN host whose target is stored in Unicode form', async () => {
			const idn = actorAt(otherActor, 'https://xn--bcher-kva.example/users/bob');
			registerKey(idn);
			notes.set('restricted', createNote('restricted', { mode: 'exclude', hosts: ['bücher.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(idn, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('allows an included IDN host whose target is stored in Unicode form', async () => {
			const idn = actorAt(allowedActor, 'https://xn--bcher-kva.example/users/alice');
			registerKey(idn);
			notes.set('restricted', createNote('restricted', { mode: 'include', hosts: ['bücher.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(idn, '/notes/restricted'));

			expect(res.statusCode).toBe(200);
		});

		test('denies an excluded host that signs with a trailing-dot FQDN', async () => {
			const dotted = actorAt(otherActor, 'https://other.example./users/bob');
			registerKey(dotted);
			notes.set('restricted', createNote('restricted', { mode: 'exclude', hosts: ['other.example'] }));

			const res = await get('/notes/restricted', await signedGetHeaders(dotted, '/notes/restricted'));

			expect(res.statusCode).toBe(404);
		});

		test('denies a GET signed by a subdomain of a blocked host', async () => {
			meta.blockedHosts = ['blocked.example'];
			const sub = actorAt(blockedActor, 'https://sub.blocked.example/users/eve');
			registerKey(sub);
			notes.set('public', createNote('public', null));

			const res = await get('/notes/public', await signedGetHeaders(sub, '/notes/public'));

			expect(res.statusCode).toBe(403);
		});

		test('denies a GET signed by a blocked host with a trailing-dot FQDN', async () => {
			meta.blockedHosts = ['blocked.example'];
			const dotted = actorAt(blockedActor, 'https://blocked.example./users/eve');
			registerKey(dotted);
			notes.set('public', createNote('public', null));

			const res = await get('/notes/public', await signedGetHeaders(dotted, '/notes/public'));

			expect(res.statusCode).toBe(403);
		});

		test('denies a silenced host on the outbox, which does not allow limited hosts', async () => {
			meta.silencedHosts = ['other.example'];
			registerKey(otherActor);

			const res = await get('/users/user1/outbox?page=true', await signedGetHeaders(otherActor, '/users/user1/outbox?page=true'));

			expect(res.statusCode).toBe(403);
		});

		test('outbox DB fallback excludes notes with delivery targets', async () => {
			meta.enableFanoutTimeline = false;

			const res = await get('/users/user1/outbox?page=true');

			expect(res.statusCode).toBe(200);
			expect(dbWhereClauses).toContain('note.deliveryTargets IS NULL');
		});

		test('rejects an inbox activity from a blocked host on the shared user inbox route', async () => {
			meta.blockedHosts = ['blocked.example'];

			const res = await postInbox(blockedActor, { path: '/users/user1/inbox' });

			expect(res.statusCode).toBe(403);
			expect(queueService.inbox).not.toHaveBeenCalled();
		});

		test('rejects an inbox activity from a quarantined host', async () => {
			instancesRepository.findOneBy.mockImplementation(async (where: { host: string }) => where.host === 'other.example' ? { quarantineLimited: true } : null);

			const res = await postInbox(otherActor);

			expect(res.statusCode).toBe(403);
			expect(queueService.inbox).not.toHaveBeenCalled();
		});

		test('queues an inbox activity from a silenced host', async () => {
			meta.silencedHosts = ['other.example'];

			const res = await postInbox(otherActor);

			expect(res.statusCode).toBe(202);
			expect(queueService.inbox).toHaveBeenCalledTimes(1);
		});

		test('rejects an inbox activity whose keyId uses an upper-case blocked host', async () => {
			meta.blockedHosts = ['blocked.example'];

			const res = await postInbox(actorAt(blockedActor, 'https://BLOCKED.Example/users/eve'));

			expect(res.statusCode).toBe(403);
			expect(queueService.inbox).not.toHaveBeenCalled();
		});

		test('rejects an inbox activity whose keyId uses a subdomain of a blocked host', async () => {
			meta.blockedHosts = ['blocked.example'];

			const res = await postInbox(actorAt(blockedActor, 'https://sub.blocked.example/users/eve'));

			expect(res.statusCode).toBe(403);
			expect(queueService.inbox).not.toHaveBeenCalled();
		});

		test('rejects an inbox activity whose keyId uses a trailing-dot blocked host', async () => {
			meta.blockedHosts = ['blocked.example'];

			const res = await postInbox(actorAt(blockedActor, 'https://blocked.example./users/eve'));

			expect(res.statusCode).toBe(403);
			expect(queueService.inbox).not.toHaveBeenCalled();
		});
	});
});
