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
import type { DriveFilesRepository, EventsRepository, MiNote, NotesRepository, UsersRepository } from '@/models/_.js';

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
	const eventsRepository = mockDeep<EventsRepository>();
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
			if (token === DI.eventsRepository) return eventsRepository;
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
		mockReset(eventsRepository);
		mockReset(userEntityService);
		mockReset(apMfmService);
		mockReset(idService);

		notesRepository.findOneBy.mockResolvedValue(null);
		usersRepository.exists.mockResolvedValue(true);
		usersRepository.findBy.mockResolvedValue([]);
		driveFilesRepository.findBy.mockResolvedValue([]);
		eventsRepository.findOneBy.mockResolvedValue(null);
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

	test('event metadata cannot overwrite Note identity, content, audience, or flags', async () => {
		const start = new Date('2026-02-01T00:00:00.000Z');
		const note = createNote({
			id: 'note',
			userId: 'alice',
			text: 'benign',
			hasEvent: true,
		});
		eventsRepository.findOneBy.mockResolvedValue({
			noteId: note.id,
			title: 'event title',
			start,
			end: null,
			metadata: {
				'@type': 'Announce',
				'@context': 'https://evil.example/context',
				identifier: 'https://victim.example/events/abc',
				id: 'https://victim.example/notes/abc',
				attributedTo: 'https://victim.example/users/bob',
				type: 'Announce',
				content: '<p>forged</p>',
				_misskey_content: 'forged',
				source: { content: 'forged', mediaType: 'text/x.misskeymarkdown' },
				to: ['https://attacker.example/audience'],
				cc: ['https://attacker.example/cc'],
				sensitive: true,
				summary: 'forged summary',
				location: 'legit venue',
			},
		} as never);

		const rendered = await rendererService.renderNote(note);

		expect(rendered.id).toBe('https://local.example/notes/note');
		expect(rendered.type).toBe('Note');
		expect(rendered.attributedTo).toBe('https://local.example/users/alice');
		expect(rendered.content).toBe('<p>benign</p>');
		expect(rendered._misskey_content).toBe('benign');
		expect(rendered.source).toEqual({ content: 'benign', mediaType: 'text/x.misskeymarkdown' });
		expect(rendered.to).toEqual(['https://www.w3.org/ns/activitystreams#Public']);
		expect(rendered.cc).toEqual(['https://local.example/users/alice/followers']);
		expect(rendered.sensitive).toBe(false);
		expect(rendered.summary).toBeUndefined();
		// Safe schema.org Event fields are still federated.
		const eventFields = rendered as unknown as Record<string, unknown>;
		expect(eventFields['@type']).toBe('Event');
		expect(eventFields.identifier).toBe('https://local.example/notes/note');
		expect(eventFields.name).toBe('event title');
		expect(eventFields.startTime).toEqual(start);
		expect(eventFields.location).toBe('legit venue');
		expect(eventFields['@context']).toBeUndefined();
	});
});
