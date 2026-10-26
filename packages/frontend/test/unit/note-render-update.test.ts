/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, cleanup } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import MkNote from '@/components/MkNote.vue';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';
import { prefer } from '@/preferences.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
	listeners: new Map<string, (event: unknown) => void>(),
	interruptors: [] as { handler: (note: Misskey.entities.Note) => Misskey.entities.Note | null }[],
}));

vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: {} }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-note-menu.js', () => ({}));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => mocks.interruptors }));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/router.js', () => ({ useRouter: () => ({}), mainRouter: { currentRoute: { value: { name: 'index' } } } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api, misskeyApiGet: mocks.api }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', mutedWords: [], hardMutedWords: [], policies: {} } }));
vi.mock('@/store.js', () => ({ store: { s: { realtimeMode: true } } }));
vi.mock('@@/js/interval.js', () => ({ createVisibilityAwareInterval: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: () => ({
	send: vi.fn(),
	on: (name: string, listener: (event: unknown) => void) => mocks.listeners.set(name, listener),
	off: (name: string) => mocks.listeners.delete(name),
}) }));
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

async function flushUpdates() {
	await Promise.resolve();
	await nextTick();
}

beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('showReactionsCount', true);
	prefer.commit('showDoReactionButtonInNoteFooter', true);
	mocks.api.mockReset().mockResolvedValue([]);
	mocks.listeners.clear();
	mocks.interruptors.length = 0;
});
afterEach(cleanup);

function makeNote(): Misskey.entities.Note {
	return {
		id: 'note', createdAt: new Date().toISOString(), text: 'Original text', cw: null,
		userId: 'author', user: { id: 'author', username: 'author', host: null, avatarDecorations: [] },
		visibility: 'public', localOnly: false, renoteId: null, renote: null, replyId: null,
		files: [], fileIds: [], reactions: {}, reactionEmojis: {}, reactionCount: 0,
		myReaction: null, repliesCount: 0, renoteCount: 0,
	} as unknown as Misskey.entities.Note;
}

for (const component of [MkNote, MkNoteDetailed]) {
	for (const plugin of [false, true]) {
		test(`${component.__name} renders streamed edits after ${plugin ? 'plugin replacement' : 'cloning'}`, async () => {
			if (plugin) mocks.interruptors.push({ handler: note => ({ ...note, text: 'Plugin text' }) });
			const sourceNote = makeNote();
			const wrapper = render(component, {
				props: { note: sourceNote },
				global: {
					directives: { tooltip: {}, 'user-preview': {}, hotkey: {}, 'adaptive-bg': {} },
					stubs: {
						MkNoteHeader: false,
						MkA: { template: '<a><slot /></a>' },
						Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
						MkUserName: true, MkAvatar: true, MkAcct: true, MkTime: true,
						I18n: true, MkLoading: true, MkResult: true,
						MkNoteSub: true, MkNoteSimple: true, MkReactionsViewer: true,
						MkMediaList: true, MkCwButton: true, MkPoll: true, MkUrlPreview: true,
						MkEvent: true, MkInfo: true, MkInstanceTicker: true, MkUserCardMini: true,
						MkPagination: true, MkReactionIcon: true, MkButton: true,
						MkPostForm: true, MkNoteHistory: true, MkSwitch: true,
					},
				},
			});
			await flushUpdates();
			expect(wrapper.container.textContent).toContain(plugin ? 'Plugin text' : 'Original text');
			expect(Boolean(wrapper.container.querySelector('.ti-home'))).toBe(false);

			mocks.api.mockResolvedValue({ ...sourceNote, text: 'Edited text', visibility: 'home' });
			mocks.listeners.get('noteUpdated')!({ id: 'note', type: 'updated', body: { updatedAt: new Date().toISOString() } });
			await flushUpdates();

			expect(wrapper.container.textContent).toContain('Edited text');
			expect(Boolean(wrapper.container.querySelector('.ti-home'))).toBe(true);
			expect(sourceNote.text).toBe('Original text');
			expect(sourceNote.visibility).toBe('public');

			mocks.listeners.get('noteUpdated')!({ id: 'note', type: 'reacted', body: { userId: 'someone', reaction: '❤️' } });
			await flushUpdates();
			expect(wrapper.container.querySelector('.ti-mood-plus')?.parentElement?.textContent).toContain('1');
		});
	}
}
