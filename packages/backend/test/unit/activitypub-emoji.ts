/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Test } from '@nestjs/testing';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import type { TestingModule } from '@nestjs/testing';
import { DI } from '@/di-symbols.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { UtilityService } from '@/core/UtilityService.js';
import type { IApEmoji } from '@/core/activitypub/type.js';
import type { EmojisRepository, MiEmoji } from '@/models/_.js';

describe('ActivityPub emoji sensitivity', () => {
	let app: TestingModule;
	let rendererService: ApRendererService;
	let noteService: ApNoteService;
	const emojisRepository = mockDeep<EmojisRepository>();
	const host = 'remote.example';
	const updated = '2026-01-01T00:00:00.000Z';
	const emoji: MiEmoji = {
		id: 'emoji-id',
		name: 'example',
		host,
		uri: `https://${host}/emojis/example`,
		originalUrl: `https://${host}/example.png`,
		publicUrl: `https://${host}/example.png`,
		updatedAt: new Date(updated),
		type: 'image/png',
		category: null,
		aliases: [],
		license: 'CC0',
		localOnly: false,
		isSensitive: false,
		roleIdsThatCanBeUsedThisEmojiAsReaction: [],
	};
	const tag: IApEmoji = {
		type: 'Emoji',
		id: emoji.uri!,
		name: ':example:',
		updated,
		icon: { type: 'Image', url: emoji.originalUrl },
		_misskey_license: { freeText: 'CC0' },
	};

	beforeAll(async () => {
		app = await Test.createTestingModule({
			providers: [ApRendererService, ApNoteService],
		}).useMocker((token) => {
			if (token === DI.config) return { url: 'https://local.example' };
			if (token === DI.emojisRepository) return emojisRepository;
			if (token === UtilityService) return { toPuny: (value: string) => value };
			return mockDeep();
		}).compile();
		rendererService = app.get(ApRendererService);
		noteService = app.get(ApNoteService);
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		mockReset(emojisRepository);
		emojisRepository.findBy.mockResolvedValue([]);
	});

	test.each([true, false])('renders sensitive=%s for outgoing emoji tags', (isSensitive) => {
		const rendered = rendererService.renderEmoji({ ...emoji, isSensitive });

		expect(rendered.sensitive).toBe(isSensitive);
		expect(rendered._misskey_license).toEqual({ freeText: 'CC0' });
		expect(rendered.icon.url).toBe(emoji.publicUrl);
	});

	test.each([
		{ sensitive: true, expected: true },
		{ sensitive: false, expected: false },
		{ sensitive: undefined, expected: false },
		{ sensitive: null, expected: false },
		{ sensitive: 'true', expected: false },
		{ sensitive: 'false', expected: false },
		{ sensitive: 1, expected: false },
	])('normalizes incoming sensitive=$sensitive to $expected on insert', async ({ sensitive, expected }) => {
		await noteService.extractEmojis({ ...tag, sensitive } as IApEmoji, host);

		expect(emojisRepository.insertOne).toHaveBeenCalledWith(expect.objectContaining({
			host,
			name: 'example',
			isSensitive: expected,
			license: 'CC0',
		}));
	});

	test.each([
		{ previous: false, sensitive: true, expected: true },
		{ previous: true, sensitive: false, expected: false },
		{ previous: true, sensitive: undefined, expected: false },
		{ previous: true, sensitive: 'false', expected: false },
	])('updates cached sensitive=$previous to $expected without a new timestamp or URL', async ({ previous, sensitive, expected }) => {
		emojisRepository.findBy.mockResolvedValue([{ ...emoji, isSensitive: previous }]);
		emojisRepository.findOneBy.mockResolvedValue({ ...emoji, isSensitive: expected });

		const [result] = await noteService.extractEmojis({ ...tag, sensitive } as IApEmoji, host);

		expect(emojisRepository.update).toHaveBeenCalledWith({ host, name: 'example' }, expect.objectContaining({
			isSensitive: expected,
			license: 'CC0',
		}));
		expect(result.isSensitive).toBe(expected);
	});

	test('keeps an unchanged cached emoji without writing it again', async () => {
		emojisRepository.findBy.mockResolvedValue([emoji]);

		const [result] = await noteService.extractEmojis(tag, host);

		expect(result).toEqual(emoji);
		expect(emojisRepository.update).not.toHaveBeenCalled();
		expect(emojisRepository.insertOne).not.toHaveBeenCalled();
	});

	test('normalizes an invalid flag while updating an existing image URL', async () => {
		emojisRepository.findBy.mockResolvedValue([emoji]);
		emojisRepository.findOneBy.mockResolvedValue(emoji);

		await noteService.extractEmojis({
			...tag,
			icon: { type: 'Image', url: `https://${host}/replacement.png` },
			sensitive: 'true',
		} as unknown as IApEmoji, host);

		expect(emojisRepository.update).toHaveBeenCalledWith({ host, name: 'example' }, expect.objectContaining({
			originalUrl: `https://${host}/replacement.png`,
			isSensitive: false,
		}));
	});
});
