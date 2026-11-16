/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';

// 직접 연 초대 화면. 요청은 실제 misskeyApi→fetch로 나가고, 화면을 연 것만으로는 가입 요청이 나가지 않아야 한다
const mocks = vi.hoisted(() => {
	type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;
	const state = {
		me: null as null | { id: string; username: string; token: string; policies: Record<string, unknown> },
		requests: [] as { endpoint: string; body: Record<string, unknown> }[],
		handlers: new Map<string, Handler>(),
		push: vi.fn(),
		alert: vi.fn(),
		pleaseLogin: vi.fn(),
	};
	vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.url;
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
vi.mock('@/stream.js', () => ({
	useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => ({ on: vi.fn(), off: vi.fn(), send: vi.fn(), dispose: vi.fn() }) }),
}));

import { url as localUrl } from '@@/js/config.js';
import XInvitePage from '@/pages/chat/invite.vue';
import MkAvatar from '@/components/global/MkAvatar.vue';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';

const CODE = 'ABCDEFGH12345678';
const PREVIEW = {
	name: 'Square club', description: 'Shapes and colors.', membersCount: 5, joinedRoomId: null as string | null,
	iconUrl: 'https://local.example/icon.png', iconBlurhash: null,
	iconDecorations: [{ id: 'shape', url: 'https://local.example/shape.png' }],
};

const stubs = {
	PageWithHeader: { template: '<div><slot/></div>' },
	MkLoading: { template: '<div>loading</div>' },
	MkResult: { props: ['type', 'text'], template: '<div :data-type="type">{{ text }}</div>' },
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const t = () => i18n.ts._chat._inviteLink;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function apiError(code: string) {
	return json({ error: { code, id: `id-${code}`, message: code } }, 400);
}

function requestsTo(endpoint: string) {
	return mocks.requests.filter(request => request.endpoint === endpoint);
}

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

function renderPage() {
	return render(XInvitePage, { props: { code: CODE }, global: { components: { MkAvatar }, stubs, directives: { tooltip: {}, 'user-preview': {} } } });
}

let testNumber = 0;

beforeEach(() => {
	prefer.commit('enableHighQualityImagePlaceholders', false);
	prefer.commit('showAvatarDecorations', true);
	prefer.commit('showRemoteAvatarDecorations', false);
	// 참여 상태는 계정·주소별로 모듈에 남는다. 시험마다 새 계정으로 앞 시험의 상태를 이어받지 않는다
	mocks.me = { id: `me-${++testNumber}`, username: 'me', token: 'my-token', policies: { chatAvailability: 'available' } };
	mocks.requests.length = 0;
	mocks.handlers.clear();
	mocks.push.mockReset();
	mocks.alert.mockReset();
	mocks.pleaseLogin.mockReset().mockResolvedValue(false);
	mocks.handlers.set('chat/invite-link/show', () => json(PREVIEW));
});

afterEach(() => {
	cleanup();
});

test('직접 화면의 공개 아이콘은 로컬 그룹으로 장식 설정을 따르고 그룹장 링크를 만들지 않는다', async () => {
	mocks.me = null;
	const { container } = renderPage();
	await screen.findByText(PREVIEW.name);

	expect(container.querySelector(`img[src="${PREVIEW.iconUrl}"]`)).not.toBeNull();
	expect(container.querySelector(`img[src="${PREVIEW.iconDecorations[0].url}"]`)).not.toBeNull();
	expect(container.querySelector('a')).toBeNull();

	prefer.commit('showAvatarDecorations', false);
	await nextTick();
	expect(container.querySelector(`img[src="${PREVIEW.iconDecorations[0].url}"]`)).toBeNull();
});

test.each(['iconUrl', 'iconBlurhash', 'iconDecorations'])('공개 아이콘 필드 %s가 빠진 직접 응답은 오류로 처리한다', async field => {
	const invalid: Record<string, unknown> = { ...PREVIEW };
	delete invalid[field];
	mocks.handlers.set('chat/invite-link/show', () => json(invalid));
	const { container } = renderPage();

	await waitFor(() => expect(container.querySelector('[data-type="error"]')).not.toBeNull());
	expect(screen.queryByRole('button', { name: i18n.ts._chat.join })).toBeNull();
	expect(requestsTo('chat/invite-link/join')).toHaveLength(0);
});

test('비로그인에게 이름·설명·멤버 수만 보이고 공개 미리보기 외 요청을 보내지 않는다', async () => {
	mocks.me = null;

	renderPage();

	await screen.findByText(PREVIEW.name);
	screen.getByText(PREVIEW.description);
	screen.getByText(i18n.tsx._chat._inviteLink.membersCount({ n: 5 }), { exact: false });
	await flush();
	expect(mocks.requests).toEqual([{ endpoint: 'chat/invite-link/show', body: { code: CODE } }]);
});

test('비로그인의 참여는 원격 절차 없이 로그인 유도만 한다', async () => {
	mocks.me = null;
	renderPage();

	await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.join }));

	await waitFor(() => expect(mocks.pleaseLogin).toHaveBeenCalledTimes(1));
	expect(mocks.pleaseLogin.mock.calls[0][0]?.openOnRemote).toBeUndefined();
	expect(requestsTo('chat/invite-link/join')).toHaveLength(0);
});

test('이미 멤버면 참여 대신 그룹 열기만 보인다', async () => {
	mocks.handlers.set('chat/invite-link/show', () => json({ ...PREVIEW, joinedRoomId: 'r1' }));
	renderPage();

	await fireEvent.click(await screen.findByRole('button', { name: t().openRoom }));

	expect(screen.queryByRole('button', { name: i18n.ts._chat.join })).toBeNull();
	expect(mocks.push).toHaveBeenCalledWith('/chat/room/:roomId', { params: { roomId: 'r1' } });
	expect(requestsTo('chat/invite-link/show')[0].body).toEqual({ code: CODE, i: 'my-token' });
	expect(requestsTo('chat/invite-link/join')).toHaveLength(0);
});

test('참여를 누르면 이 서버의 초대 주소로 join을 한 번 보내고 그 그룹을 연다', async () => {
	mocks.handlers.set('chat/invite-link/join', () => json({ status: 'joined', roomId: 'r5' }));
	renderPage();
	const button = await screen.findByRole('button', { name: i18n.ts._chat.join });
	await flush();
	expect(requestsTo('chat/invite-link/join')).toHaveLength(0);

	await fireEvent.click(button);
	await fireEvent.click(button);

	await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/chat/room/:roomId', { params: { roomId: 'r5' } }));
	expect(requestsTo('chat/invite-link/join')).toEqual([{ endpoint: 'chat/invite-link/join', body: { url: `${localUrl}/chat/invite/${CODE}`, i: 'my-token' } }]);
	expect(mocks.push).toHaveBeenCalledTimes(1);
});

test('없거나 폐기된 링크는 찾을 수 없다고 안내한다', async () => {
	mocks.handlers.set('chat/invite-link/show', () => apiError('NO_SUCH_INVITE_LINK'));

	renderPage();

	await screen.findByText(t().notFound);
	expect(screen.queryByRole('button', { name: i18n.ts._chat.join })).toBeNull();
});

test('참여가 거절되면 실제 사유를 알리고 이동하지 않는다', async () => {
	mocks.handlers.set('chat/invite-link/join', () => apiError('BANNED_FROM_ROOM'));
	renderPage();

	await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.join }));

	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: t().refusedBanned }));
	expect(t().refusedBanned).toEqual(expect.any(String));
	expect(mocks.push).not.toHaveBeenCalled();
});

test('참여 응답 전에 화면을 떠나면 이동하지 않는다', async () => {
	let resolveJoin!: (response: Response) => void;
	mocks.handlers.set('chat/invite-link/join', () => new Promise(resolve => { resolveJoin = resolve; }));
	const result = renderPage();
	await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.join }));
	await waitFor(() => expect(requestsTo('chat/invite-link/join')).toHaveLength(1));

	result.unmount();
	resolveJoin(json({ status: 'joined', roomId: 'r5' }));
	await flush();

	expect(mocks.push).not.toHaveBeenCalled();
});
