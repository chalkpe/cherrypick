/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';

// 그룹 정보의 초대 링크 관리. 요청은 실제 misskeyApi→fetch로 나간다
const mocks = vi.hoisted(() => {
	type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;
	const state = {
		me: { id: 'me', username: 'me', token: 'my-token', isAdmin: false, isModerator: false, policies: { chatAvailability: 'available' } },
		requests: [] as { endpoint: string; body: Record<string, unknown> }[],
		handlers: new Map<string, Handler[]>(),
		confirm: vi.fn(),
		alert: vi.fn(),
		writeText: vi.fn(),
	};
	vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.url;
		const endpoint = url.slice(url.indexOf('/api/') + '/api/'.length);
		const body = JSON.parse(String(init?.body ?? '{}'));
		state.requests.push({ endpoint, body });
		// 로그인한 상태로 설정 저장소를 불러올 때의 요청. 이 시험과는 관계없다
		if (endpoint === 'i/registry/get-all') return new Response('{}', { status: 200 });
		if (endpoint === 'i/registry/keys') return new Response('[]', { status: 200 });
		// 같은 endpoint를 여러 번 부르면 등록한 답을 차례로 쓰고, 마지막 답은 계속 쓴다
		const queue = state.handlers.get(endpoint);
		const handler = queue == null ? null : queue.length > 1 ? queue.shift()! : queue[0];
		if (handler == null) return new Response(JSON.stringify({ error: { code: 'UNEXPECTED_REQUEST', id: 'unexpected', message: endpoint } }), { status: 500 });
		return handler(body);
	}));
	return state;
});

vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/os.js', async importOriginal => ({ ...await importOriginal<typeof import('@/os.js')>(), confirm: mocks.confirm, alert: mocks.alert, toast: vi.fn() }));

import XInfo from '@/pages/chat/room.info.vue';
import MkAvatar from '@/components/global/MkAvatar.vue';
import { i18n } from '@/i18n.js';

const room = {
	id: 'r1', ownerId: 'me', owner: { id: 'me', username: 'hidden-owner', host: null },
	name: 'circle', description: '', isArchived: false, hasChannels: false, notificationLevel: 'all',
	iconUrl: 'https://local.example/icon.png', iconBlurhash: null,
	iconDecorations: [{ id: 'shape', url: 'https://local.example/shape.png' }],
};
const LINK = { url: 'https://local.example/chat/invite/ABCDEFGH12345678', code: 'ABCDEFGH12345678', createdAt: '2026-11-13T00:00:00.000Z' };
const OTHER_LINK = { url: 'https://local.example/chat/invite/ZYXWVUTS98765432', code: 'ZYXWVUTS98765432', createdAt: '2026-11-12T00:00:00.000Z' };

const stubs = {
	MkInput: { props: ['modelValue'], template: '<label><slot name="label"/><input :value="modelValue"/></label>' },
	MkTextarea: { props: ['modelValue'], template: '<label><slot name="label"/><textarea :value="modelValue"/></label>' },
	MkButton: { props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>' },
	MkSelect: { props: ['modelValue', 'items'], template: '<label><slot name="label"/><select :value="modelValue"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>' },
	// 실제 MkKeyValue처럼 키와 값을 각각의 요소에 그린다
	MkKeyValue: { template: '<div><div><slot name="key"/></div><div><slot name="value"/></div></div>' },
	MkInfo: { props: ['warn'], template: '<div :data-warn="warn"><slot/></div>' },
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const t = () => i18n.ts._chat._inviteLink;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function apiError(code: string) {
	return json({ error: { code, id: `id-${code}`, message: code } }, 400);
}

function answer(endpoint: string, ...handlers: (() => Response)[]) {
	mocks.handlers.set(endpoint, handlers);
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

function renderInfo(overrides: Record<string, unknown> = {}) {
	return render(XInfo, { props: { room: { ...room, ...overrides } as never }, global: { components: { MkAvatar }, stubs, directives: { tooltip: {}, 'user-preview': {} } } });
}

beforeEach(() => {
	mocks.requests.length = 0;
	mocks.handlers.clear();
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	mocks.alert.mockReset();
	mocks.writeText.mockReset();
	vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText: mocks.writeText } });
	answer('chat/rooms/channels/list', () => json([{ id: 'general', name: 'general' }]));
	answer('chat/rooms/notifications', () => json({ level: 'all', channelOverrides: [] }));
});

afterEach(() => {
	cleanup();
});

test.each([false, true])('관리 화면은 그룹 아이콘과 장식을 쓰고 그룹장 계정은 표시하지 않는다 (채널: %s)', async hasChannels => {
	answer('chat/rooms/invite-link/show', () => json(null));
	const { container } = renderInfo({ hasChannels });
	await screen.findByText(t().none);

	expect(container.querySelector(`img[src="${room.iconUrl}"]`)).not.toBeNull();
	expect(container.querySelector(`img[src="${room.iconDecorations[0].url}"]`)).not.toBeNull();
	expect(container.textContent).not.toContain('hidden-owner');
	expect(container.querySelector('a[href^="/@"]')).toBeNull();
});

test('활성 링크가 없으면 발급만 할 수 있고, 발급한 링크를 보여 준다', async () => {
	answer('chat/rooms/invite-link/show', () => json(null));
	answer('chat/rooms/invite-link/create', () => json(LINK));
	renderInfo();

	await screen.findByText(t().none);
	expect(screen.queryByRole('button', { name: t().revoke })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: t().create }));

	await screen.findByText(LINK.url);
	expect(requestsTo('chat/rooms/invite-link/show')).toEqual([{ endpoint: 'chat/rooms/invite-link/show', body: { roomId: 'r1', i: 'my-token' } }]);
	expect(requestsTo('chat/rooms/invite-link/create')).toEqual([{ endpoint: 'chat/rooms/invite-link/create', body: { roomId: 'r1', i: 'my-token' } }]);
	expect(requestsTo('chat/rooms/invite-link/revoke')).toHaveLength(0);
	expect(screen.queryByRole('button', { name: t().create })).toBeNull();
});

test('활성 링크가 있으면 주소와 복사·폐기를 보이고 발급은 없다', async () => {
	answer('chat/rooms/invite-link/show', () => json(LINK));
	renderInfo();

	await screen.findByText(LINK.url);
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.copyLink }));

	expect(mocks.writeText).toHaveBeenCalledWith(LINK.url);
	expect(screen.queryByRole('button', { name: t().create })).toBeNull();
	screen.getByRole('button', { name: t().revoke });
});

test('폐기는 확인을 거치며, 취소하면 요청하지 않고 폐기한 뒤 새로 발급하지 않는다', async () => {
	answer('chat/rooms/invite-link/show', () => json(LINK));
	answer('chat/rooms/invite-link/revoke', () => new Response(null, { status: 204 }));
	renderInfo();
	const revoke = await screen.findByRole('button', { name: t().revoke });

	mocks.confirm.mockResolvedValueOnce({ canceled: true });
	await fireEvent.click(revoke);
	await flush();
	expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', text: t().revokeConfirm }));
	expect(requestsTo('chat/rooms/invite-link/revoke')).toHaveLength(0);

	await fireEvent.click(revoke);

	await screen.findByText(t().none);
	expect(requestsTo('chat/rooms/invite-link/revoke')).toEqual([{ endpoint: 'chat/rooms/invite-link/revoke', body: { roomId: 'r1', i: 'my-token' } }]);
	expect(requestsTo('chat/rooms/invite-link/create')).toHaveLength(0);
	screen.getByRole('button', { name: t().create });
});

test('이미 링크가 있다는 오류면 알리고 서버의 기존 링크를 다시 읽어 보인다', async () => {
	answer('chat/rooms/invite-link/show', () => json(null), () => json(OTHER_LINK));
	answer('chat/rooms/invite-link/create', () => apiError('INVITE_LINK_ALREADY_EXISTS'));
	renderInfo();
	await screen.findByText(t().none);

	await fireEvent.click(screen.getByRole('button', { name: t().create }));

	await screen.findByText(OTHER_LINK.url);
	expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: t().alreadyExists });
	expect(t().alreadyExists).toEqual(expect.any(String));
	expect(requestsTo('chat/rooms/invite-link/create')).toHaveLength(1);
	expect(requestsTo('chat/rooms/invite-link/revoke')).toHaveLength(0);
});

test('이미 폐기된 링크를 폐기하면 알리고 없음으로 다시 읽는다', async () => {
	answer('chat/rooms/invite-link/show', () => json(LINK), () => json(null));
	answer('chat/rooms/invite-link/revoke', () => apiError('NO_SUCH_INVITE_LINK'));
	renderInfo();

	await fireEvent.click(await screen.findByRole('button', { name: t().revoke }));

	await screen.findByText(t().none);
	expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: t().alreadyRevoked });
	expect(t().alreadyRevoked).toEqual(expect.any(String));
});

test('보관 중에는 링크를 보이되 발급·폐기를 막고 보관 해제를 안내한다', async () => {
	answer('chat/rooms/invite-link/show', () => json(LINK));
	renderInfo({ isArchived: true });

	await screen.findByText(LINK.url);

	expect((screen.getByRole('button', { name: t().revoke }) as HTMLButtonElement).disabled).toBe(true);
	screen.getByText(t().archivedNote);
	expect(requestsTo('chat/rooms/invite-link/show')).toHaveLength(1);
});

test('보관 중 링크가 없으면 발급 버튼도 막는다', async () => {
	answer('chat/rooms/invite-link/show', () => json(null));
	renderInfo({ isArchived: true });

	await screen.findByText(t().none);

	expect((screen.getByRole('button', { name: t().create }) as HTMLButtonElement).disabled).toBe(true);
});

test('채널형 그룹도 같은 초대 링크 관리 화면을 쓴다', async () => {
	answer('chat/rooms/invite-link/show', () => json(LINK));
	renderInfo({ hasChannels: true });

	await screen.findByText(LINK.url);

	screen.getByRole('button', { name: t().revoke });
	screen.getByText(t().description);
});

test('그룹장이 아니면 초대 링크를 조회하거나 보이지 않는다', async () => {
	renderInfo({ ownerId: 'someone-else', owner: { id: 'someone-else', username: 'owner', host: null } });
	await flush();

	expect(requestsTo('chat/rooms/invite-link/show')).toHaveLength(0);
	expect(screen.queryByText(t().title)).toBeNull();
});
