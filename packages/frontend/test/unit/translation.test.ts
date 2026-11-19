/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref } from 'vue';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import MkPoll from '@/components/MkPoll.vue';
import { apiWithDialog } from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { isForeignNoteLanguage } from '@/utility/detect-language.js';
import { translateWithState } from '@/utility/translate-with-state.js';

vi.mock('@/os.js', () => ({ apiWithDialog: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
const session = vi.hoisted(() => ({
	account: { policies: { canUseTranslator: true } } as { policies: { canUseTranslator: boolean } } | null,
	instance: { translatorAvailable: true },
}));
vi.mock('@/i.js', () => ({ get $i() { return session.account; } }));
vi.mock('@/instance.js', () => ({ instance: session.instance }));

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	session.account = { policies: { canUseTranslator: true } };
	session.instance.translatorAvailable = true;
});

describe('translation language detection', () => {
	const korean = '오늘은 날씨가 아주 좋아서 친구와 산책을 했어요. 다음 주에도 함께 공원에 가기로 했습니다.';
	const english = 'The weather is nice today, so I went for a walk with a friend in the park.';

	test('uses the body language for a note without a poll', () => {
		expect(isForeignNoteLanguage({ text: korean }, 'ko')).toBe(false);
		expect(isForeignNoteLanguage({ text: korean }, 'en')).toBe(true);
		expect(isForeignNoteLanguage({ text: '1234' }, 'ko')).toBe(false);
	});

	test('detects a foreign language in the choices of a real poll', () => {
		expect(isForeignNoteLanguage({
			text: korean,
			poll: { multiple: false, expiresAt: null, choices: [{ text: english, votes: 0, isVoted: false }] },
		}, 'ko')).toBe(true);
	});
});

describe('translation state', () => {
	test.each(['RATE_LIMIT_EXCEEDED', 'INTERNAL_ERROR'])('clears loading after %s and accepts a retry', async code => {
		const translation = ref<string | null>(null);
		const translating = ref(false);
		const request = vi.fn().mockRejectedValueOnce({ code }).mockResolvedValueOnce('Translated text');

		const pending = translateWithState(translation, translating, request);
		expect(translating.value).toBe(true);
		expect(await translateWithState(translation, translating, request)).toBe(false);
		expect(request).toHaveBeenCalledTimes(1);
		expect(await pending).toBe(false);
		expect(translating.value).toBe(false);
		expect(translation.value).toBeNull();

		expect(await translateWithState(translation, translating, request)).toBe(true);
		expect(translating.value).toBe(false);
		expect(translation.value).toBe('Translated text');
	});
});

function renderTranslatedPoll() {
	return render(MkPoll, {
		props: {
			noteId: 'note', multiple: false, expiresAt: null, readOnly: true, isTranslation: true,
			choices: [{ text: 'Original choice', votes: 0, isVoted: false }],
		},
		global: { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } } },
	});
}

test.each([
	{ label: 'a signed-out visitor', signedIn: false, allowed: false, available: true },
	{ label: 'an account without the translator policy', signedIn: true, allowed: false, available: true },
	{ label: 'an account on an instance with no translator', signedIn: true, allowed: true, available: false },
])('a translated note keeps original poll choices for $label', async ({ signedIn, allowed, available }) => {
	session.account = signedIn ? { policies: { canUseTranslator: allowed } } : null;
	session.instance.translatorAvailable = available;
	vi.mocked(misskeyApi).mockRejectedValue({ code: 'UNAVAILABLE' });

	const poll = renderTranslatedPoll();
	expect(await poll.findByText('Original choice')).toBeDefined();
	expect(misskeyApi).not.toHaveBeenCalled();
	expect(poll.queryByRole('button')).toBeNull();
	expect(apiWithDialog).not.toHaveBeenCalled();
});

test.each(['RATE_LIMIT_EXCEEDED', 'INTERNAL_ERROR'])('a poll keeps its original choices after %s and can retry manually', async code => {
	vi.mocked(misskeyApi).mockRejectedValueOnce({ code });
	vi.mocked(apiWithDialog).mockResolvedValueOnce({ sourceLang: 'ko', text: ['Translated choice'] });
	const poll = renderTranslatedPoll();

	const retry = await poll.findByRole('button');
	expect(poll.getByText('Original choice')).toBeDefined();
	expect(apiWithDialog).not.toHaveBeenCalled();
	await fireEvent.click(retry);

	expect(await poll.findByText('Translated choice')).toBeDefined();
	expect(apiWithDialog).toHaveBeenCalledExactlyOnceWith('notes/polls/translate', { noteId: 'note', targetLang: navigator.language });
	expect(poll.queryByRole('button')).toBeNull();
});
