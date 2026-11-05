/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';
import MkCustomEmoji from '@/components/global/MkCustomEmoji.vue';
import MkEmoji from '@/components/global/MkEmoji.vue';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';
import { prefer } from '@/preferences.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: {} }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-note-menu.js', () => ({}));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/custom-emojis.js', () => ({ customEmojis: { value: [] }, customEmojisMap: new Map() }));
vi.mock('@/router.js', () => ({ useRouter: () => ({}), mainRouter: { currentRoute: { value: { name: 'index' } } } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api, misskeyApiGet: mocks.api }));
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

const customReaction = ':cat@remote.example:';
const unicodeReaction = '👍';

function renderReactionsTab() {
	const note = {
		id: 'note', createdAt: new Date().toISOString(), text: 'text', cw: null,
		userId: 'author', user: { id: 'author', username: 'author', host: null, avatarDecorations: [] },
		visibility: 'public', localOnly: false, renoteId: null, renote: null, replyId: null,
		files: [], fileIds: [],
		reactions: { [customReaction]: 1, [unicodeReaction]: 1 },
		reactionEmojis: {}, reactionCount: 2,
		myReaction: null, repliesCount: 0, renoteCount: 0,
	} as unknown as Misskey.entities.Note;

	return render(MkNoteDetailed, {
		props: { note, initialTab: 'reactions' },
		global: {
			components: { MkCustomEmoji, MkEmoji },
			directives: { tooltip: {}, 'user-preview': {}, hotkey: {}, 'adaptive-bg': {} },
			stubs: {
				MkNoteHeader: true,
				MkA: { template: '<a><slot /></a>' },
				Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
				MkUserName: true, MkAvatar: true, MkAcct: true, MkTime: true,
				I18n: true, MkLoading: true, MkResult: true,
				MkNoteSub: true, MkNoteSimple: true, MkReactionsViewer: true,
				MkMediaList: true, MkCwButton: true, MkPoll: true, MkUrlPreview: true,
				MkEvent: true, MkInfo: true, MkInstanceTicker: true,
				MkUserCardMini: { props: ['user'], template: '<div data-testid="reaction-user">{{ user.username }}</div>' },
				MkPullToRefresh: { template: '<div><slot /></div>' },
				MkButton: true, MkPostForm: true, MkNoteHistory: true, MkSwitch: true,
			},
		},
	});
}

beforeEach(async () => {
	await prefer.cloudReady;
	mocks.api.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

// MkCustomEmoji / MkEmoji はクリックを @click.stop で止めるため、絵文字がタップを受けるとチップまで届かない
test.each([
	['custom emoji', customReaction, 'img[alt=":cat@remote.example:"]'],
	['unicode emoji', unicodeReaction, `img[alt="${unicodeReaction}"]`],
])('%s reaction chip lets taps on the emoji through to the chip', async (_, reaction, emojiSelector) => {
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint !== 'notes/reactions') return [];
		return [{ id: 'reaction', createdAt: new Date().toISOString(), type: reaction, user: { id: 'reactor', username: 'reactor', host: null } }];
	});

	const { container, findByTestId } = renderReactionsTab();

	const emoji = container.querySelector<HTMLElement>(emojiSelector)!;
	expect(emoji).not.toBeNull();
	expect(emoji.style.pointerEvents).toBe('none');

	await fireEvent.click(emoji.closest('button')!);

	await waitFor(() => {
		expect(mocks.api).toHaveBeenCalledWith('notes/reactions', expect.objectContaining({ noteId: 'note', type: reaction }));
	});
	expect((await findByTestId('reaction-user')).textContent).toBe('reactor');
});
