/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import PollTranslateEndpoint from '@/server/api/endpoints/notes/polls/translate.js';

function fixture(opts: { visible?: boolean; hidden?: boolean; noteMissing?: boolean } = {}) {
	const { visible = true, hidden = false, noteMissing = false } = opts;
	const note = { id: 'note', userId: 'author' };
	const pollsRepository = {
		findOneBy: vi.fn().mockResolvedValue({ noteId: 'note', choices: ['a', 'b'] }),
		findOneByOrFail: vi.fn().mockResolvedValue({ noteId: 'note', choices: ['a', 'b'] }),
	};
	const send = vi.fn().mockResolvedValue({ json: async () => ({ translations: [{ text: 'x', detected_source_language: 'EN' }] }) });
	const getterService = {
		getNote: vi.fn().mockImplementation(async () => {
			if (noteMissing) throw Object.assign(new Error('no note'), { id: '9725d0ce-ba28-4dde-95a7-2cbb2c15de24' });
			return note;
		}),
	};
	const noteEntityService = {
		isVisibleForMe: vi.fn().mockResolvedValue(visible),
		pack: vi.fn().mockResolvedValue({ isHidden: hidden }),
	};
	const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ canUseTranslator: true }) };
	const endpoint = new PollTranslateEndpoint(
		{ translatorType: 'deepl', deeplAuthKey: 'key', deeplIsPro: false } as any,
		pollsRepository as any,
		{ send } as any,
		roleService as any,
		getterService as any,
		noteEntityService as any,
	);
	return { endpoint, send, pollsRepository };
}

describe('notes/polls/translate', () => {
	test('translates the poll of a visible note', async () => {
		const { endpoint, send } = fixture();
		const res = await endpoint.exec({ noteId: 'note', targetLang: 'ko' }, { id: 'me' } as any, null, null) as any;
		expect(res.text).toEqual(['x', 'x']);
		expect(send).toHaveBeenCalled();
	});

	test('rejects a note the requester cannot see before reading the poll', async () => {
		const { endpoint, send, pollsRepository } = fixture({ visible: false });
		await expect(endpoint.exec({ noteId: 'note', targetLang: 'ko' }, { id: 'me' } as any, null, null)).rejects.toMatchObject({ code: 'CANNOT_TRANSLATE_INVISIBLE_NOTE' });
		expect(pollsRepository.findOneBy).not.toHaveBeenCalled();
		expect(pollsRepository.findOneByOrFail).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	test('rejects a note whose content is hidden for the requester', async () => {
		const { endpoint, send, pollsRepository } = fixture({ hidden: true });
		await expect(endpoint.exec({ noteId: 'note', targetLang: 'ko' }, { id: 'me' } as any, null, null)).rejects.toMatchObject({ code: 'CANNOT_TRANSLATE_INVISIBLE_NOTE' });
		expect(pollsRepository.findOneBy).not.toHaveBeenCalled();
		expect(pollsRepository.findOneByOrFail).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	test('reports a missing note as no such note', async () => {
		const { endpoint } = fixture({ noteMissing: true });
		await expect(endpoint.exec({ noteId: 'note', targetLang: 'ko' }, { id: 'me' } as any, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_NOTE' });
	});
});
