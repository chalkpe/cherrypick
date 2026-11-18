/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { getNoteMenu } from '@/utility/get-note-menu.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	confirm: vi.fn(),
	post: vi.fn(),
}));

vi.mock('@/os.js', () => ({ popup: vi.fn(), confirm: mocks.confirm, post: mocks.post, apiWithDialog: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'author', isModerator: false, isAdmin: false, policies: { canEditNote: true } } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({ _visibility: {} }, { get: (t: any, k) => t[k] ?? String(k) }) } }));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/store.js', () => ({ store: { s: {} } }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: () => null } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {}, r: {} } }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/cache.js', () => ({ clipsCache: {}, favoritedChannelsCache: {} }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: {} }));

const note = {
	id: 'note', userId: 'author', visibility: 'public', channel: null, files: [], reactions: {}, createdAt: '2020-01-01T00:00:00.000Z',
	renote: null, reply: null,
	user: { id: 'author', username: 'author', host: null },
} as unknown as Misskey.entities.Note;

function menuAction(text: string): () => void {
	const { menu } = getNoteMenu({ note, translation: ref(null), translating: ref(false) });
	const item = menu.find((entry: any) => entry.text === text) as any;
	return item.action;
}

beforeEach(() => {
	mocks.api.mockReset().mockImplementation(async (path: string) => (path === 'notes/delete' ? undefined : { isFavorited: false, isMutedThread: false, isWatching: false }));
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	mocks.post.mockReset();
});

describe('노트 삭제 요청', () => {
	test('삭제 후 편집은 같은 첨부 파일을 이어서 쓰므로 파일을 남기라고 요청한다', async () => {
		menuAction('deleteAndEdit')();

		await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
		expect(mocks.api).toHaveBeenCalledWith('notes/delete', { noteId: 'note', keepFiles: true });
		expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ initialNote: note }));
	});

	test('일반 삭제는 파일 삭제 여부를 계정 설정에 맡긴다', async () => {
		menuAction('delete')();

		await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
		expect(mocks.api).toHaveBeenCalledWith('notes/delete', { noteId: 'note' });
	});
});
