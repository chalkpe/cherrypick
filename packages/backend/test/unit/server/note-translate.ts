/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import Translate from '@/server/api/endpoints/notes/translate.js';

describe('Note translation', () => {
	test.each(['libretranslate', 'Libretranslate'])('accepts %s and translates CW-only notes without null text', async translatorType => {
		const send = vi.fn().mockResolvedValue({ json: async () => ({ translatedText: 'translated', detectedLanguage: { language: 'en' } }) });
		const endpoint = new Translate(
			{ translatorType, libreTranslateEndPoint: 'https://translate.example', libreTranslateApiKey: null } as never,
			{ isVisibleForMe: async () => true, pack: async () => ({ isHidden: false }) } as never,
			{ getNote: async () => ({ text: null, cw: 'warning' }) } as never,
			{ send } as never,
			{ getUserPolicies: async () => ({ canUseTranslator: true }) } as never,
		);
		const result = await endpoint.exec({ noteId: 'note', targetLang: 'ko-KR' }, { id: 'user' } as never, null, null);
		expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({ q: 'warning\n-----\n', target: 'ko' });
		expect(result).toMatchObject({ text: 'translated' });
	});
});
