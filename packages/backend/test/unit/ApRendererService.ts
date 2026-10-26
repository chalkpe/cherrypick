/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Test } from '@nestjs/testing';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import type { TestingModule } from '@nestjs/testing';
import { DI } from '@/di-symbols.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApMfmService } from '@/core/activitypub/ApMfmService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdService } from '@/core/IdService.js';
import type { DriveFilesRepository, MiNote, NotesRepository, UsersRepository } from '@/models/_.js';

function createNote(overrides: Partial<MiNote> & Pick<MiNote, 'id' | 'userId'>): MiNote {
	return {
		updatedAt: null,
		deleteAt: null,
		deliveryTargets: null,
		text: null,
		cw: null,
		visibility: 'public',
		localOnly: false,
		replyId: null,
		renoteId: null,
		fileIds: [],
		mentions: [],
		mentionedRemoteUsers: '[]',
		emojis: [],
		tags: [],
		hasPoll: false,
		hasEvent: false,
		...overrides,
	} as MiNote;
}

describe('ApRendererService reply parent visibility', () => {
	let app: TestingModule;
	let rendererService: ApRendererService;
	const notesRepository = mockDeep<NotesRepository>();
	const usersRepository = mockDeep<UsersRepository>();
	const driveFilesRepository = mockDeep<DriveFilesRepository>();
	const userEntityService = mockDeep<UserEntityService>();
	const apMfmService = mockDeep<ApMfmService>();
	const idService = mockDeep<IdService>();

	beforeAll(async () => {
		app = await Test.createTestingModule({
			providers: [ApRendererService],
		}).useMocker((token) => {
			if (token === DI.config) return { url: 'https://local.example' };
			if (token === DI.notesRepository) return notesRepository;
			if (token === DI.usersRepository) return usersRepository;
			if (token === DI.driveFilesRepository) return driveFilesRepository;
			if (token === UserEntityService) return userEntityService;
			if (token === ApMfmService) return apMfmService;
			if (token === IdService) return idService;
			return mockDeep();
		}).compile();
		rendererService = app.get(ApRendererService);
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		mockReset(notesRepository);
		mockReset(usersRepository);
		mockReset(driveFilesRepository);
		mockReset(userEntityService);
		mockReset(apMfmService);
		mockReset(idService);

		notesRepository.findOneBy.mockResolvedValue(null);
		usersRepository.exists.mockResolvedValue(true);
		usersRepository.findBy.mockResolvedValue([]);
		driveFilesRepository.findBy.mockResolvedValue([]);
		userEntityService.genLocalUserUri.mockImplementation((id: string) => `https://local.example/users/${id}`);
		apMfmService.getNoteHtml.mockImplementation((note) => ({
			content: `<p>${note.text ?? ''}</p>`,
			noMisskeyContent: false,
		}));
		idService.parse.mockReturnValue({ date: new Date('2026-01-01T00:00:00.000Z') } as never);
	});

	test('uses only the URL when a local reply parent has delivery targets', async () => {
		const parent = createNote({
			id: 'parent',
			userId: 'bob',
			text: 'restricted parent body',
			deliveryTargets: { mode: 'include', hosts: ['allowed.example'] },
		});
		const child = createNote({
			id: 'child',
			userId: 'alice',
			text: 'child body',
			replyId: parent.id,
		});
		notesRepository.findOneBy.mockImplementation(async (options) => (options as { id?: string }).id === parent.id ? parent : null);

		// `featured` renders pinned notes with the default dive=true.
		const rendered = await rendererService.renderNote(child);

		expect(rendered.inReplyTo).toBe('https://local.example/notes/parent');
		expect(JSON.stringify(rendered)).not.toContain('restricted parent body');
	});

	test('still embeds a local reply parent without delivery targets', async () => {
		const parent = createNote({
			id: 'parent',
			userId: 'bob',
			text: 'public parent body',
		});
		const child = createNote({
			id: 'child',
			userId: 'alice',
			text: 'child body',
			replyId: parent.id,
		});
		notesRepository.findOneBy.mockImplementation(async (options) => (options as { id?: string }).id === parent.id ? parent : null);

		const rendered = await rendererService.renderNote(child);

		expect(rendered.inReplyTo).toMatchObject({
			type: 'Note',
			id: 'https://local.example/notes/parent',
			content: '<p>public parent body</p>',
		});
		expect(JSON.stringify(rendered)).toContain('public parent body');
	});
});
