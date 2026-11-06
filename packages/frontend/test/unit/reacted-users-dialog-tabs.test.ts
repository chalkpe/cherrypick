/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import MkCustomEmoji from '@/components/global/MkCustomEmoji.vue';
import MkEmoji from '@/components/global/MkEmoji.vue';
import MkReactedUsersDialog from '@/components/MkReactedUsersDialog.vue';
import { prefer } from '@/preferences.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/os.js', () => ({}));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/custom-emojis.js', () => ({ customEmojis: { value: [] }, customEmojisMap: new Map() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', policies: {} }, iAmModerator: false }));
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

beforeEach(async () => {
	await prefer.cloudReady;
	mocks.api.mockReset();
});
afterEach(cleanup);

// MkCustomEmoji / MkEmoji はクリックを @click.stop で止めるため、絵文字がタップを受けるとチップまで届かない
test.each([
	['custom emoji', customReaction, unicodeReaction, 'img[alt=":cat@remote.example:"]'],
	['unicode emoji', unicodeReaction, customReaction, `img[alt="${unicodeReaction}"]`],
])('%s reaction chip lets taps on the emoji through to the chip', async (_, reaction, initialReaction, emojiSelector) => {
	// 最初のチップは開いた時点で選択済みなので、確認するチップを 2 番目に置く
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'notes/show' ? { id: 'note', reactions: { [initialReaction]: 1, [reaction]: 1 } } : []);

	const { container } = render(MkReactedUsersDialog, {
		props: { noteId: 'note' },
		global: {
			components: { MkCustomEmoji, MkEmoji },
			stubs: {
				MkModalWindow: { template: '<div><slot /></div>' },
				MkA: true, MkUserCardMini: true, MkResult: true, MkLoading: true,
			},
		},
	});

	await waitFor(() => {
		expect(container.querySelector(emojiSelector)).not.toBeNull();
	});
	const emoji = container.querySelector<HTMLElement>(emojiSelector)!;
	expect(emoji.style.pointerEvents).toBe('none');

	await fireEvent.click(emoji.closest('button')!);

	await waitFor(() => {
		expect(mocks.api).toHaveBeenCalledWith('notes/reactions', expect.objectContaining({ noteId: 'note', type: reaction }));
	});
});
