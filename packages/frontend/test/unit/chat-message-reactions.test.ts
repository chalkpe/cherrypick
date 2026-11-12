/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import type { FakePrefer } from './fake-prefer.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
	me: { id: 'me', username: 'me', policies: { chatAvailability: 'available' } },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api, misskeyApiGet: mocks.api }));
vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })), popupMenu: vi.fn(), contextMenu: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/custom-emojis.js', async () => {
	const blob = { name: 'blob', url: 'https://local.test/blob.png', aliases: [], category: null };
	return { customEmojis: (await import('vue')).ref([blob]), customEmojisMap: new Map([[blob.name, blob]]) };
});
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show: vi.fn() } }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));

import XMessage from '@/pages/chat/XMessage.vue';
import MkCustomEmoji from '@/components/global/MkCustomEmoji.vue';
import MkEmoji from '@/components/global/MkEmoji.vue';
import { prefer as realPrefer } from '@/preferences.js';

const prefer = realPrefer as unknown as FakePrefer;

const bob = { id: 'bob', username: 'bob' };
const carol = { id: 'carol', username: 'carol', host: 'other.test' };
const base = { id: 'm1', text: 'Hello', createdAt: '2026-11-01T00:00:00.000Z', reactions: [], fileIds: [], files: [] };
const fromBob = { ...base, fromUserId: bob.id, fromUser: bob };
const fromMe = { ...base, fromUserId: mocks.me.id, fromUser: mocks.me };

const stubs = {
	MkUserName: true,
	MkAvatar: { props: ['user'], template: '<span data-testid="avatar" :title="user.username"></span>' },
	MkA: true,
	MkTime: true,
	MkFukidashi: { template: '<div><slot/></div>' },
	MkMediaList: true,
	MkUrlPreview: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

type Reaction = { user: { id: string; username: string; host?: string }; reaction: string };

function renderMessage(message: Record<string, unknown>, reactions: Reaction[], options: { realIcon?: boolean } = {}) {
	const result = render(XMessage, {
		props: { message: { ...message, reactions } as unknown as Misskey.entities.ChatMessage },
		global: {
			stubs: options.realIcon ? stubs : { ...stubs, MkReactionIcon: { props: ['reaction', 'noStyle'], template: '<img data-testid="icon" :alt="reaction" :data-no-style="String(noStyle === true)">' } },
			components: { MkCustomEmoji, MkEmoji },
		},
	});
	const chips = () => [...result.container.querySelectorAll('[class*="reactions"] > *')] as HTMLElement[];
	return { ...result, chips };
}

/** CSS Modules のクラス名のうち、リアクションの見た目を決めるものだけを取り出す */
function looks(chip: HTMLElement): string[] {
	return [...chip.classList].map(name => /reaction[A-Za-z]*/.exec(name)?.[0]).filter(name => name != null).sort();
}

function avatarOf(chip: HTMLElement): HTMLElement {
	return chip.querySelector<HTMLElement>('[data-testid="avatar"]')!;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.api.mockResolvedValue({});
	prefer.reset({ reactionsDisplaySize: 'small', limitWidthOfReaction: true, mutingEmojis: [], emojiStyle: 'twemoji' });
});
afterEach(cleanup);

describe('how a chat reaction looks', () => {
	test('the emoji is sized by the shared reaction rules, not fixed by the chat', () => {
		const { getByTestId } = renderMessage(fromBob, [{ user: bob, reaction: ':blob:' }]);

		expect(getByTestId('icon').dataset.noStyle).toBe('false');
	});

	test.each([
		['small', 'reactionSmall'],
		['medium', null],
		['large', 'reactionLarge'],
	])('follows the reaction display size setting (%s)', (size, expected) => {
		prefer.reset({ reactionsDisplaySize: size, limitWidthOfReaction: true, mutingEmojis: [] });
		const { chips } = renderMessage(fromBob, [{ user: bob, reaction: '👍' }]);

		expect(looks(chips()[0]).filter(name => name === 'reactionSmall' || name === 'reactionLarge')).toEqual(expected ? [expected] : []);
	});

	test('a changed size setting shows without rendering the message again', async () => {
		const { chips } = renderMessage(fromBob, [{ user: bob, reaction: '👍' }]);
		expect(looks(chips()[0])).toContain('reactionSmall');

		prefer.commit('reactionsDisplaySize', 'large');
		await nextTick();

		expect(looks(chips()[0])).toContain('reactionLarge');
		expect(looks(chips()[0])).not.toContain('reactionSmall');
	});

	test('limits the width of a wide emoji only while that setting is on', async () => {
		const { getByTestId } = renderMessage(fromBob, [{ user: bob, reaction: ':blob:' }]);
		expect(getByTestId('icon').className).toContain('reactionLimitWidth');

		prefer.commit('limitWidthOfReaction', false);
		await nextTick();

		expect(getByTestId('icon').className).not.toContain('reactionLimitWidth');
	});

	test('marks my own reaction, and only mine', () => {
		const { chips } = renderMessage(fromBob, [{ user: mocks.me, reaction: '👍' }, { user: bob, reaction: '👍' }]);

		expect(looks(chips()[0])).toContain('reactionReacted');
		expect(looks(chips()[1])).not.toContain('reactionReacted');
	});

	test('looks the same under my message and under someone else\'s', () => {
		const reaction = [{ user: bob, reaction: '👍' }];
		const mine = renderMessage(fromMe, reaction);
		const theirs = renderMessage(fromBob, reaction);

		// 押せるかどうか (ホバーの見た目) だけは、自分のメッセージにリアクションできないので変わる
		const atRest = (chip: HTMLElement) => looks(chip).filter(name => name !== 'reactionClickable');
		expect(atRest(mine.chips()[0])).toEqual(atRest(theirs.chips()[0]));
		expect(atRest(mine.chips()[0])).toContain('reactionCanToggle');
	});

	test.each([
		['a Unicode emoji', '👍', true],
		['a custom emoji of this server', ':blob:', true],
		['a custom emoji this server does not have', ':gone:', false],
		['a custom emoji of another server', ':blob@other.test:', false],
	])('gives %s the background of an emoji that can be used here: %s', (_what, reaction, usable) => {
		const { chips } = renderMessage(fromBob, [{ user: carol, reaction }]);

		expect(looks(chips()[0]).includes('reactionCanToggle')).toBe(usable);
	});

	test.each([
		['my reaction on a message I can react to', fromBob, mocks.me, '👍', true],
		['someone\'s reaction I can add too', fromBob, bob, '👍', true],
		['a custom emoji of another server', fromBob, carol, ':blob@other.test:', false],
		['a reaction on my own message', fromMe, bob, '👍', false],
	])('invites a press only where it does something: %s', (_what, message, user, reaction, clickable) => {
		const { chips } = renderMessage(message, [{ user, reaction }]);

		expect(looks(chips()[0]).includes('reactionClickable')).toBe(clickable);
	});

	test('still shows who reacted', () => {
		const { chips } = renderMessage(fromBob, [{ user: bob, reaction: '👍' }, { user: carol, reaction: '🎉' }]);

		expect(chips().map(chip => avatarOf(chip).title)).toEqual(['bob', 'carol']);
	});
});

describe('pressing a chat reaction', () => {
	test.each([
		['a Unicode emoji', '👍'],
		['a custom emoji', ':blob:'],
	])('pressing the picture of %s takes my reaction back, like the rest of the chip', async (_what, reaction) => {
		const { chips } = renderMessage(fromBob, [{ user: mocks.me, reaction }], { realIcon: true });

		await fireEvent.click(chips()[0].querySelector('img')!);

		expect(mocks.api).toHaveBeenCalledWith('chat/messages/unreact', { messageId: 'm1', reaction });
	});

	test('pressing the picture of someone else\'s emoji adds the same reaction', async () => {
		const { chips } = renderMessage(fromBob, [{ user: bob, reaction: '👍' }], { realIcon: true });

		await fireEvent.click(chips()[0].querySelector('img')!);

		expect(mocks.api).toHaveBeenCalledWith('chat/messages/react', { messageId: 'm1', reaction: '👍' });
	});

	test('pressing the avatar still works and asks once', async () => {
		const { chips } = renderMessage(fromBob, [{ user: mocks.me, reaction: '👍' }]);

		await fireEvent.click(avatarOf(chips()[0]));
		expect(mocks.api).toHaveBeenCalledTimes(1);

		await fireEvent.click(chips()[0]);
		expect(mocks.api).toHaveBeenCalledTimes(2);
	});
});
