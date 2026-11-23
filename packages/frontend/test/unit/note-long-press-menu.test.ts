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

const mocks = vi.hoisted(() => ({
	contextMenu: vi.fn(() => Promise.resolve()),
	popupMenu: vi.fn(() => Promise.resolve()),
	getNoteMenu: vi.fn(() => ({ menu: [], cleanup: () => {} })),
	pickerShow: vi.fn(),
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
	return { prefer: new PreferencesManager({
		load: () => null,
		save: () => {},
		cloudGet: async () => null,
		cloudGetBulk: async () => ({}),
		cloudSet: async () => {},
	}, { id: 'viewer' }) };
});

const note = {
	id: 'note', createdAt: new Date().toISOString(), text: 'text', cw: null,
	userId: 'author', user: { id: 'author', username: 'author', host: null, avatarDecorations: [] },
	visibility: 'public', localOnly: false, renoteId: null, renote: null, replyId: null,
	files: [], fileIds: [], reactions: {}, reactionEmojis: {}, reactionCount: 0,
	myReaction: null, repliesCount: 0, renoteCount: 0,
} as unknown as Misskey.entities.Note;

type Input = 'mouse' | 'pen' | 'touch' | 'touch-mouseevent' | 'keyboard' | 'mouseevent-plain';

/** jsdom には PointerEvent が無いので、ブラウザが送る contextmenu の形を手で作る */
function contextmenu(input: Input): Event {
	const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
	if (input === 'mouse' || input === 'pen' || input === 'touch') {
		Object.defineProperty(ev, 'pointerType', { value: input });
	} else if (input === 'keyboard') {
		// Shift+F10 / メニューキーは pointerType が空
		Object.defineProperty(ev, 'pointerType', { value: '' });
	} else if (input === 'touch-mouseevent') {
		// 旧 Chrome: pointerType を持たない MouseEvent で、入力元だけが touch を示す
		Object.defineProperty(ev, 'sourceCapabilities', { value: { firesTouchEvents: true } });
	} else {
		Object.defineProperty(ev, 'sourceCapabilities', { value: { firesTouchEvents: false } });
	}
	return ev;
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

let initialValue: unknown;

beforeEach(async () => {
	await prefer.cloudReady;
	initialValue ??= prefer.s.openNoteMenuOnLongPress; // 저장값이 없는 최초 상태
	prefer.commit('openNoteMenuOnLongPress', true);
	prefer.commit('useReactionPickerForContextMenu', false);
	mocks.contextMenu.mockClear();
	mocks.popupMenu.mockClear();
	mocks.getNoteMenu.mockClear();
	mocks.pickerShow.mockClear();
});
afterEach(cleanup);

describe.each([['MkNote', MkNote], ['MkNoteDetailed', MkNoteDetailed]] as const)('%s 길게 누르기 메뉴', (_name, component) => {
	test('저장값이 없으면 켜짐이라 손가락 입력에서도 기존처럼 메뉴가 열린다', async () => {
		expect(initialValue).toBe(true);
		const { article } = mount(component);
		article.dispatchEvent(contextmenu('touch'));
		await nextTick();
		expect(mocks.contextMenu).toHaveBeenCalledTimes(1);
	});

	test.each(['touch', 'touch-mouseevent'] as const)('끄면 %s 입력에서는 메뉴가 열리지 않는다', async (input) => {
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
		vi.restoreAllMocks();
	});
});
