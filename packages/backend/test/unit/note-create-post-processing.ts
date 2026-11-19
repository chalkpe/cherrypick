/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteCreateService } from '@/core/NoteCreateService.js';

const author = { id: 'author', username: 'author', host: null, isBot: false };

/** postNoteCreated が使う協調オブジェクトだけを差し替えた NoteCreateService */
function fixture(options: { failPack?: boolean; failWebhook?: boolean } = {}) {
	const service = Object.create(NoteCreateService.prototype) as any;
	const stub = (name: string, value: unknown) => Object.defineProperty(service, name, { value, configurable: true, writable: true });

	const pack = vi.fn(async (note: { id: string }, me: unknown) => {
		if (me != null && options.failPack) throw new Error('recipient pack failed');
		return { id: note.id };
	});
	const enqueueUserWebhook = vi.fn(async () => {
		if (options.failWebhook) throw new Error('queue unavailable');
	});
	const createNotification = vi.fn();
	const publishMainStream = vi.fn();
	const error = vi.fn();
	const index = vi.fn();
	const createMentionedEvents = vi.fn(async () => {});

	service.meta = { enableStatsForFederatedInstances: false, enableChartsForRemoteUser: true };
	service.logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
	service.notesChart = { update: vi.fn() };
	service.perUserNotesChart = { update: vi.fn() };
	service.activeUsersChart = { write: vi.fn() };
	service.hashtagService = { updateHashtags: vi.fn() };
	service.userEntityService = { isLocalUser: () => true, isRemoteUser: () => false };
	service.antennaService = { addNoteToAntennas: vi.fn(async () => []) };
	service.noteEntityService = { pack };
	service.globalEventService = { publishNotesStream: vi.fn(), publishAntennaStream: vi.fn(), publishMainStream };
	service.roleService = { addNoteToRoleTimeline: vi.fn() };
	service.webhookService = {
		getActiveWebhooks: vi.fn(async () => [{ userId: 'target', on: ['reply', 'renote'] }, { userId: 'author', on: ['note'] }]),
		enqueueUserWebhook,
	};
	service.noteThreadMutingsRepository = { exists: vi.fn(async () => false) };
	service.notificationService = { createNotification };
	service.mutingsRepository = {};
	service.followingsRepository = { findBy: vi.fn(async () => []) };
	for (const name of ['incNotesCountOfUser', 'pushToTl', 'saveReply', 'incRenoteCount']) stub(name, vi.fn());
	stub('index', index);
	stub('createMentionedEvents', createMentionedEvents);

	const note = { id: 'note1', userId: author.id, visibility: 'public', threadId: null, renoteId: null };
	const post = (data: object) => service.postNoteCreated(note, author, { visibility: 'public', localOnly: true, ...data }, false, [], []);
	return { post, pack, enqueueUserWebhook, createNotification, publishMainStream, error, index, createMentionedEvents };
}

const target = { id: 'target', userId: 'target', userHost: null, threadId: null };

describe('새 노트의 후처리', () => {
	test.each(['pack', 'webhook'] as const)('답글 대상에게 보내는 이벤트의 %s가 실패해도 알림과 뒤따르는 처리를 한다', async failure => {
		const f = fixture({ failPack: failure === 'pack', failWebhook: failure === 'webhook' });

		await expect(f.post({ reply: target })).resolves.toBeUndefined();

		expect(f.createMentionedEvents).toHaveBeenCalledTimes(1);
		expect(f.createNotification).toHaveBeenCalledExactlyOnceWith('target', 'reply', { noteId: 'note1' }, 'author');
		expect(f.index).toHaveBeenCalledTimes(1);
		expect(f.error).toHaveBeenCalled();
	});

	test.each(['pack', 'webhook'] as const)('리노트 대상에게 보내는 이벤트의 %s가 실패해도 알림과 뒤따르는 처리를 한다', async failure => {
		const f = fixture({ failPack: failure === 'pack', failWebhook: failure === 'webhook' });

		await expect(f.post({ renote: target })).resolves.toBeUndefined();

		expect(f.createNotification).toHaveBeenCalledExactlyOnceWith('target', 'renote', { noteId: 'note1', targetNoteId: null }, 'author');
		expect(f.index).toHaveBeenCalledTimes(1);
		expect(f.error).toHaveBeenCalled();
	});

	test.each(['pack', 'webhook'] as const)('작성자의 note 웹훅의 %s가 실패해도 뒤따르는 처리를 한다', async failure => {
		const f = fixture({ failPack: failure === 'pack', failWebhook: failure === 'webhook' });

		await expect(f.post({})).resolves.toBeUndefined();

		expect(f.createMentionedEvents).toHaveBeenCalledTimes(1);
		expect(f.index).toHaveBeenCalledTimes(1);
		expect(f.error).toHaveBeenCalled();
	});

	test('실패가 없으면 이벤트를 받는 사람 기준으로 포장해 보내고 순서도 그대로다', async () => {
		const f = fixture();

		await f.post({ reply: target });

		expect(f.pack).toHaveBeenCalledWith(expect.objectContaining({ id: 'note1' }), { id: 'target' }, expect.anything());
		expect(f.publishMainStream).toHaveBeenCalledExactlyOnceWith('target', 'reply', { id: 'note1' });
		expect(f.enqueueUserWebhook.mock.calls).toEqual([['author', 'note', { note: { id: 'note1' } }], ['target', 'reply', { note: { id: 'note1' } }]]);
		expect(f.error).not.toHaveBeenCalled();
		const order = [
			f.enqueueUserWebhook.mock.invocationCallOrder[0],
			f.createMentionedEvents.mock.invocationCallOrder[0],
			f.publishMainStream.mock.invocationCallOrder[0],
			f.enqueueUserWebhook.mock.invocationCallOrder[1],
			f.createNotification.mock.invocationCallOrder[0],
			f.index.mock.invocationCallOrder[0],
		];
		expect(order).toEqual([...order].sort((x, y) => x - y));
	});
});
