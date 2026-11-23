/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import MkNote from '@/components/MkNote.vue';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';
import { prefer } from '@/preferences.js';
import { PreferencesManager } from '@/preferences/manager.js';

const mocks = vi.hoisted(() => ({
	contextMenu: vi.fn(() => Promise.resolve()),
	popupMenu: vi.fn(() => Promise.resolve()),
	getNoteMenu: vi.fn(() => ({ menu: [], cleanup: () => {} })),
	pickerShow: vi.fn(),
	io: {
		load: () => null,
		save: () => {},
		cloudGet: async () => null,
		cloudGetBulk: async () => ({}),
		cloudSet: async () => {},
	},
}));

vi.mock('@/os.js', () => ({ contextMenu: mocks.contextMenu, popupMenu: mocks.popupMenu }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show: mocks.pickerShow } }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-note-menu.js', () => ({ getNoteMenu: mocks.getNoteMenu }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/router.js', () => ({ useRouter: () => ({}), mainRouter: { currentRoute: { value: { name: 'index' } } } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn().mockResolvedValue([]), misskeyApiGet: vi.fn().mockResolvedValue([]) }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', mutedWords: [], hardMutedWords: [], policies: {} } }));
vi.mock('@/store.js', () => ({ store: { s: { realtimeMode: false } } }));
vi.mock('@@/js/interval.js', () => ({ createVisibilityAwareInterval: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ send: vi.fn(), on: vi.fn(), off: vi.fn() }) }));
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager(mocks.io, { id: 'viewer' }) };
});

const note = {
	id: 'note', createdAt: new Date().toISOString(), text: 'text', cw: null,
	userId: 'author', user: { id: 'author', username: 'author', host: null, avatarDecorations: [] },
	visibility: 'public', localOnly: false, renoteId: null, renote: null, replyId: null,
	files: [], fileIds: [], reactions: {}, reactionEmojis: {}, reactionCount: 0,
	myReaction: null, repliesCount: 0, renoteCount: 0,
} as unknown as Misskey.entities.Note;

type Input = 'mouse' | 'pen' | 'touch' | 'touch-mouseevent' | 'mouse-from-touch' | 'unknown-from-touch' | 'keyboard' | 'mouseevent-plain';

/** 입력 출처 정보(sourceCapabilities)는 happy-dom 이 만들지 않으므로 직접 붙인다 */
function withTouchSource(ev: Event, firesTouchEvents: boolean): Event {
	Object.defineProperty(ev, 'sourceCapabilities', { value: { firesTouchEvents } });
	return ev;
}

/** 브라우저가 보내는 contextmenu 의 형태를 재현한다 */
function contextmenu(input: Input): Event {
	const init = { bubbles: true, cancelable: true };
	switch (input) {
		case 'mouse':
		case 'pen':
		case 'touch':
			return new PointerEvent('contextmenu', { ...init, pointerType: input });
		case 'keyboard':
			// Shift+F10 / 메뉴 키는 pointerType 이 빈 문자열이고 터치 출처도 아니다
			return withTouchSource(new PointerEvent('contextmenu', { ...init, pointerType: '' }), false);
		case 'mouse-from-touch':
			// 일부 구형 Chromium 은 터치 유래 contextmenu 의 pointerType 을 'mouse' 로 보낸다
			return withTouchSource(new PointerEvent('contextmenu', { ...init, pointerType: 'mouse' }), true);
		case 'unknown-from-touch':
			return withTouchSource(new PointerEvent('contextmenu', { ...init, pointerType: '' }), true);
		case 'touch-mouseevent':
			// pointerType 이 없는 MouseEvent 로 전달되고 입력 출처만 터치를 나타낸다
			return withTouchSource(new MouseEvent('contextmenu', init), true);
		case 'mouseevent-plain':
			return withTouchSource(new MouseEvent('contextmenu', init), false);
	}
}

const stubs = {
	MkNoteHeader: true,
	MkA: { template: '<a><slot /></a>' },
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
	MkUserName: true, MkAvatar: true, MkAcct: true, MkTime: true,
	I18n: true, MkLoading: true, MkResult: true,
	MkNoteSub: true, MkNoteSimple: true, MkReactionsViewer: true,
	MkMediaList: true, MkCwButton: true, MkPoll: true, MkUrlPreview: true,
	MkEvent: true, MkInfo: true, MkInstanceTicker: true, MkUserCardMini: true,
	MkPagination: true, MkReactionIcon: true, MkButton: true,
	MkPostForm: true, MkNoteHistory: true, MkSwitch: true,
};

function mount(component: typeof MkNote | typeof MkNoteDetailed) {
	const { container } = render(component, {
		props: { note },
		global: { directives: { tooltip: {}, 'user-preview': {}, hotkey: {}, 'adaptive-bg': {} }, stubs },
	});
	const article = container.querySelector('article')!;
	expect(article).not.toBeNull();
	return { container, article };
}

beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('openNoteMenuOnLongPress', true);
	prefer.commit('useReactionPickerForContextMenu', false);
	mocks.contextMenu.mockClear();
	mocks.popupMenu.mockClear();
	mocks.getNoteMenu.mockClear();
	mocks.pickerShow.mockClear();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe.each([['MkNote', MkNote], ['MkNoteDetailed', MkNoteDetailed]] as const)('%s 길게 누르기 메뉴', (_name, component) => {
	test('설정 키가 없는 기존 프로필은 켜짐으로 열려 손가락 입력에서도 기존처럼 메뉴가 열린다', async () => {
		// 다른 키만 저장된 기존 프로필을 불러와도 기본값(켜짐)이 채워진다
		const legacy = new PreferencesManager({
			...mocks.io,
			load: () => ({ id: 'viewer', version: 'old', type: 'main', modifiedAt: 0, name: 'legacy', preferences: { useReactionPickerForContextMenu: [[{}, false, {}]] } }),
		}, { id: 'viewer' });
		expect(legacy.s.openNoteMenuOnLongPress).toBe(true);
		prefer.commit('openNoteMenuOnLongPress', legacy.s.openNoteMenuOnLongPress);

		const { article } = mount(component);
		article.dispatchEvent(contextmenu('touch'));
		await nextTick();
		expect(mocks.contextMenu).toHaveBeenCalledTimes(1);
	});

	test.each(['touch', 'touch-mouseevent', 'mouse-from-touch', 'unknown-from-touch'] as const)('끄면 %s 입력에서는 메뉴가 열리지 않는다', async (input) => {
		prefer.commit('openNoteMenuOnLongPress', false);
		const { article } = mount(component);
		const ev = contextmenu(input);
		article.dispatchEvent(ev);
		await nextTick();
		expect(mocks.contextMenu).not.toHaveBeenCalled();
		expect(mocks.getNoteMenu).not.toHaveBeenCalled();
		expect(ev.defaultPrevented).toBe(false);
	});

	test('끄면 손가락 입력에서는 리액션 선택기도 열리지 않는다', async () => {
		prefer.commit('openNoteMenuOnLongPress', false);
		prefer.commit('useReactionPickerForContextMenu', true);
		const { article } = mount(component);
		const ev = contextmenu('touch');
		article.dispatchEvent(ev);
		await nextTick();
		expect(mocks.pickerShow).not.toHaveBeenCalled();
		expect(ev.defaultPrevented).toBe(false);
	});

	test('켜져 있으면 손가락 입력에서 리액션 선택기가 열린다', async () => {
		prefer.commit('useReactionPickerForContextMenu', true);
		const { article } = mount(component);
		const ev = contextmenu('touch');
		article.dispatchEvent(ev);
		await nextTick();
		expect(mocks.pickerShow).toHaveBeenCalledTimes(1);
		expect(ev.defaultPrevented).toBe(true);
	});

	test.each(['mouse', 'pen', 'keyboard', 'mouseevent-plain'] as const)('끄더라도 %s 입력에서는 메뉴가 열린다', async (input) => {
		prefer.commit('openNoteMenuOnLongPress', false);
		const { article } = mount(component);
		article.dispatchEvent(contextmenu(input));
		await nextTick();
		expect(mocks.contextMenu).toHaveBeenCalledTimes(1);
	});

	test('끄더라도 마우스 우클릭 리액션 선택기는 그대로다', async () => {
		prefer.commit('openNoteMenuOnLongPress', false);
		prefer.commit('useReactionPickerForContextMenu', true);
		const { article } = mount(component);
		const ev = contextmenu('mouse');
		article.dispatchEvent(ev);
		await nextTick();
		expect(ev.defaultPrevented).toBe(true);
		expect(mocks.pickerShow).toHaveBeenCalledTimes(1);
		expect(mocks.contextMenu).not.toHaveBeenCalled();
	});

	test('끄더라도 ⋯ 버튼으로는 메뉴가 열린다', async () => {
		prefer.commit('openNoteMenuOnLongPress', false);
		const { container } = mount(component);
		const button = container.querySelector('.ti-dots')!.closest('button')!;
		button.click();
		await nextTick();
		expect(mocks.popupMenu).toHaveBeenCalledTimes(1);
	});

	test('끄더라도 텍스트 선택 중이면 기존대로 브라우저에 맡긴다', async () => {
		prefer.commit('openNoteMenuOnLongPress', false);
		const { article } = mount(component);
		vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'sel' } as Selection);
		article.dispatchEvent(contextmenu('touch'));
		await nextTick();
		expect(mocks.contextMenu).not.toHaveBeenCalled();
	});
});
