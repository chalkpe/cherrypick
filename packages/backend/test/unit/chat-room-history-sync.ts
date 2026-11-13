/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatRoomHistorySyncProcessorService } from '@/queue/processors/ChatRoomHistorySyncProcessorService.js';
import { ChatService } from '@/core/ChatService.js';
import { buildChatHistoryPage } from '@/core/activitypub/misc/chat-history.js';
import { StatusError } from '@/misc/status-error.js';
import type { IObject } from '@/core/activitypub/type.js';

vi.mock('@/misc/distributed-lock.js', () => ({ acquireApObjectLock: async () => async () => {} }));

// 받는 서버의 처리 순서와 판정만 본다. 저장과 실제 HTTP는 실제 DB 시험과 서버 사이 검증에서 따로 확인한다.
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
		findImported: vi.fn(async (uri: string) => options.existing?.has(uri) ? { uri } : null),
		importMessage: vi.fn(async (_room: unknown, input: Record<string, unknown>) => {
			imported.push(input);
			return { id: `stored-${imported.length}`, uri: input.uri };
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
	};
	const resolve = vi.fn(async (url: string) => {
		const page = options.pages?.get(url);
		if (page instanceof Error) throw page;
		if (page == null) throw new StatusError('Not Found', 404);
		return page;
	});
	const accounts = options.accounts ?? new Map<string, unknown>([[author.uri, author], [reactor.uri, reactor]]);
	const resolvePerson = vi.fn(async (uri: string) => {
		const account = accounts.get(uri);
		if (account instanceof Error) throw account;
		if (account == null) throw new StatusError('Gone', 410);
		return account;
	});
	const syncRoom = vi.fn(async () => 'ok');
	const createChatRoomHistorySyncJob = vi.fn();
	const applyPendingChatReactions = vi.fn(async () => {});
	const acquireLock = vi.fn(async (): Promise<string | null> => 'OK');
	const service = Object.assign(Object.create(ChatRoomHistorySyncProcessorService.prototype), {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
		redisClient: { set: acquireLock, get: vi.fn(async () => null), del: vi.fn(), expire: vi.fn() },
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
		apResolverService: { createResolver: async () => ({ signAs: vi.fn(), resolve }) },
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
		queueService: { createChatRoomHistorySyncJob },
	}) as ChatRoomHistorySyncProcessorService;

	const run = (attemptsMade = 0) => service.process({ data: { roomId: 'room1' }, attemptsMade, opts: { attempts: 8 } } as never);
	return { run, state, history, imported, resolve, resolvePerson, syncRoom, createChatRoomHistorySyncJob, applyPendingChatReactions, acquireLock };
}

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

		expect(imported.map(input => input.uri)).toEqual(['m3', 'm2', 'm1'].map(id => `https://member.test/chat/messages/${id}`));
		expect(state.status).toBe('completed');
		expect(applyPendingChatReactions).toHaveBeenCalledTimes(3);
	});

	test('한 번에 받는 페이지 수를 넘으면 이어서 받을 작업을 다시 넣는다', async () => {
		const cursor = (page: number) => `c${1000 - page}`;
		for (let i = 0; i < 30; i++) {
			const url = i === 0 ? first : `${roomUri}/history?until=${cursor(i)}`;
			pages.set(url, buildChatHistoryPage(roomUri, i === 0 ? null : cursor(i), [], cursor(i + 1)));
		}
		const { run, state, createChatRoomHistorySyncJob } = setup({ pages });

		expect(await run()).toBe('ok: continues');

		expect(state.nextUri).toBe(`${roomUri}/history?until=c975`);
		expect(createChatRoomHistorySyncJob).toHaveBeenCalledWith('room1', expect.any(Number));
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
		ctx.acquireLock.mockResolvedValueOnce(null);

		await expect(ctx.run()).rejects.toThrow();

		expect(ctx.state.status).toBe('running');
		expect(ctx.imported).toEqual([]);
		expect(await ctx.run(1)).toBe('ok: completed');
		expect(ctx.imported.map(input => input.uri)).toEqual(['https://member.test/chat/messages/m1']);
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

	test('작성자 서버의 일시적인 장애는 다시 시도하고, 마지막 시도에서는 글을 보존한다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
		const accounts = new Map<string, unknown>([[author.uri, new StatusError('Bad Gateway', 502)]]);
		const ctx = setup({ pages, accounts });

		await expect(ctx.run(0)).rejects.toThrow();
		expect(ctx.imported).toEqual([]);

		await ctx.run(7);
		expect(ctx.imported[0]).toMatchObject({ authorId: null, archivedAuthor: { uri: author.uri, username: null, name: null } });
	});

	test('캐시된 작성자가 삭제됐거나 응답하지 않으면 보관된 작성자로 글을 보존한다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1', {
			_misskey_chatAuthor: { name: '지난 이름', username: 'gone', host: 'member.test' },
		})], null));
		pages.set(author.uri, new StatusError('Not Found', 404));
		const ctx = setup({ pages, cachedAccounts: new Map([[author.uri, author]]) });

		await ctx.run();

		expect(ctx.imported[0]).toMatchObject({ authorId: null, archivedAuthor: { uri: author.uri, username: 'gone', name: '지난 이름' } });
	});

	test('캐시된 작성자가 살아 있으면 실제 계정으로 가져온다', async () => {
		pages.set(first, buildChatHistoryPage(roomUri, null, [note('m1')], null));
		pages.set(author.uri, { id: author.uri, type: 'Person' } as IObject);
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
});
