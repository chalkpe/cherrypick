/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
	apiWithDialog: vi.fn(),
	misskeyApi: vi.fn(),
	popupMenu: vi.fn(),
	me: { id: 'me', isAdmin: true, policies: { canManageCustomEmojis: true } } as any,
}));

vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, popupMenu: mocks.popupMenu, popup: vi.fn(), confirm: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi, misskeyApiGet: vi.fn() }));
vi.mock('@/i.js', () => ({ get $i() { return mocks.me; } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({}, { get: (_t, k) => String(k) }), tsx: new Proxy({}, { get: () => () => '' }) } }));
vi.mock('@/custom-emojis.js', () => ({ customEmojis: ref([]), customEmojisMap: new Map() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { reactionsDisplaySize: 'medium', limitWidthOfReaction: false, reactableRemoteReactionEnabled: false, confirmOnReact: false }, r: {} } }));
vi.mock('@/utility/emoji-mute.js', () => ({ mute: vi.fn(), unmute: vi.fn(), checkMuted: () => ref(false) }));
vi.mock('@/utility/emoji-palette.js', () => ({ addToEmojiPalette: vi.fn() }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
vi.mock('@/utility/haptic.js', () => ({ haptic: vi.fn() }));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('@/composables/use-note-capture.js', () => ({ noteEvents: { emit: vi.fn() } }));
vi.mock('@/composables/use-tooltip.js', () => ({ useTooltip: vi.fn() }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: { template: '<span/>' } }));
vi.mock('@/components/MkReactionEffect.vue', () => ({ default: { template: '<span/>' } }));
vi.mock('@/components/MkReactionsViewer.details.vue', () => ({ default: { template: '<span/>' } }));
vi.mock('@/components/MkCustomEmojiDetailedDialog.vue', () => ({ default: {} }));

import MkReaction from '@/components/MkReactionsViewer.reaction.vue';
import { directives } from '@/directives/index.js';

const note = {
	id: 'note',
	user: { id: 'author', username: 'author', host: 'author.example' },
} as any;

async function openMenu(reaction: string, noteArg = note) {
	mocks.popupMenu.mockReset();
	const { container } = render(MkReaction, {
		props: { noteId: 'note', reaction, reactionEmojis: {}, myReaction: null, count: 1, isInitial: false, note: noteArg },
		global: { directives },
	});
	await fireEvent.contextMenu(container.querySelector('button')!);
	await vi.waitFor(() => expect(mocks.popupMenu).toHaveBeenCalled());
	return mocks.popupMenu.mock.calls[0][0] as any[];
}

describe('リアクションメニューの絵文字インポート', () => {
	beforeEach(() => {
		mocks.apiWithDialog.mockReset().mockResolvedValue(undefined);
		mocks.misskeyApi.mockReset().mockResolvedValue(undefined);
		mocks.me = { id: 'me', isAdmin: true, policies: { canManageCustomEmojis: true } };
	});

	afterEach(() => {
		cleanup();
	});

	test('ノート作成者のサーバーと絵文字のサーバーが違う場合は絵文字のサーバーを指定する', async () => {
		const items = await openMenu(':party@emoji.example:');
		const importItems = items.filter(it => it.text === 'import' || it.text === 'doReaction (import)');
		expect(importItems).toHaveLength(2);

		for (const item of importItems) await item.action();

		expect(mocks.apiWithDialog).toHaveBeenCalledTimes(2);
		for (const call of mocks.apiWithDialog.mock.calls) {
			expect(call).toEqual(['admin/emoji/steal', { name: 'party', host: 'emoji.example' }]);
		}
	});

	test('ローカルのノートに付いた他サーバーの絵文字にもインポートが表示される', async () => {
		const items = await openMenu(':party@emoji.example:', { id: 'note', user: { id: 'author', username: 'author', host: null } });
		expect(items.some(it => it.text === 'import')).toBe(true);
	});

	test('リモートのノートに付いたローカル絵文字にはインポートが表示されない', async () => {
		const items = await openMenu(':party@.:');
		expect(items.some(it => it.text === 'import')).toBe(false);
	});

	test('Unicode絵文字にはインポートが表示されない', async () => {
		const items = await openMenu('👍');
		expect(items.some(it => it.text === 'import')).toBe(false);
	});

	test('権限がない場合はインポートが表示されない', async () => {
		mocks.me = { id: 'me', isAdmin: false, policies: { canManageCustomEmojis: false } };
		const items = await openMenu(':party@emoji.example:');
		expect(items.some(it => it.text === 'import')).toBe(false);
	});
});
