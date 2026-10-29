/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { PollService } from '@/core/PollService.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const FOLLOWERS = 'https://local.test/users/author/followers';

function serviceFixture(noteOverrides: Record<string, unknown> = {}) {
	const note = {
		id: 'note',
		userId: 'author',
		visibility: 'specified',
		localOnly: false,
		deliveryTargets: null as { mode: 'include' | 'exclude'; hosts: string[] } | null,
		visibleUserIds: ['allowed', 'excluded'],
		...noteOverrides,
	};
	const author = { id: 'author', host: null };
	const usersRepository = {
		findOneBy: vi.fn().mockResolvedValue(author),
		find: vi.fn().mockResolvedValue([
			{ id: 'allowed', host: 'allowed.test', uri: 'https://allowed.test/users/allowed' },
			{ id: 'excluded', host: 'excluded.test', uri: 'https://excluded.test/users/excluded' },
		]),
	};
	const notesRepository = {
		findOneBy: vi.fn().mockResolvedValue(note),
	};
	const apRendererService = {
		renderNote: vi.fn().mockResolvedValue({ type: 'Note', to: [FOLLOWERS], cc: [] }),
		renderUpdate: vi.fn((object: unknown) => ({ type: 'Update', to: [PUBLIC], cc: [], object })),
		// Deliveries must carry the JSON-LD context that addContext adds; an identity mock would hide its omission.
		addContext: vi.fn((value: object) => ({ '@context': 'ctx', ...value })),
	};
	const deliver = {
		deliverToFollowers: vi.fn(),
		deliverToUsers: vi.fn(),
		deliverToUser: vi.fn(),
	};
	const relay = {
		deliverToRelays: vi.fn(),
	};
	const service = new PollService(
		usersRepository as any,
		notesRepository as any,
		{} as any,
		{} as any,
		{
			isLocalUser: vi.fn(() => true),
			genLocalUserUri: vi.fn((id: string) => `https://local.test/users/${id}`),
		} as any,
		{} as any,
		relay as any,
		{} as any,
		{} as any,
		apRendererService as any,
		deliver as any,
	);
	return { service, note, usersRepository, notesRepository, apRendererService, deliver, relay };
}

describe('PollService deliverQuestionUpdate', () => {
	test('sends a specified poll update only to allowed visible users', async () => {
		const f = serviceFixture();
		f.note.deliveryTargets = { mode: 'exclude', hosts: ['excluded.test'] };

		await f.service.deliverQuestionUpdate('note');

		expect(f.deliver.deliverToFollowers).not.toHaveBeenCalled();
		expect(f.relay.deliverToRelays).not.toHaveBeenCalled();
		expect(f.deliver.deliverToUsers).toHaveBeenCalledOnce();
		const [, content, recipients] = f.deliver.deliverToUsers.mock.calls[0];
		expect(content['@context']).toBe('ctx');
		expect(content.to).toEqual(['https://allowed.test/users/allowed']);
		expect(content.cc).toEqual([]);
		expect(recipients).toEqual([expect.objectContaining({ id: 'allowed' })]);
		expect(f.apRendererService.addContext).toHaveBeenCalledOnce();
	});

	test('does not relay a poll update for a followers-only note', async () => {
		const f = serviceFixture({ visibility: 'followers', visibleUserIds: [] });
		f.apRendererService.renderNote.mockResolvedValue({ type: 'Note', to: [FOLLOWERS], cc: [] });

		await f.service.deliverQuestionUpdate('note');

		expect(f.deliver.deliverToFollowers).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ '@context': 'ctx', type: 'Update', to: [FOLLOWERS], cc: [] }),
		);
		expect(f.relay.deliverToRelays).not.toHaveBeenCalled();
		expect(f.apRendererService.addContext).toHaveBeenCalledOnce();
	});

	test('relays a public poll update and keeps the note audience', async () => {
		const f = serviceFixture({ visibility: 'public', visibleUserIds: [] });
		f.apRendererService.renderNote.mockResolvedValue({ type: 'Note', to: [PUBLIC], cc: [FOLLOWERS] });

		await f.service.deliverQuestionUpdate('note');

		expect(f.deliver.deliverToFollowers).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ '@context': 'ctx', type: 'Update', to: [PUBLIC], cc: [FOLLOWERS] }),
		);
		expect(f.relay.deliverToRelays).toHaveBeenCalledOnce();
		expect(f.relay.deliverToRelays.mock.calls[0][1]).toEqual(expect.objectContaining({ '@context': 'ctx', type: 'Update', to: [PUBLIC], cc: [FOLLOWERS] }));
		expect(f.apRendererService.addContext).toHaveBeenCalledOnce();
	});
});
