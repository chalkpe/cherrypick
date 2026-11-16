/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '@/config.js';
import { ChatRoomHistorySyncProcessorService } from '@/queue/processors/ChatRoomHistorySyncProcessorService.js';
import { ChatService } from '@/core/ChatService.js';
import { buildChatHistoryPage } from '@/core/activitypub/misc/chat-history.js';
import { StatusError } from '@/misc/status-error.js';
import type { IObject } from '@/core/activitypub/type.js';

vi.mock('@/misc/distributed-lock.js', () => ({ acquireApObjectLock: async () => async () => {} }));

// 받는 서버의 처리 순서와 판정만 본다. 저장과 실제 HTTP는 실제 DB 시험과 서버 사이 검증에서 따로 확인한다.
// 잠금과 진행 위치 판정(단일 JSON 키)은 이 시험 전용 접두사를 붙인 실제 Redis로 확인한다.
const prefix = `test-chatRoomHistorySync-${randomUUID()}:`;
let redis: Redis;
let raw: Redis;

const roomUri = 'https://owner.test/chat/rooms/room1';
const owner = { id: 'owner', host: 'owner.test', uri: 'https://owner.test/users/owner', isSuspended: false };
const signer = { id: 'me', host: null, isSuspended: false };
const author = { id: 'author', host: 'member.test', uri: 'https://member.test/users/a', isSuspended: false };
const reactor = { id: 'reactor', host: 'third.test', uri: 'https://third.test/users/r', isSuspended: false };

function note(id: string, overrides: Record<string, unknown> = {}): IObject {
	return {
		id: `https://member.test/chat/messages/${id}`,
		type: 'Note',
		attributedTo: author.uri,
		_misskey_content: `text ${id}`,
		_misskey_talk: true,
		published: '2026-11-01T00:00:00.000Z',
		context: roomUri,
		_misskey_chatRoom: roomUri,
		...overrides,
	} as IObject;
}

type Setup = {
	pages?: Map<string, IObject | Error>;
	accounts?: Map<string, unknown>;
	cachedAccounts?: Map<string, unknown>;
	existing?: Set<string>;
	signers?: unknown[];
	pass?: number;
	channel?: (value: unknown) => string | null | undefined;
};

function setup(options: Setup = {}) {
	const state = { roomId: 'room1', status: 'running', nextUri: null as string | null, pass: options.pass ?? 1 };
	const room = { id: 'room1', uri: roomUri, ownerId: owner.id, hasChannels: false, legacyChannelId: null };
	const imported: Record<string, unknown>[] = [];
	const history = {
		getState: vi.fn(async () => ({ ...state })),
		localMembers: vi.fn(async () => options.signers ?? [signer]),
		findExistingCopy: vi.fn(async (_roomId: string, sourceUri: string) => options.existing?.has(sourceUri) ? { uri: sourceUri } : null),
		importMessage: vi.fn(async (_room: unknown, input: Record<string, unknown>) => {
			imported.push(input);
			return { id: `stored-${imported.length}` };
		}),
		advance: vi.fn(async (_roomId: string, pass: number, nextUri: string | null) => {
			if (pass !== state.pass) return false;
			state.nextUri = nextUri;
			if (nextUri == null) state.status = 'completed';
			return true;
		}),
		markUnavailable: vi.fn(async () => {
			state.status = 'unavailable';
		}),
		enqueueImport: vi.fn(async () => {}),
	};
	let signedAs: string | null = null;
	const signAs = vi.fn((user: { id: string }) => {
		signedAs = user.id;
	});
	const resolve = vi.fn(async (url: string) => {
		const page = options.pages?.get(url);
		if (page instanceof Error) throw page;
		if (page != null) return page;
		throw new StatusError('Not Found', 404);
	});
	const accounts = options.accounts ?? new Map<string, unknown>([[author.uri, author], [reactor.uri, reactor]]);
	const resolvePerson = vi.fn(async (uri: string) => {
		const account = accounts.get(uri);
		if (account instanceof Error) throw account;
		if (account == null) throw new StatusError('Gone', 410);
		return account;
	});
	const syncRoom = vi.fn(async () => 'ok');
	const applyPendingChatReactions = vi.fn(async () => {});
	const service = Object.assign(Object.create(ChatRoomHistorySyncProcessorService.prototype), {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
		config: { url: 'https://here.test' },
		redisClient: redis,
		chatRoomsRepository: { findOneBy: vi.fn(async () => room), findOneByOrFail: vi.fn(async () => room) },
		usersRepository: { findOneBy: vi.fn(async () => owner) },
		emojisRepository: { findBy: vi.fn(async () => []), existsBy: vi.fn(async () => false) },
		chatService: { applyPendingChatReactions, normalizeRemoteReaction: ChatService.prototype.normalizeRemoteReaction },
		chatRoomChannelService: {
			remoteChannel: vi.fn(async (_room: unknown, value: unknown) => options.channel != null ? options.channel(value) : null),
			remoteRefs: vi.fn(async () => []),
		},
		chatRoomHistoryService: history,
		chatRoomRosterSyncProcessorService: { syncRoom },
		apResolverService: { createResolver: async () => ({ signAs, resolve }) },
		apDbResolverService: { getUserFromApId: vi.fn(async (uri: string) => options.cachedAccounts?.get(uri) ?? null) },
		apPersonService: { resolvePerson },
		apInboxService: { resolveChatAttachments: vi.fn(async () => ({ files: [], failed: true, temporarilyFailed: false })) },
		apNoteService: { extractEmojis: vi.fn() },
		apMfmService: { htmlToMfm: (html: string) => html },
		userEntityService: { isRemoteUser: (user: { host: string | null }) => user.host != null },
		utilityService: {
			punyHost: (uri: string) => new URL(uri).host,
			isSelfHost: (host: string) => host === 'here.test',
			extractDbHost: (uri: string) => new URL(uri).host,
		},
		hostPolicyService: { isRefusedRemoteHost: vi.fn(async () => false) },
		idService: { isSafeT: () => true },
	}) as ChatRoomHistorySyncProcessorService;

	const moveToDelayed = vi.fn(async () => {});
	const run = (attemptsMade = 0) => service.process({ data: { roomId: 'room1' }, attemptsMade, opts: { attempts: 8 }, token: 'job-token', moveToDelayed } as never);
	return { service, run, state, history, imported, resolve, resolvePerson, syncRoom, applyPendingChatReactions, moveToDelayed, signAs };
}

const lockKey = 'chat_room_history_lock:room1';
const progressKey = (pass: number) => `chat_room_history_progress:room1:${pass}`;

async function clearRedis() {
	const keys = await raw.keys(`${prefix}*`);
	if (keys.length > 0) await raw.del(...keys);
}

beforeAll(() => {
	const config = loadConfig();
	redis = new Redis({ ...config.redis, keyPrefix: prefix });
	raw = new Redis({ ...config.redis, keyPrefix: undefined });
});

beforeEach(clearRedis);

afterAll(async () => {
	await clearRedis();
	redis.disconnect();
	raw.disconnect();
});

const first = `${roomUri}/history`;
const second = `${roomUri}/history?until=c1`;

describe('과거 기록 가져오기 작업', () => {
	let pages: Map<string, IObject | Error>;

	beforeEach(() => {
		pages = new Map();
	});

	test('최근 글부터 next를 따라 끝까지 받고 끝나면 완료로 남긴다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m3'), note('m2')], 'c1'));
		pages.set(second, buildChatHistoryPage(roomUri, 'c1', [note('m1')], null));
		const { run, state, imported, applyPendingChatReactions } = setup({ pages });

		expect(await run()).toBe('ok: completed');

		expect(imported.map(input => input.sourceUri)).toEqual(['m3', 'm2', 'm1'].map(id => `https://member.test/chat/messages/${id}`));
		expect(state.status).toBe('completed');
		expect(applyPendingChatReactions).toHaveBeenCalledTimes(3);
		expect(await redis.exists(lockKey)).toBe(0);
		expect(await redis.exists(progressKey(1))).toBe(0);
	});

	test('한 번에 받는 페이지 수를 넘으면 같은 작업을 지연시켜 이어서 받는다', async () => {
		const cursor = (page: number) => `c${1000 - page}`;
		for (let i = 0; i < 30; i++) {
			const url = i === 0 ? first : `${roomUri}/history?until=${cursor(i)}`;
			pages.set(url, buildChatHistoryPage(roomUri, i === 0 ? null : cursor(i), [], cursor(i + 1)));
		}
		const { run, state, history, moveToDelayed } = setup({ pages });

		await expect(run()).rejects.toBeInstanceOf(DelayedError);

		expect(state.nextUri).toBe(`${roomUri}/history?until=c975`);
		expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'job-token');
		expect(history.enqueueImport).not.toHaveBeenCalled();
		expect(await redis.exists(lockKey)).toBe(0);
		// 이어서 받을 때 쓰도록 진행 위치는 남긴다. 글이 없는 페이지뿐이면 본 글 목록은 아직 없다
		expect(await redis.exists(progressKey(1))).toBe(1);
	});

	test('중단된 곳부터 이어 받는다', async () => {
		pages.set(second, buildChatHistoryPage(roomUri, 'c1', [note('m1')], null));
		const ctx = setup({ pages });
		ctx.state.nextUri = second;

		expect(await ctx.run()).toBe('ok: completed');
		expect(ctx.resolve).toHaveBeenCalledWith(second);
		expect(ctx.resolve).not.toHaveBeenCalledWith(first);
	});

	test('다른 작업이 잠금을 쥐고 있으면 완료로 버리지 않고 큐 재시도 뒤 기록을 받는다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
		const ctx = setup({ pages });
		await redis.set(lockKey, 'another-job', 'EX', 60);

		await expect(ctx.run()).rejects.toBeInstanceOf(DelayedError);

		expect(ctx.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'job-token');
		expect(ctx.state.status).toBe('running');
		expect(ctx.imported).toEqual([]);
		expect(await redis.get(lockKey)).toBe('another-job');

		await redis.del(lockKey);

		expect(await ctx.run(0)).toBe('ok: completed');
		expect(ctx.imported.map(input => input.sourceUri)).toEqual(['https://member.test/chat/messages/m1']);
	});

	test('이미 있는 글은 소유 서버가 다른 내용을 내줘도 저장하지 않는다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', { _misskey_content: 'forged' })], null));
		const { run, imported } = setup({ pages, existing: new Set(['https://member.test/chat/messages/m1']) });

		await run();

		expect(imported).toEqual([]);
	});

	test.each([
		['AP 문서가 아닌 응답을 주는 이전 버전 소유 서버', new Error('Content type is not application/activity+json or application/ld+json')],
		['형식이 맞지 않는 응답', new Error('invalid response')],
	])('%s면 바로 더 가져올 수 없다고 남긴다', async (_, error) => {
		pages.set(first, error);
		const { run, state, imported } = setup({ pages });

		await run();

		expect(state.status).toBe('unavailable');
		expect(imported).toEqual([]);
	});

	test('소유 서버가 아직 멤버로 세지 않으면(수락 처리 전) 다시 묻고, 마지막 시도까지 안 되면 더 가져올 수 없다고 남긴다', async () => {
		pages.set(first, new StatusError('Not Found', 404));
		const ctx = setup({ pages, signers: [signer, { ...signer, id: 'me2' }] });

		await expect(ctx.run(0)).rejects.toThrow();
		expect(ctx.state.status).toBe('running');
		expect(ctx.resolve).toHaveBeenCalledTimes(2);

		await ctx.run(7);
		expect(ctx.state.status).toBe('unavailable');
	});

	test('다른 그룹의 페이지는 쓰지 않는다', async () => {
		pages.set(first, { ...buildChatHistoryPage(roomUri, null, [note('m1')], null), partOf: 'https://owner.test/chat/rooms/room2/history' } as IObject);
		const { run, state, imported } = setup({ pages });

		await run();

		expect(state.status).toBe('unavailable');
		expect(imported).toEqual([]);
	});

	test('일시적인 실패는 큐의 재시도로 다시 받고, 마지막 시도에서도 실패하면 더 가져올 수 없다고 남긴다', async () => {
		pages.set(first, new StatusError('Service Unavailable', 503));
		const ctx = setup({ pages });

		await expect(ctx.run(0)).rejects.toThrow();
		expect(ctx.state.status).toBe('running');

		await ctx.run(7);
		expect(ctx.state.status).toBe('unavailable');
	});

	test('이 서버의 멤버가 없으면 서명할 사람이 없으므로 받지 않는다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
		const { run, resolve } = setup({ pages, signers: [] });

		expect(await run()).toBe('skip: nobody here is in the room');
		expect(resolve).not.toHaveBeenCalled();
	});

	test('작성자 계정을 확인할 수 없으면 소유 서버가 보관한 작성자 정보로 글을 보존하고 첨부는 받을 수 없다고 남긴다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
			attributedTo: 'https://member.test/users/gone',
			_misskey_chatAuthor: { name: '지난 이름', username: 'gone', host: 'member.test' },
			attachment: [{ type: 'Document', url: 'https://member.test/files/1.png' }],
		})], null));
		const { run, imported } = setup({ pages });

		await run();

		expect(imported).toHaveLength(1);
		expect(imported[0]).toMatchObject({
			authorId: null,
			archivedAuthor: { uri: 'https://member.test/users/gone', username: 'gone', name: '지난 이름', host: 'member.test' },
			fileIds: [],
			unavailableFileCount: 1,
		});
	});

	test('작성자 서버가 일시적으로 장애여도 다시 묻지 않고 보관 작성자로 보존한다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
		const accounts = new Map<string, unknown>([[author.uri, new StatusError('Bad Gateway', 502)]]);
		const ctx = setup({ pages, accounts });

		expect(await ctx.run(0)).toBe('ok: completed');
		expect(ctx.resolvePerson).toHaveBeenCalledTimes(1);
		expect(ctx.imported[0]).toMatchObject({ authorId: null, archivedAuthor: { uri: author.uri, username: null, name: null } });
	});

	test('캐시된 작성자는 다시 확인하지 않고 실제 계정으로 가져온다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
		pages.set(author.uri, new StatusError('Not Found', 404));
		const ctx = setup({ pages, cachedAccounts: new Map([[author.uri, author]]) });

		await ctx.run();

		expect(ctx.imported[0]).toMatchObject({ authorId: author.id, archivedAuthor: null });
		expect(ctx.resolve).not.toHaveBeenCalledWith(author.uri);
		expect(ctx.resolvePerson).not.toHaveBeenCalled();
	});

	test('캐시된 계정이 삭제 표시면 보관된 작성자로 글을 보존한다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
			_misskey_chatAuthor: { name: '지난 이름', username: 'gone', host: 'member.test' },
		})], null));
		const ctx = setup({ pages, cachedAccounts: new Map([[author.uri, { ...author, isDeleted: true }]]) });

		await ctx.run();

		expect(ctx.imported[0]).toMatchObject({ authorId: null, archivedAuthor: { uri: author.uri, username: 'gone', name: '지난 이름' } });
	});

	test.each([
		['완전한 보관 정보', { name: '지난 이름', username: 'gone', host: 'member.test' }, { name: '지난 이름', username: 'gone' }],
		['보관 정보 없음', undefined, { name: null, username: null }],
		['형식이 틀린 보관 정보', { name: 1, username: 'gone', host: 'member.test' }, { name: null, username: null }],
	])('보관 표시가 있는 기록은 %s이어도 작성자 조회 없이 보관 작성자로 받는다', async (_label, authorInfo, expected) => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
			_misskey_chatAuthorArchived: true,
			_misskey_chatAuthor: authorInfo,
		})], null));
		const ctx = setup({ pages, cachedAccounts: new Map([[author.uri, author]]) });

		await ctx.run();

		expect(ctx.imported[0]).toMatchObject({ authorId: null, archivedAuthor: { uri: author.uri, host: 'member.test', ...expected } });
		expect(ctx.resolvePerson).not.toHaveBeenCalled();
	});

	test.each([undefined, false, 'true', 1])('보관 표시가 정확한 true가 아니면 기존 작성자 확인을 유지한다: %s', async marker => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', { _misskey_chatAuthorArchived: marker })], null));
		const ctx = setup({ pages, cachedAccounts: new Map([[author.uri, author]]) });

		await ctx.run();

		expect(ctx.imported[0]).toMatchObject({ authorId: author.id, archivedAuthor: null });
	});

	test('리액션은 확인한 계정의 것만, 작성자 자신과 받는 서버 계정의 것은 빼고 저장한다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
			_misskey_chatReactions: [
				{ actor: reactor.uri, reaction: '👍' },
				{ actor: reactor.uri, reaction: '👍' },
				{ actor: author.uri, reaction: '🎉' },
				{ actor: 'https://here.test/users/me', reaction: '❤' },
				{ actor: 'https://unknown.test/users/x', reaction: '😀' },
				{ actor: reactor.uri, reaction: ':blob:' },
			],
		})], null));
		const { run, imported } = setup({ pages });

		await run();

		expect(imported[0].reactions).toEqual([`${reactor.id}/👍`, `${reactor.id}/:blob@third.test:`]);
	});

	test('모르는 채널은 그룹 객체를 한 번 다시 읽고 그래도 없으면 그 글만 버린다', async () => {
		const known = `${roomUri}/channels/known`;
		pages.set(first, buildChatHistoryPage(roomUri, null, [
			note('m1', { _misskey_chatChannel: `${roomUri}/channels/unknown` }),
			note('m2', { _misskey_chatChannel: known }),
		], null));
		const { run, imported, syncRoom } = setup({ pages, channel: value => value === known ? 'channel-known' : undefined });

		await run();

		expect(syncRoom).toHaveBeenCalledTimes(1);
		expect(imported.map(input => input.toRoomChannelId)).toEqual(['channel-known']);
	});

	test('받는 도중 처음부터 다시 받기로 바뀌면 그 작업은 진행 위치를 덮어쓰지 않고 멈춘다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], 'c1'));
		const ctx = setup({ pages });
		ctx.history.advance.mockResolvedValueOnce(false);

		expect(await ctx.run()).toBe('skip: started over');
		expect(ctx.state.nextUri).toBeNull();
	});

	describe('호스트 기록 신뢰와 사본 저장', () => {
		const messageUri = 'https://member.test/chat/messages/m1';

		test('소유 서버가 보관한 자기 글도 출처 확인 없이 사본으로 저장한다', async () => {
			const ownUri = 'https://owner.test/chat/messages/m1';
			pages.set(first, buildChatHistoryPage(roomUri, null, [{ ...note('m1'), id: ownUri, attributedTo: owner.uri } as IObject], null));
			const { run, imported, resolve } = setup({ pages, accounts: new Map([[author.uri, author], [reactor.uri, reactor], [owner.uri, owner]]) });

			await run();

			expect(imported.map(input => input.sourceUri)).toEqual([ownUri]);
			expect(imported[0]).toMatchObject({ authorId: owner.id, archivedAuthor: null });
			expect(resolve).not.toHaveBeenCalledWith(ownUri);
		});

		test('제3 서버의 글은 출처 확인 없이 사본으로 저장한다', async () => {
			pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
			const { run, imported, resolve } = setup({ pages });

			await run();

			expect(resolve).not.toHaveBeenCalledWith(messageUri);
			expect(imported[0]).toMatchObject({ sourceUri: messageUri, authorId: author.id, archivedAuthor: null });
		});

		test('소유 서버가 내준 본문·첨부·시각을 그대로 믿는다', async () => {
			pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
				_misskey_content: 'host snapshot',
				published: '2026-11-02T00:00:00.000Z',
				updated: '2026-11-03T00:00:00.000Z',
				attachment: [
					{ type: 'Document', url: 'https://member.test/files/1.png' },
					{ type: 'Document', url: 'https://member.test/files/2.png' },
				],
				_misskey_chatReactions: [{ actor: reactor.uri, reaction: '👍' }],
			})], null));
			const { run, imported } = setup({ pages });

			await run();

			expect(imported[0]).toMatchObject({
				sourceUri: messageUri,
				text: 'host snapshot',
				published: new Date('2026-11-02T00:00:00.000Z'),
				editedAt: new Date('2026-11-03T00:00:00.000Z'),
				unavailableFileCount: 2,
				reactions: [`${reactor.id}/👍`],
			});
		});

		test('작성자 서버가 글을 내주지 않아도(404) 사본으로 저장한다', async () => {
			pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
			pages.set(messageUri, new StatusError('Not Found', 404));
			const { run, imported } = setup({ pages });

			await run();

			expect(imported).toHaveLength(1);
			expect(imported[0]).toMatchObject({ sourceUri: messageUri, authorId: author.id });
		});

		test('보관 표시가 있으면 작성자 조회 없이 보관 작성자로 저장한다', async () => {
			pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
				_misskey_chatAuthorArchived: true,
				_misskey_chatAuthor: { name: '지난 이름', username: 'gone', host: 'member.test' },
			})], null));
			const ctx = setup({ pages, cachedAccounts: new Map([[author.uri, author]]) });

			await ctx.run();

			expect(ctx.imported[0]).toMatchObject({ sourceUri: messageUri, authorId: null, archivedAuthor: { uri: author.uri, username: 'gone', name: '지난 이름', host: 'member.test' } });
			expect(ctx.resolvePerson).not.toHaveBeenCalled();
		});
	});
});

describe('과거 기록 가져오기의 진행 없는 페이지 판정', () => {
	type Progress = { pagesWithoutProgress(roomId: string, pass: number, page: string, items: unknown[]): Promise<number> };

	const pageUri = (index: number) => index === 0 ? first : `${roomUri}/history?until=c${1000 - index}`;
	const cursorOf = (index: number) => index === 0 ? null : `c${1000 - index}`;

	/** index번째 페이지부터 last번째까지 이어지는 기록. items에 없는 페이지는 비어 있다. */
	function chain(last: number, items = new Map<number, IObject[]>()) {
		const pages = new Map<string, IObject | Error>();
		for (let i = 0; i <= last; i++) {
			pages.set(pageUri(i), buildChatHistoryPage(roomUri, cursorOf(i), items.get(i) ?? [], i === last ? null : `c${1000 - (i + 1)}`));
		}
		return pages;
	}

	/** 한 번에 받는 페이지 수를 넘으면 같은 작업을 지연시켜 이으므로, 끝나거나 멈출 때까지 작업을 되풀이한다. */
	async function runUntilSettled(ctx: ReturnType<typeof setup>) {
		for (let i = 0; i < 20 && ctx.state.status === 'running'; i++) {
			try {
				await ctx.run();
			} catch (err) {
				if (!(err instanceof DelayedError)) throw err;
			}
		}
	}

	/** 기록 페이지를 받은 횟수 */
	const pageFetches = (ctx: ReturnType<typeof setup>) => ctx.resolve.mock.calls.filter(([url]) => (url as string).startsWith(`${roomUri}/history`)).length;

	test('새 글이 없는 페이지가 연속 101쪽 나오면 더 가져올 수 없다고 남기고 그 페이지는 저장하지 않는다', async () => {
		const ctx = setup({ pages: chain(150) });

		await runUntilSettled(ctx);

		expect(ctx.state.status).toBe('unavailable');
		expect(ctx.resolve).toHaveBeenCalledTimes(101);
		expect(ctx.imported).toEqual([]);
	});

	test('중간에 새 글이 나오면 세던 횟수를 처음부터 다시 센다', async () => {
		const ctx = setup({ pages: chain(160, new Map([[80, [note('m1')]]])) });

		await runUntilSettled(ctx);

		expect(ctx.state.status).toBe('completed');
		expect(pageFetches(ctx)).toBe(161);
		expect(ctx.imported.map(input => input.sourceUri)).toEqual(['https://member.test/chat/messages/m1']);
		expect(await redis.exists(progressKey(1))).toBe(0);
	});

	test('같은 내용이 되풀이되는 페이지는 새 글로 세지 않는다', async () => {
		const repeated = note('m1');
		const ctx = setup({ pages: chain(150, new Map(Array.from({ length: 150 }, (_, i) => [i, [repeated]] as [number, IObject[]]))) });

		await runUntilSettled(ctx);

		expect(ctx.state.status).toBe('unavailable');
		// 첫 페이지의 글만 새 글이고, 그 뒤로 연속 101쪽이 지나면 멈춘다
		expect(pageFetches(ctx)).toBe(102);
	});

	test('같은 페이지를 재시도해도 한 번만 세고 다음 페이지부터 더한다', async () => {
		const { service } = setup();
		const progress = service as unknown as Progress;

		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(0), [])).toBe(1);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(0), [])).toBe(1);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(1), [])).toBe(2);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(1), [])).toBe(2);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(2), [])).toBe(3);
	});

	test('새 내용이면 0으로 돌아가고 같은 내용이 되풀이되면 다시 센다', async () => {
		const { service } = setup();
		const progress = service as unknown as Progress;

		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(0), [])).toBe(1);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(1), [{ id: 'a' }])).toBe(0);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(2), [{ id: 'a' }])).toBe(1);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(3), [{ id: 'a' }])).toBe(2);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(4), [{ id: 'b' }])).toBe(0);
	});

	test('서로 다른 내용이 교대로 오면 진행으로 본다 (감사가 수용한 정밀도 손실)', async () => {
		const { service } = setup();
		const progress = service as unknown as Progress;

		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(0), [{ id: 'a' }])).toBe(0);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(1), [{ id: 'b' }])).toBe(0);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(2), [{ id: 'a' }])).toBe(0);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(3), [{ id: 'b' }])).toBe(0);
	});

	test('처음부터 다시 받는 차례와 다른 그룹은 따로 센다', async () => {
		const { service } = setup();
		const progress = service as unknown as Progress;

		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(0), [{ id: 'a' }])).toBe(0);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(1), [])).toBe(1);

		expect(await progress.pagesWithoutProgress('room1', 2, pageUri(0), [{ id: 'a' }])).toBe(0);
		expect(await progress.pagesWithoutProgress('room2', 1, pageUri(0), [])).toBe(1);
		expect(await progress.pagesWithoutProgress('room1', 1, pageUri(2), [])).toBe(2);
	});

	test('진행 기록은 사라지는 기한을 가진다', async () => {
		const { service } = setup();
		const progress = service as unknown as Progress;

		await progress.pagesWithoutProgress('room1', 1, pageUri(0), [{ id: 'a' }]);

		const week = 7 * 24 * 60 * 60;
		const ttl = await raw.ttl(`${prefix}${progressKey(1)}`);
		expect(ttl).toBeGreaterThan(week - 60);
		expect(ttl).toBeLessThanOrEqual(week);
	});
});
