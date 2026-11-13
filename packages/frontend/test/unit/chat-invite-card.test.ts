/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';

// 링크 카드에서 서버까지의 요청은 실제 misskeyApi→fetch로 나간다. 요청 본문에 내 자격 정보와 초대 주소가 실리는지 본다
const mocks = vi.hoisted(() => {
	type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;
	type Listener = (...args: unknown[]) => void;
	const state = {
		me: null as null | { id: string; username: string; token: string; policies: Record<string, unknown> },
		urlResponse: null as unknown,
		requests: [] as { endpoint: string; body: Record<string, unknown> }[],
		handlers: new Map<string, Handler>(),
		channelListeners: new Map<string, Set<Listener>>(),
		streamListeners: new Map<string, Set<Listener>>(),
		openChannels: 0,
		push: vi.fn(),
		alert: vi.fn(),
		pleaseLogin: vi.fn(),
	};
	vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.url;
		if (url.includes('/url?')) return new Response(JSON.stringify(state.urlResponse), { status: 200 });
		const endpoint = url.slice(url.indexOf('/api/') + '/api/'.length);
		const body = JSON.parse(String(init?.body ?? '{}'));
		state.requests.push({ endpoint, body });
		const handler = state.handlers.get(endpoint);
		if (handler == null) return new Response(JSON.stringify({ error: { code: 'UNEXPECTED_REQUEST', id: 'unexpected', message: endpoint } }), { status: 500 });
		return handler(body);
	}));
	return state;
});

vi.mock('@/i.js', async importOriginal => ({
	...await importOriginal<typeof import('@/i.js')>(),
	get $i() { return mocks.me; },
	ensureSignin: () => mocks.me,
}));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/utility/please-login.js', () => ({ pleaseLogin: mocks.pleaseLogin }));
vi.mock('@/preferences.js', async () => {
	const { createFakePrefer } = await import('./fake-prefer.js');
	return { prefer: createFakePrefer({
		animation: false, enableHighQualityImagePlaceholders: false,
		dataSaver: { media: false, avatar: false, urlPreview: false, code: false },
		showAvatarDecorations: true, showRemoteAvatarDecorations: true,
		mutedAvatarDecorationUsers: [], deidentifyMutedUsers: true,
	}) };
});
vi.mock('@/os.js', async importOriginal => ({ ...await importOriginal<typeof import('@/os.js')>(), alert: mocks.alert }));
vi.mock('@/stream.js', () => {
	function listen(map: Map<string, Set<(...args: unknown[]) => void>>, type: string, fn: (...args: unknown[]) => void) {
		if (!map.has(type)) map.set(type, new Set());
		map.get(type)!.add(fn);
	}

	return {
		useStream: () => ({
			on: (type: string, fn: (...args: unknown[]) => void) => listen(mocks.streamListeners, type, fn),
			off: (type: string, fn: (...args: unknown[]) => void) => mocks.streamListeners.get(type)?.delete(fn),
			useChannel: (name: string) => {
				if (name !== 'main') throw new Error(`unexpected channel ${name}`);
				const mine: [string, (...args: unknown[]) => void][] = [];
				mocks.openChannels++;
				return {
					on: (type: string, fn: (...args: unknown[]) => void) => { mine.push([type, fn]); listen(mocks.channelListeners, type, fn); },
					off: (type: string, fn: (...args: unknown[]) => void) => mocks.channelListeners.get(type)?.delete(fn),
					send: vi.fn(),
					dispose: () => {
						for (const [type, fn] of mine) mocks.channelListeners.get(type)?.delete(fn);
						mocks.openChannels--;
					},
				};
			},
		}),
	};
});

import { url as localUrl } from '@@/js/config.js';
import MkUrlPreview from '@/components/MkUrlPreview.vue';
import { components } from '@/components/index.js';
import { directives } from '@/directives/index.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { joinChatInvite } from '@/pages/chat/chat-invite-link.js';

const REMOTE = {
	url: 'https://remote.example/chat/invite/ABCDEFGH12345678',
	host: 'remote.example',
	code: 'ABCDEFGH12345678',
	name: 'Remote circle',
	description: 'We talk about squares.',
	membersCount: 3,
	iconUrl: 'https://remote.example/icon.png',
	iconBlurhash: null,
	iconDecorations: [{ id: 'shape', url: 'https://remote.example/shape.png' }],
	isLocal: false,
};
const LOCAL = {
	url: `${localUrl}/chat/invite/LOCALCODE1234567`,
	host: new URL(localUrl).host,
	code: 'LOCALCODE1234567',
	name: 'Local circle',
	description: 'Triangles only.',
	membersCount: 7,
	iconUrl: 'https://local.example/icon.png',
	iconBlurhash: null,
	iconDecorations: [{ id: 'shape', url: 'https://local.example/shape.png' }],
	isLocal: true,
};

const t = () => i18n.ts._chat._inviteLink;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function apiError(code: string) {
	return json({ error: { code, id: `id-${code}`, message: code } }, 400);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

function summaryOf(invite: typeof REMOTE | null, pageUrl = 'https://example.local/page') {
	return {
		url: invite?.url ?? pageUrl,
		title: invite?.name ?? 'A plain page',
		description: invite?.description ?? 'Nothing to join here.',
		sitename: invite == null ? 'Example' : null,
		icon: null,
		thumbnail: null,
		sensitive: false,
		player: { url: null, width: null, height: null, allow: [] },
		...(invite != null ? { chatInvite: invite } : {}),
	};
}

function renderCard(invite: typeof REMOTE | null, props: { showActions?: boolean } = {}) {
	mocks.urlResponse = summaryOf(invite);
	return render(MkUrlPreview, {
		props: { url: invite?.url ?? 'https://example.local/page', ...props },
		global: { directives, components, stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' } } },
	});
}

function requestsTo(endpoint: string) {
	return mocks.requests.filter(request => request.endpoint === endpoint);
}

function emitJoinResult(payload: Record<string, unknown>) {
	for (const fn of [...mocks.channelListeners.get('chatInviteJoinResult') ?? []]) fn(payload);
}

function emitReconnect() {
	for (const fn of [...mocks.streamListeners.get('_connected_') ?? []]) fn();
}

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

const joinButton = () => screen.findByRole('button', { name: i18n.ts._chat.join });
const openButton = () => screen.findByRole('button', { name: t().openRoom });

let testNumber = 0;

beforeEach(() => {
	prefer.commit('enableHighQualityImagePlaceholders', false);
	prefer.commit('showAvatarDecorations', true);
	prefer.commit('showRemoteAvatarDecorations', true);
	// 참여 상태는 계정·주소별로 모듈에 남는다. 시험마다 새 계정으로 앞 시험의 상태를 이어받지 않는다
	mocks.me = { id: `me-${++testNumber}`, username: 'me', token: 'my-token', policies: { chatAvailability: 'available' } };
	mocks.requests.length = 0;
	mocks.handlers.clear();
	mocks.push.mockReset();
	mocks.alert.mockReset();
	mocks.pleaseLogin.mockReset().mockResolvedValue(false);
	mocks.handlers.set('chat/invite-link/join-status', () => json({ status: 'none', roomId: null, reason: null }));
});

afterEach(() => {
	cleanup();
});

describe('일반 링크 카드는 베이스와 같다', () => {
	test('chatInvite가 없으면 참여 줄도 상태 조회도 없다', async () => {
		renderCard(null);

		await screen.findByText('A plain page');
		await flush();

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByText(i18n.tsx._chat._inviteLink.membersCount({ n: 3 }))).toBeNull();
		expect(mocks.requests).toEqual([]);
		expect(mocks.openChannels).toBe(0);
	});

	test('호버 미리보기(showActions=false)는 초대여도 참여 줄과 요청이 없다', async () => {
		renderCard(REMOTE, { showActions: false });

		await screen.findByText(REMOTE.name);
		await flush();

		expect(screen.queryByRole('button')).toBeNull();
		expect(mocks.requests).toEqual([]);
	});
});

describe('초대 카드', () => {
	test.each([REMOTE, LOCAL])('공개 아이콘과 장식은 기존 아바타 표시 설정을 따른다: $host', async invite => {
		const { container } = renderCard(invite);
		await joinButton();

		expect(container.querySelector(`img[src="${invite.iconUrl}"]`)).not.toBeNull();
		expect(container.querySelector(`img[src="${invite.iconDecorations[0].url}"]`)).not.toBeNull();

		prefer.commit('showRemoteAvatarDecorations', false);
		await nextTick();
		expect(container.querySelector(`img[src="${invite.iconDecorations[0].url}"]`) != null).toBe(invite.isLocal);
		expect(container.querySelector(`img[src="${invite.iconUrl}"]`)).not.toBeNull();

		prefer.commit('showAvatarDecorations', false);
		await nextTick();
		expect(container.querySelector(`img[src="${invite.iconDecorations[0].url}"]`)).toBeNull();
	});

	test.each(['iconUrl', 'iconBlurhash', 'iconDecorations'])('공개 아이콘 필드 %s가 빠지면 일반 카드로 둔다', async field => {
		const invalid: Record<string, unknown> = { ...REMOTE };
		delete invalid[field];
		mocks.urlResponse = { ...summaryOf(null), chatInvite: invalid };
		render(MkUrlPreview, { props: { url: REMOTE.url }, global: { directives, components } });

		await screen.findByText('A plain page');
		await flush();

		expect(screen.queryByText(i18n.tsx._chat._inviteLink.membersCount({ n: 3 }), { exact: false })).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
		expect(mocks.requests).toEqual([]);
	});

	test('그룹 이름·설명·멤버 수와 참여 버튼을 보이고 내 상태를 한 번 조회한다', async () => {
		renderCard(REMOTE);

		await joinButton();
		screen.getByText(REMOTE.name);
		screen.getByText(REMOTE.description);
		screen.getByText(i18n.tsx._chat._inviteLink.membersCount({ n: 3 }), { exact: false });
		await waitFor(() => expect(requestsTo('chat/invite-link/join-status')).toHaveLength(1));
		expect(requestsTo('chat/invite-link/join-status')[0].body).toEqual({ url: REMOTE.url, i: 'my-token' });
	});

	test('이 서버 초대 카드는 앱 안의 초대 화면으로 연결된다', async () => {
		renderCard(LOCAL);

		await joinButton();

		expect(screen.getByText(LOCAL.name).closest('a')?.getAttribute('href')).toBe('/chat/invite/LOCALCODE1234567');
	});

	test('참여를 두 번 눌러도 join은 한 번 나가고 joined면 그 그룹을 연다', async () => {
		const join = deferred<Response>();
		mocks.handlers.set('chat/invite-link/join', () => join.promise);
		renderCard(LOCAL);
		const button = await joinButton();

		await fireEvent.click(button);
		await fireEvent.click(button);
		join.resolve(json({ status: 'joined', roomId: 'r1' }));

		await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/chat/room/:roomId', { params: { roomId: 'r1' } }));
		expect(requestsTo('chat/invite-link/join')).toHaveLength(1);
		expect(requestsTo('chat/invite-link/join')[0].body).toEqual({ url: LOCAL.url, i: 'my-token' });
		expect(mocks.push).toHaveBeenCalledTimes(1);
	});

	test('pending이면 기다림을 보이고 스트림 결과로 그룹 열기가 된다. 저절로 이동하지 않는다', async () => {
		mocks.handlers.set('chat/invite-link/join', () => json({ status: 'pending', roomId: null }));
		renderCard(REMOTE);

		await fireEvent.click(await joinButton());
		await screen.findByText(t().pending);
		expect((screen.getByRole('button', { name: t().pendingButton }) as HTMLButtonElement).disabled).toBe(true);

		emitJoinResult({ url: REMOTE.url, status: 'joined', roomId: 'r9', reason: null });

		await fireEvent.click(await openButton());
		expect(mocks.push).toHaveBeenCalledTimes(1);
		expect(mocks.push).toHaveBeenCalledWith('/chat/room/:roomId', { params: { roomId: 'r9' } });
	});

	test('다른 주소의 스트림 결과는 이 카드를 바꾸지 않는다', async () => {
		renderCard(REMOTE);
		await joinButton();

		emitJoinResult({ url: 'https://remote.example/chat/invite/OTHERCODE1234567', status: 'joined', roomId: 'r9', reason: null });
		await flush();

		expect(screen.queryByRole('button', { name: t().openRoom })).toBeNull();
		screen.getByRole('button', { name: i18n.ts._chat.join });
	});

	test('같은 주소의 카드 둘은 상태와 요청을 함께 쓰고 누른 카드만 그룹으로 이동한다', async () => {
		const status = deferred<Response>();
		mocks.handlers.set('chat/invite-link/join-status', () => status.promise);
		mocks.handlers.set('chat/invite-link/join', () => json({ status: 'joined', roomId: 'r1' }));
		renderCard(REMOTE);
		renderCard(REMOTE);
		await waitFor(() => expect(screen.getAllByRole('button', { name: i18n.ts._chat.join })).toHaveLength(2));
		status.resolve(json({ status: 'none', roomId: null, reason: null }));

		await fireEvent.click(screen.getAllByRole('button', { name: i18n.ts._chat.join })[0]);

		await waitFor(() => expect(screen.getAllByRole('button', { name: t().openRoom })).toHaveLength(2));
		expect(requestsTo('chat/invite-link/join-status')).toHaveLength(1);
		expect(requestsTo('chat/invite-link/join')).toHaveLength(1);
		expect(mocks.push).toHaveBeenCalledTimes(1);
	});

	test('참여 응답 전에 카드가 사라지면 이동하지 않고, 카드가 모두 사라지면 스트림 구독을 놓는다', async () => {
		const join = deferred<Response>();
		mocks.handlers.set('chat/invite-link/join', () => join.promise);
		const result = renderCard(REMOTE);
		await fireEvent.click(await joinButton());
		expect(mocks.openChannels).toBe(1);

		result.unmount();
		join.resolve(json({ status: 'joined', roomId: 'r1' }));
		await flush();

		expect(mocks.push).not.toHaveBeenCalled();
		expect(mocks.openChannels).toBe(0);
	});

	test('응답 전에 계정이 바뀌면 그 응답으로 카드나 화면을 바꾸지 않는다', async () => {
		const join = deferred<Response>();
		mocks.handlers.set('chat/invite-link/join', () => join.promise);
		renderCard(REMOTE);
		await fireEvent.click(await joinButton());

		mocks.me = { id: 'someone-else', username: 'other', token: 'other-token', policies: { chatAvailability: 'available' } };
		join.resolve(json({ status: 'joined', roomId: 'r1' }));
		await flush();

		expect(mocks.push).not.toHaveBeenCalled();
		expect(mocks.alert).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: t().openRoom })).toBeNull();
	});

	test('늦게 도착한 상태 조회는 그 뒤에 온 스트림 결과를 덮지 않는다', async () => {
		const status = deferred<Response>();
		mocks.handlers.set('chat/invite-link/join-status', () => status.promise);
		renderCard(REMOTE);
		await joinButton();
		await waitFor(() => expect(requestsTo('chat/invite-link/join-status')).toHaveLength(1));

		emitJoinResult({ url: REMOTE.url, status: 'joined', roomId: 'r9', reason: null });
		await openButton();
		status.resolve(json({ status: 'pending', roomId: null, reason: null }));
		await flush();

		screen.getByRole('button', { name: t().openRoom });
		expect(screen.queryByText(t().pending)).toBeNull();
	});

	test('스트림이 다시 연결되면 기다리던 참여의 상태를 다시 읽어 거절 사유를 보인다', async () => {
		mocks.handlers.set('chat/invite-link/join', () => json({ status: 'pending', roomId: null }));
		renderCard(REMOTE);
		await fireEvent.click(await joinButton());
		await screen.findByText(t().pending);
		mocks.handlers.set('chat/invite-link/join-status', () => json({ status: 'refused', roomId: null, reason: 'banned' }));

		emitReconnect();

		await screen.findByText(t().refusedBanned);
		expect(requestsTo('chat/invite-link/join-status')).toHaveLength(2);
		expect((await joinButton() as HTMLButtonElement).disabled).toBe(false);
	});

	test('거절 상태에서 다시 누르면 새 참여 요청을 보낸다', async () => {
		mocks.handlers.set('chat/invite-link/join-status', () => json({ status: 'refused', roomId: null, reason: 'blocked' }));
		mocks.handlers.set('chat/invite-link/join', () => json({ status: 'pending', roomId: null }));
		renderCard(REMOTE);

		await screen.findByText(t().refusedBlocked);
		await fireEvent.click(await joinButton());

		await screen.findByText(t().pending);
		expect(requestsTo('chat/invite-link/join')).toHaveLength(1);
	});

	test('개별 초대로 남았으면 그룹을 열어 기존 초대 수락으로 이어 간다', async () => {
		mocks.handlers.set('chat/invite-link/join-status', () => json({ status: 'invited', roomId: 'r2', reason: null }));
		renderCard(REMOTE);

		await screen.findByText(t().invited);
		await fireEvent.click(await openButton());

		expect(mocks.push).toHaveBeenCalledWith('/chat/room/:roomId', { params: { roomId: 'r2' } });
		expect(requestsTo('chat/invite-link/join')).toHaveLength(0);
	});

	test.each([
		['NO_SUCH_INVITE_LINK', () => t().refusedRevoked],
		['ROOM_IS_ARCHIVED', () => t().refusedArchived],
		['BANNED_FROM_ROOM', () => t().refusedBanned],
		['BLOCKED_BY_ROOM_OWNER', () => t().refusedBlocked],
		['ROOM_IS_FULL', () => i18n.ts._chat.roomIsFull],
		['REMOTE_JOIN_UNAVAILABLE', () => t().remoteJoinUnavailable],
		['INVALID_INVITE_LINK', () => t().invalidLink],
		['ROLE_PERMISSION_DENIED', () => i18n.ts.permissionDeniedErrorDescription],
	])('참여 거절 %s는 실제 사유를 알린다', async (code, text) => {
		mocks.handlers.set('chat/invite-link/join', () => apiError(code));
		renderCard(REMOTE);

		await fireEvent.click(await joinButton());

		await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: text() }));
		expect(text()).toEqual(expect.any(String));
		expect(mocks.push).not.toHaveBeenCalled();
		expect((await joinButton() as HTMLButtonElement).disabled).toBe(false);
	});

	test.each([
		['revoked', () => t().refusedRevoked],
		['archived', () => t().refusedArchived],
		['full', () => i18n.ts._chat.roomIsFull],
		['unknown', () => t().refusedUnknown],
	])('스트림의 거절 사유 %s를 보인다', async (reason, text) => {
		renderCard(REMOTE);
		await joinButton();

		emitJoinResult({ url: REMOTE.url, status: 'refused', roomId: null, reason });

		await screen.findByText(text());
	});

	test('로그인하지 않았으면 상태를 묻지 않고 참여는 로그인 유도만 한다', async () => {
		mocks.me = null;
		renderCard(REMOTE);

		await fireEvent.click(await joinButton());

		await waitFor(() => expect(mocks.pleaseLogin).toHaveBeenCalledTimes(1));
		expect(mocks.pleaseLogin.mock.calls[0][0]?.openOnRemote).toBeUndefined();
		expect(mocks.requests).toEqual([]);
		expect(mocks.openChannels).toBe(0);
	});
});

describe('참여 상태 모듈', () => {
	test('같은 계정·주소의 참여 요청이 나가 있는 동안 다른 화면에서 다시 불러도 보내지 않는다', async () => {
		const join = deferred<Response>();
		mocks.handlers.set('chat/invite-link/join', () => join.promise);

		const first = joinChatInvite(REMOTE.url);
		const second = await joinChatInvite(REMOTE.url);
		join.resolve(json({ status: 'pending', roomId: null }));

		expect(second).toEqual({ kind: 'ignored' });
		expect(await first).toEqual({ kind: 'pending' });
		expect(requestsTo('chat/invite-link/join')).toHaveLength(1);
	});
});
