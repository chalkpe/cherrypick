/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, beforeAll, beforeEach, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';

import { MockResolver } from '../misc/mock-resolver.js';
import type { IActor, IApDocument, ICollection, IObject, IPost } from '@/core/activitypub/type.js';
import type { MiRemoteUser } from '@/models/User.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { ApImageService } from '@/core/activitypub/models/ApImageService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { JsonLdService } from '@/core/activitypub/JsonLdService.js';
import { CONTEXT } from '@/core/activitypub/misc/contexts.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { MiMeta, MiNote, NotesRepository, UserProfilesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { StatusError } from '@/misc/status-error.js';
import { DownloadService } from '@/core/DownloadService.js';
import { genAidx } from '@/misc/id/aidx.js';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const host = 'https://host1.test';

type NonTransientIActor = IActor & { id: string };
type NonTransientIPost = IPost & { id: string };

function createRandomActor({ actorHost = host } = {}): NonTransientIActor {
	const preferredUsername = secureRndstr(8);
	const actorId = `${actorHost}/users/${preferredUsername.toLowerCase()}`;

	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: actorId,
		type: 'Person',
		preferredUsername,
		inbox: `${actorId}/inbox`,
		outbox: `${actorId}/outbox`,
	};
}

function createRandomNote(actor: NonTransientIActor): NonTransientIPost {
	const id = secureRndstr(8);
	const noteId = `${new URL(actor.id).origin}/notes/${id}`;

	return {
		id: noteId,
		type: 'Note',
		attributedTo: actor.id,
		content: 'test test foo',
	};
}

function createRandomNotes(actor: NonTransientIActor, length: number): NonTransientIPost[] {
	return new Array(length).fill(null).map(() => createRandomNote(actor));
}

function createRandomFeaturedCollection(actor: NonTransientIActor, length: number): ICollection {
	const items = createRandomNotes(actor, length);

	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Collection',
		id: actor.outbox as string,
		totalItems: items.length,
		items,
	};
}

async function createRandomRemoteUser(
	resolver: MockResolver,
	personService: ApPersonService,
): Promise<MiRemoteUser> {
	const actor = createRandomActor();
	resolver.register(actor.id, actor);

	return await personService.createPerson(actor.id, resolver);
}

describe('ActivityPub', () => {
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let imageService: ApImageService;
	let apDbResolverService: ApDbResolverService;
	let noteService: ApNoteService;
	let personService: ApPersonService;
	let rendererService: ApRendererService;
	let apResolverService: ApResolverService;
	let httpRequestService: HttpRequestService;
	let jsonLdService: JsonLdService;
	let resolver: MockResolver;

	const metaInitial = {
		cacheRemoteFiles: true,
		cacheRemoteSensitiveFiles: true,
		enableFanoutTimeline: true,
		enableFanoutTimelineDbFallback: true,
		perUserHomeTimelineCacheMax: 100,
		perLocalUserUserTimelineCacheMax: 100,
		perRemoteUserUserTimelineCacheMax: 100,
		blockedHosts: [] as string[],
		sensitiveWords: [] as string[],
		prohibitedWords: [] as string[],
	} as MiMeta;
	const meta = { ...metaInitial };

	function updateMeta(newMeta: Partial<MiMeta>): void {
		for (const key in meta) {
			delete (meta as any)[key];
		}
		Object.assign(meta, newMeta);
	}

	beforeAll(async () => {
		const app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
		})
			.overrideProvider(DownloadService).useValue({
				async downloadUrl(url: string, path: string): Promise<{ filename: string }> {
					if (url.endsWith('.png')) {
						fs.copyFileSync(
							_dirname + '/../resources/hw.png',
							path,
						);
					}
					return {
						filename: 'dummy.tmp',
					};
				},
			})
			.overrideProvider(DI.meta).useFactory({ factory: () => meta })
			.compile();

		await app.init();
		app.enableShutdownHooks();

		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);

		noteService = app.get<ApNoteService>(ApNoteService);
		apDbResolverService = app.get(ApDbResolverService);
		personService = app.get<ApPersonService>(ApPersonService);
		rendererService = app.get<ApRendererService>(ApRendererService);
		apResolverService = app.get<ApResolverService>(ApResolverService);
		httpRequestService = app.get<HttpRequestService>(HttpRequestService);
		imageService = app.get<ApImageService>(ApImageService);
		jsonLdService = app.get<JsonLdService>(JsonLdService);
		resolver = new MockResolver(await app.resolve<LoggerService>(LoggerService));

		// Prevent ApPersonService from fetching instance, as it causes Jest import-after-test error
		const federatedInstanceService = app.get<FederatedInstanceService>(FederatedInstanceService);
		vi.spyOn(federatedInstanceService, 'fetch').mockImplementation(() => new Promise(() => { }));
	});

	beforeEach(() => {
		resolver.clear();
	});

	describe('Parse minimum object', () => {
		const actor = createRandomActor();

		const post = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${host}/users/${secureRndstr(8)}`,
			type: 'Note',
			attributedTo: actor.id,
			to: 'https://www.w3.org/ns/activitystreams#Public',
			content: 'あ',
		};

		test('Minimum Actor', async () => {
			resolver.register(actor.id, actor);

			const user = await personService.createPerson(actor.id, resolver);

			assert.deepStrictEqual(user.uri, actor.id);
			assert.deepStrictEqual(user.username, actor.preferredUsername);
			assert.deepStrictEqual(user.inbox, actor.inbox);
		});

		test('Minimum Note', async () => {
			resolver.register(actor.id, actor);
			resolver.register(post.id, post);

			const note = await noteService.createNote(post.id, undefined, resolver, true);

			assert.deepStrictEqual(note?.uri, post.id);
			assert.deepStrictEqual(note.visibility, 'public');
			assert.deepStrictEqual(note.text, post.content);
		});
	});

	describe('Actor public key updates', () => {
		async function createActorWithKey() {
			const actor = createRandomActor();
			const publicKey = { id: `${actor.id}#main-key`, owner: actor.id, publicKeyPem: 'original public key' };
			const actorWithKey = { ...actor, publicKey };
			resolver.register(actor.id, actorWithKey);
			await personService.createPerson(actor.id, resolver);
			return actorWithKey;
		}

		async function expectPublicKey(actorId: string, keyId: string, pem: string) {
			const fromKeyId = await apDbResolverService.getAuthUserFromKeyId(keyId);
			const fromActorId = await apDbResolverService.getAuthUserFromApId(actorId);
			assert.strictEqual(fromKeyId?.key.keyPem, pem);
			assert.strictEqual(fromActorId?.key?.keyId, keyId);
			assert.strictEqual(fromActorId.key.keyPem, pem);
		}

		async function updateActorKey(actor: NonTransientIActor, publicKey: NonNullable<IActor['publicKey']>) {
			const updated: IActor = { ...actor, publicKey };
			await personService.updatePerson(actor.id, resolver, updated);
		}

		test('refreshes both lookups after replacing the key with the same ID', async () => {
			const actor = await createActorWithKey();
			await expectPublicKey(actor.id, actor.publicKey.id, actor.publicKey.publicKeyPem);
			const publicKey = { ...actor.publicKey, publicKeyPem: 'replacement public key' };

			await updateActorKey(actor, publicKey);

			await expectPublicKey(actor.id, publicKey.id, publicKey.publicKeyPem);
		});

		test('refreshes the actor lookup and removes the previous key ID after an ID change', async () => {
			const actor = await createActorWithKey();
			await expectPublicKey(actor.id, actor.publicKey.id, actor.publicKey.publicKeyPem);
			const publicKey = { ...actor.publicKey, id: `${actor.id}#next-key`, publicKeyPem: 'replacement public key' };
			assert.strictEqual(await apDbResolverService.getAuthUserFromKeyId(publicKey.id), null);

			await updateActorKey(actor, publicKey);

			assert.strictEqual(await apDbResolverService.getAuthUserFromKeyId(actor.publicKey.id), null);
			await expectPublicKey(actor.id, publicKey.id, publicKey.publicKeyPem);
		});

		test('preserves both actors’ keys when a key ID update fails', async () => {
			const actor = await createActorWithKey();
			const otherActor = await createActorWithKey();
			await expectPublicKey(actor.id, actor.publicKey.id, actor.publicKey.publicKeyPem);
			await expectPublicKey(otherActor.id, otherActor.publicKey.id, otherActor.publicKey.publicKeyPem);
			const publicKey = { ...actor.publicKey, id: otherActor.publicKey.id, publicKeyPem: 'replacement public key' };

			await assert.rejects(updateActorKey(actor, publicKey), { code: '23505' });

			await expectPublicKey(actor.id, actor.publicKey.id, actor.publicKey.publicKeyPem);
			await expectPublicKey(otherActor.id, otherActor.publicKey.id, otherActor.publicKey.publicKeyPem);
		});

		test('returns one current key after overlapping updates of one actor', async () => {
			const actor = await createActorWithKey();
			const replacements = ['#key-a', '#key-b'].map(fragment => ({
				...actor.publicKey,
				id: actor.id + fragment,
				publicKeyPem: `replacement ${fragment}`,
			}));

			await Promise.all(replacements.map(publicKey => updateActorKey(actor, publicKey)));

			const current = (await apDbResolverService.getAuthUserFromApId(actor.id))?.key;
			const winner = replacements.find(key => key.id === current?.keyId);
			const loser = replacements.find(key => key.id !== current?.keyId);
			assert.ok(winner && loser);
			await expectPublicKey(actor.id, winner.id, winner.publicKeyPem);
			assert.strictEqual(await apDbResolverService.getAuthUserFromKeyId(loser.id), null);
			assert.strictEqual(await apDbResolverService.getAuthUserFromKeyId(actor.publicKey.id), null);
		});
	});

	describe('Name field', () => {
		test('Truncate long name', async () => {
			const actor = {
				...createRandomActor(),
				name: secureRndstr(129),
			};

			resolver.register(actor.id, actor);

			const user = await personService.createPerson(actor.id, resolver);

			assert.deepStrictEqual(user.name, actor.name.slice(0, 128));
		});

		test('Normalize empty name', async () => {
			const actor = {
				...createRandomActor(),
				name: '',
			};

			resolver.register(actor.id, actor);

			const user = await personService.createPerson(actor.id, resolver);

			assert.strictEqual(user.name, null);
		});
	});

	describe('alsoKnownAs field', () => {
		test('Handle alsoKnownAs as an array', async () => {
			const actor = {
				...createRandomActor(),
				alsoKnownAs: ['https://example.com/users/alice', 'https://example.com/users/alice2'],
			};

			resolver.register(actor.id, actor);

			const user = await personService.createPerson(actor.id, resolver);

			assert.deepStrictEqual(user.alsoKnownAs, actor.alsoKnownAs);
		});

		test('Handle alsoKnownAs as a string', async () => {
			const actor = {
				...createRandomActor(),
				alsoKnownAs: 'https://example.com/users/alice',
			};

			resolver.register(actor.id, actor);

			const user = await personService.createPerson(actor.id, resolver);

			assert.deepStrictEqual(user.alsoKnownAs, [actor.alsoKnownAs]);
		});

		test('Update person with alsoKnownAs as a string', async () => {
			const actor = createRandomActor();
			resolver.register(actor.id, actor);
			const user = await personService.createPerson(actor.id, resolver);

			const updatedActor = {
				...actor,
				alsoKnownAs: 'https://example.com/users/alice',
			};
			resolver.register(actor.id, updatedActor);

			await personService.updatePerson(actor.id, resolver, updatedActor);

			const updatedUser = await personService.fetchPerson(actor.id);
			assert.deepStrictEqual(updatedUser?.alsoKnownAs, [updatedActor.alsoKnownAs]);
		});
	});

	describe('Remote collection counts', () => {
		test('Counts of collections given only as URLs are read through the resolver', async () => {
			const actor = createRandomActor();
			const collection = (path: string, totalItems: number) => ({
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${actor.id}/${path}`,
				type: 'OrderedCollection',
				totalItems,
				first: `${actor.id}/${path}?page=1`,
			});
			actor.followers = `${actor.id}/followers`;
			actor.following = `${actor.id}/following`;
			resolver.register(actor.id, actor);
			resolver.register(`${actor.id}/followers`, collection('followers', 7));
			resolver.register(`${actor.id}/following`, collection('following', 5));
			resolver.register(`${actor.id}/outbox`, collection('outbox', 11));

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global fetch must not be used'));
			try {
				const user = await personService.createPerson(actor.id, resolver);
				const profile = await personService.fetchPerson(actor.id);

				assert.strictEqual(fetchSpy.mock.calls.length, 0);
				assert.strictEqual(user.followersCount, 7);
				assert.strictEqual(user.followingCount, 5);
				assert.strictEqual(user.notesCount, 11);
				assert.strictEqual(profile?.followersCount, 7);

				resolver.register(`${actor.id}/followers`, collection('followers', 8));
				await personService.updatePerson(actor.id, resolver, actor);
				const updated = await personService.fetchPerson(actor.id);

				assert.strictEqual(fetchSpy.mock.calls.length, 0);
				assert.strictEqual(updated?.followersCount, 8);
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test('Person is created without counts when the collections cannot be read', async () => {
			const actor = createRandomActor();
			actor.followers = `${actor.id}/followers`;
			resolver.register(actor.id, actor);

			const user = await personService.createPerson(actor.id, resolver);

			assert.strictEqual(user.followersCount, 0);
			assert.strictEqual(user.notesCount, 0);
		});
	});

	describe('Collection visibility', () => {
		test('Public following/followers', async () => {
			const actor = createRandomActor();
			actor.following = {
				id: `${actor.id}/following`,
				type: 'OrderedCollection',
				totalItems: 0,
				first: `${actor.id}/following?page=1`,
			};
			actor.followers = `${actor.id}/followers`;

			resolver.register(actor.id, actor);
			resolver.register(actor.followers, {
				id: actor.followers,
				type: 'OrderedCollection',
				totalItems: 0,
				first: `${actor.followers}?page=1`,
			});

			const user = await personService.createPerson(actor.id, resolver);
			const userProfile = await userProfilesRepository.findOneByOrFail({ userId: user.id });

			assert.deepStrictEqual(userProfile.followingVisibility, 'public');
			assert.deepStrictEqual(userProfile.followersVisibility, 'public');
		});

		test('Private following/followers', async () => {
			const actor = createRandomActor();
			actor.following = {
				id: `${actor.id}/following`,
				type: 'OrderedCollection',
				totalItems: 0,
				// first: …
			};
			actor.followers = `${actor.id}/followers`;

			resolver.register(actor.id, actor);
			//resolver.register(actor.followers, { … });

			const user = await personService.createPerson(actor.id, resolver);
			const userProfile = await userProfilesRepository.findOneByOrFail({ userId: user.id });

			assert.deepStrictEqual(userProfile.followingVisibility, 'private');
			assert.deepStrictEqual(userProfile.followersVisibility, 'private');
		});
	});

	describe('Renderer', () => {
		test('Render an announce with visibility: followers', () => {
			rendererService.renderAnnounce('https://example.com/notes/00example', {
				id: genAidx(Date.now()),
				visibility: 'followers',
			} as MiNote);
		});
	});

	describe('Featured', () => {
		test('Fetch featured notes from IActor', async () => {
			const actor = createRandomActor();
			actor.featured = `${actor.id}/collections/featured`;

			const featured = createRandomFeaturedCollection(actor, 5);

			resolver.register(actor.id, actor);
			resolver.register(actor.featured, featured);

			await personService.createPerson(actor.id, resolver);

			// All notes in `featured` are same-origin, no need to fetch notes again
			assert.deepStrictEqual(resolver.remoteGetTrials(), [actor.id, `${actor.id}/outbox`, actor.featured]);

			// Created notes without resolving anything
			for (const item of featured.items as IPost[]) {
				const note = await noteService.fetchNote(item);
				assert.ok(note);
				assert.strictEqual(note.text, 'test test foo');
				assert.strictEqual(note.uri, item.id);
			}
		});

		test('Fetch featured notes from IActor pointing to another remote server', async () => {
			const actor1 = createRandomActor();
			actor1.featured = `${actor1.id}/collections/featured`;
			const actor2 = createRandomActor({ actorHost: 'https://host2.test' });

			const actor2Note = createRandomNote(actor2);
			const featured = createRandomFeaturedCollection(actor1, 0);
			(featured.items as IPost[]).push({
				...actor2Note,
				content: 'test test bar', // fraud!
			});

			resolver.register(actor1.id, actor1);
			resolver.register(actor1.featured, featured);
			resolver.register(actor2.id, actor2);
			resolver.register(actor2Note.id, actor2Note);

			await personService.createPerson(actor1.id, resolver);

			// actor2Note is from a different server and needs to be fetched again
			assert.deepStrictEqual(
				resolver.remoteGetTrials(),
				[actor1.id, `${actor1.id}/outbox`, actor1.featured, actor2Note.id, actor2.id, `${actor2.id}/outbox`],
			);

			const note = await noteService.fetchNote(actor2Note.id);
			assert.ok(note);

			// Reflects the original content instead of the fraud
			assert.strictEqual(note.text, 'test test foo');
			assert.strictEqual(note.uri, actor2Note.id);
		});

		test('Fetch a note that is a featured note of the attributed actor', async () => {
			const actor = createRandomActor();
			actor.featured = `${actor.id}/collections/featured`;

			const featured = createRandomFeaturedCollection(actor, 5);
			const firstNote = (featured.items as NonTransientIPost[])[0];

			resolver.register(actor.id, actor);
			resolver.register(actor.featured, featured);
			resolver.register(firstNote.id, firstNote);

			const note = await noteService.createNote(firstNote.id as string, undefined, resolver);
			assert.strictEqual(note?.uri, firstNote.id);
		});

		test('stores a featured note quoting a fetched item outside the pin limit', async () => {
			const actor = createRandomActor();
			actor.featured = `${actor.id}/collections/featured`;
			resolver.register(actor.id, actor);
			const user = await personService.createPerson(actor.id, resolver);
			const notes = createRandomNotes(actor, 6).map(note => ({ ...note, '@context': actor['@context'] }));
			const quoted = notes[5];
			const pin = { ...notes[0], quoteUrl: quoted.id };
			const featuredNotes = [pin, ...notes.slice(1)];
			const collection: ICollection = {
				...createRandomFeaturedCollection(actor, 0),
				items: featuredNotes.map(note => note.id),
				totalItems: featuredNotes.length,
			};
			const objects = new Map<string, IObject>(featuredNotes.map(note => [note.id, note]));
			objects.set(actor.featured, collection);
			const fetch = vi.spyOn(httpRequestService, 'getActivityJson').mockImplementation(async url => {
				const object = objects.get(url);
				assert.ok(object);
				return object;
			});
			const realResolver = await apResolverService.createResolver();

			await personService.updateFeatured(user.id, realResolver);

			const stored = await notesRepository.findOneByOrFail({ uri: pin.id });
			const storedQuote = await notesRepository.findOneByOrFail({ uri: quoted.id });
			assert.strictEqual(stored.renoteId, storedQuote.id);
			assert.strictEqual(fetch.mock.calls.filter(([url]) => url === quoted.id).length, 1);
			await assert.rejects(realResolver.resolveNote(quoted.id), { id: '0dc86cf6-7cd6-4e56-b1e6-5903d62d7ea5' });
		});
	});

	describe('Reply chain', () => {
		// chain[0] is the root, and chain[i] replies to chain[i - 1]
		function createReplyChain(actor: NonTransientIActor, length: number): NonTransientIPost[] {
			const chain: NonTransientIPost[] = [];
			for (let i = 0; i < length; i++) {
				chain.push({
					...createRandomNote(actor),
					'@context': 'https://www.w3.org/ns/activitystreams',
					to: 'https://www.w3.org/ns/activitystreams#Public',
					content: `chain ${i}`,
					inReplyTo: chain.at(-1)?.id,
				});
			}
			return chain;
		}

		// Use the real Resolver so that its recursion limit applies; only the HTTP fetch is replaced
		function serveRemoteObjects(objects: (NonTransientIActor | NonTransientIPost)[]): void {
			const objectMap = new Map<string, IObject>(objects.map(object => [object.id, object]));
			vi.spyOn(httpRequestService, 'getActivityJson').mockImplementation(async (url: string) => {
				const object = objectMap.get(url);
				if (object == null) throw new StatusError('Internal Server Error', 500, 'Internal Server Error');
				return object;
			});
		}

		async function collectStoredAncestors(note: MiNote): Promise<MiNote[]> {
			const notes = [note];
			let replyId = note.replyId;
			while (replyId != null) {
				const reply = await notesRepository.findOneByOrFail({ id: replyId });
				notes.push(reply);
				replyId = reply.replyId;
			}
			return notes;
		}

		test('Cut a reply chain that exceeds the recursion limit and keep the parent URL', async () => {
			const actor = createRandomActor();
			const realResolver = await apResolverService.createResolver();
			const chain = createReplyChain(actor, realResolver.getRecursionLimit() + 10);
			serveRemoteObjects([actor, ...chain]);

			const tip = chain[chain.length - 1];
			const note = await noteService.createNote(tip.id, undefined, realResolver, true);
			assert.ok(note);

			// The stored notes keep the reply links in the original order
			const stored = await collectStoredAncestors(note);
			const cutIndex = chain.length - stored.length;
			assert.ok(cutIndex > 0, 'the chain should be cut before reaching the root');
			assert.deepStrictEqual(
				stored.map(x => x.uri),
				chain.slice(cutIndex).map(x => x.id).reverse(),
			);
			assert.strictEqual(note.text, `chain ${chain.length - 1}`);

			// The note at the cut has no reply, but its text links to the parent that was not fetched
			const cutNote = stored[stored.length - 1];
			const unresolvedParent = chain[cutIndex - 1];
			assert.strictEqual(cutNote.replyId, null);
			assert.strictEqual(await notesRepository.findOneBy({ uri: unresolvedParent.id }), null);
			assert.ok(cutNote.text?.startsWith(`chain ${cutIndex}`));
			assert.ok(cutNote.text?.includes(unresolvedParent.id));
		});

		test('Do not cut a reply chain when the parent fails to be fetched', async () => {
			const actor = createRandomActor();
			const [parent, reply] = createReplyChain(actor, 2);
			serveRemoteObjects([actor, reply]);

			await assert.rejects(
				noteService.createNote(reply.id, undefined, await apResolverService.createResolver(), true),
				(err: unknown) => err instanceof StatusError && err.statusCode === 500,
			);
			assert.strictEqual(await notesRepository.findOneBy({ uri: parent.id }), null);
			assert.strictEqual(await notesRepository.findOneBy({ uri: reply.id }), null);
		});
	});

	describe('Quote lookup', () => {
		async function quoteFixture() {
			const actor = createRandomActor();
			resolver.register(actor.id, actor);
			const user = await personService.createPerson(actor.id, resolver);
			const quoted = { ...createRandomNote(actor), '@context': 'https://www.w3.org/ns/activitystreams' };
			const note = { ...createRandomNote(actor), quoteUrl: quoted.id };
			const realResolver = await apResolverService.createResolver();
			return { user, note, quoted, realResolver };
		}

		test('stores a quote fetched by the supplied Resolver', async () => {
			const { user, note, quoted, realResolver } = await quoteFixture();
			const fetch = vi.spyOn(httpRequestService, 'getActivityJson').mockResolvedValue(quoted);

			try {
				const stored = await noteService.createNote(note, user, realResolver, true);
				const storedQuote = await notesRepository.findOneByOrFail({ uri: quoted.id });

				assert.strictEqual(stored?.renoteId, storedQuote.id);
				assert.ok(realResolver.getHistory().includes(quoted.id));
			} finally {
				fetch.mockRestore();
			}
		});

		test('stores a parent and reply quoting the same deleted note after one lookup', async () => {
			const { user, note, quoted, realResolver } = await quoteFixture();
			const parent = { ...note, '@context': quoted['@context'] };
			const reply = { ...note, id: `${note.id}-reply`, inReplyTo: parent.id };
			const fetch = vi.spyOn(httpRequestService, 'getActivityJson').mockImplementation(async url => {
				if (url === parent.id) return parent;
				assert.strictEqual(url, quoted.id);
				throw new StatusError('Not Found', 404);
			});

			const storedReply = await noteService.createNote(reply, user, realResolver, true);

			const storedParent = await notesRepository.findOneByOrFail({ uri: parent.id });
			assert.ok(storedReply);
			assert.strictEqual(storedReply.replyId, storedParent.id);
			assert.strictEqual(storedReply.renoteId, null);
			assert.strictEqual(storedParent.renoteId, null);
			assert.deepStrictEqual(fetch.mock.calls.map(([url]) => url), [parent.id, quoted.id]);
		});

		test('applies the same lookup limit to the parent and its quote', async () => {
			const { user, note, quoted, realResolver } = await quoteFixture();
			const parent = { ...note, '@context': quoted['@context'] };
			const reply = { ...note, id: `${note.id}-reply`, inReplyTo: parent.id, quoteUrl: undefined };
			const fetch = vi.spyOn(httpRequestService, 'getActivityJson').mockImplementation(async url => ({ ...parent, id: url }));

			const limit = realResolver.getRecursionLimit();
			for (let i = 0; i < limit; i++) {
				await realResolver.resolve(`${parent.id}-fixture-${i}`);
			}
			fetch.mockClear();

			await assert.rejects(noteService.createNote(reply, user, realResolver, true), /^Error: quote resolve failed$/);

			assert.deepStrictEqual(fetch.mock.calls.map(([url]) => url), [parent.id]);
			assert.strictEqual(realResolver.getHistory().length, limit + 1);
			assert.strictEqual(await notesRepository.findOneBy({ uri: reply.id }), null);
			assert.strictEqual(await notesRepository.findOneBy({ uri: parent.id }), null);
		});
	});

	describe('Note attachments', () => {
		async function attachmentFixture() {
			const actor = createRandomActor();
			resolver.register(actor.id, actor);
			const user = await personService.createPerson(actor.id, resolver);
			const attachment: IApDocument[] = Array.from({ length: 33 }, (_, index) => ({
				type: 'Document',
				mediaType: 'image/png',
				url: `${actor.id}/files/${index}.png`,
				sensitive: index === 0 ? false : undefined,
			}));
			const note = { ...createRandomNote(actor), sensitive: true, attachment };
			return { user, note, attachment };
		}

		test('resolves up to 32 attachments in order when creating a note', async () => {
			const { user, note, attachment } = await attachmentFixture();
			const resolveImage = vi.spyOn(imageService, 'resolveImage').mockResolvedValue(null);

			assert.ok(await noteService.createNote(note, user, resolver, true));

			assert.deepStrictEqual(resolveImage.mock.calls.map(([, document]) => document), attachment.slice(0, 32));
			assert.strictEqual(attachment[0].sensitive, false);
			assert.strictEqual(attachment[31].sensitive, true);
			assert.strictEqual(attachment[32].sensitive, undefined);
		});

		test('resolves up to 32 attachments in order when updating a note', async () => {
			const { user, note, attachment } = await attachmentFixture();
			const stored = await noteService.createNote({ ...note, attachment: [] }, user, resolver, true);
			assert.ok(stored);
			const resolveImage = vi.spyOn(imageService, 'resolveImage').mockResolvedValue(null);

			const updated = await noteService.updateNote({ ...note, content: 'Updated note' }, stored, resolver, true);

			assert.strictEqual(updated?.text, 'Updated note');
			assert.deepStrictEqual(resolveImage.mock.calls.map(([, document]) => document), attachment.slice(0, 32));
		});
	});

	describe('Images', () => {
		test('Render image document with dimensions', () => {
			const rendered = rendererService.renderDocument({
				id: genAidx(Date.now()),
				type: 'image/png',
				webpublicType: null,
				url: 'https://example.test/files/image.png',
				webpublicUrl: null,
				comment: null,
				isSensitive: false,
				properties: { width: 3600, height: 1890 },
				uri: null,
				userHost: null,
				isLink: false,
				webpublicAccessKey: null,
			} as MiDriveFile);

			assert.strictEqual(rendered.type, 'Document');
			assert.strictEqual(rendered.mediaType, 'image/png');
			assert.strictEqual(rendered.width, 3600);
			assert.strictEqual(rendered.height, 1890);
		});

		test('Create images', async () => {
			const imageObject: IApDocument = {
				type: 'Document',
				mediaType: 'image/png',
				url: 'http://host1.test/foo.png',
				name: '',
			};
			const driveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				imageObject,
			);
			assert.ok(driveFile && !driveFile.isLink);

			const sensitiveImageObject: IApDocument = {
				type: 'Document',
				mediaType: 'image/png',
				url: 'http://host1.test/bar.png',
				name: '',
				sensitive: true,
			};
			const sensitiveDriveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				sensitiveImageObject,
			);
			assert.ok(sensitiveDriveFile && !sensitiveDriveFile.isLink);
		});

		test('cacheRemoteFiles=false disables caching', async () => {
			updateMeta({ ...metaInitial, cacheRemoteFiles: false });

			const imageObject: IApDocument = {
				type: 'Document',
				mediaType: 'image/png',
				url: 'http://host1.test/foo.png',
				name: '',
			};
			const driveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				imageObject,
			);
			assert.ok(driveFile && driveFile.isLink);

			const sensitiveImageObject: IApDocument = {
				type: 'Document',
				mediaType: 'image/png',
				url: 'http://host1.test/bar.png',
				name: '',
				sensitive: true,
			};
			const sensitiveDriveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				sensitiveImageObject,
			);
			assert.ok(sensitiveDriveFile && sensitiveDriveFile.isLink);
		});

		test('cacheRemoteSensitiveFiles=false only affects sensitive files', async () => {
			updateMeta({ ...metaInitial, cacheRemoteSensitiveFiles: false });

			const imageObject: IApDocument = {
				type: 'Document',
				mediaType: 'image/png',
				url: 'http://host1.test/foo.png',
				name: '',
			};
			const driveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				imageObject,
			);
			assert.ok(driveFile && !driveFile.isLink);

			const sensitiveImageObject: IApDocument = {
				type: 'Document',
				mediaType: 'image/png',
				url: 'http://host1.test/bar.png',
				name: '',
				sensitive: true,
			};
			const sensitiveDriveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				sensitiveImageObject,
			);
			assert.ok(sensitiveDriveFile && sensitiveDriveFile.isLink);
		});

		test('Link is not an attachment files', async () => {
			const linkObject: IObject = {
				type: 'Link',
				href: 'https://example.com/',
			};
			const driveFile = await imageService.createImage(
				await createRandomRemoteUser(resolver, personService),
				linkObject,
			);
			assert.strictEqual(driveFile, null);
		});
	});

	describe('JSON-LD', () => {
		test('Compaction', async () => {
			const jsonLd = jsonLdService.use();

			const object = {
				'@context': [
					'https://www.w3.org/ns/activitystreams',
					{
						_misskey_quote: 'https://misskey-hub.net/ns#_misskey_quote',
						unknown: 'https://example.org/ns#unknown',
						undefined: null,
					},
				],
				id: 'https://example.com/notes/42',
				type: 'Note',
				attributedTo: 'https://example.com/users/1',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				content: 'test test foo',
				_misskey_quote: 'https://example.com/notes/1',
				unknown: 'test test bar',
				undefined: 'test test baz',
			};
			const compacted = await jsonLd.compact(object);

			assert.deepStrictEqual(compacted, {
				'@context': CONTEXT,
				id: 'https://example.com/notes/42',
				type: 'Note',
				attributedTo: 'https://example.com/users/1',
				to: 'as:Public',
				content: 'test test foo',
				_misskey_quote: 'https://example.com/notes/1',
				'https://example.org/ns#unknown': 'test test bar',
				// undefined: 'test test baz',
			});
		});
	});
});
