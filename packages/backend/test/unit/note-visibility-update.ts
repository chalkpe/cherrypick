/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteUpdateService } from '@/core/NoteUpdateService.js';
import { MiNote } from '@/models/Note.js';
import { MiPoll } from '@/models/Poll.js';
import { MiEvent } from '@/models/Event.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApQuestionService } from '@/core/activitypub/models/ApQuestionService.js';
import UpdateEndpoint from '@/server/api/endpoints/notes/update.js';
import HistoryEndpoint from '@/server/api/endpoints/notes/history.js';

function endpointFixture(moderator = true, canEditNote = true) {
	const note = { id: 'note', userId: 'author', visibility: 'public', channelId: null };
	const roleService = {
		isModerator: vi.fn().mockResolvedValue(moderator),
		isAdministrator: vi.fn().mockResolvedValue(false),
		getUserPolicies: vi.fn().mockResolvedValue({ canEditNote }),
	};
	const service = {
		updateVisibility: vi.fn().mockResolvedValue(note),
		update: vi.fn().mockResolvedValue(note),
	};
	const endpoint = new UpdateEndpoint(
		{} as any, { getNote: vi.fn().mockResolvedValue(note) } as any,
		roleService as any, { pack: vi.fn().mockResolvedValue(note) } as any, service as any,
	);
	return { endpoint, service, roleService, note };
}

describe('notes/update moderation', () => {
	test('allows moderators even when author editing policy is disabled', async () => {
		const { endpoint, service, roleService } = endpointFixture(true, false);
		await endpoint.exec({ noteId: 'note', visibility: 'home' }, { id: 'moderator' } as any, null, null);
		expect(service.updateVisibility).toHaveBeenCalledOnce();
		expect(service.update).not.toHaveBeenCalled();
		expect(roleService.getUserPolicies).not.toHaveBeenCalled();
	});

	test.each(['author', 'other'])('rejects visibility changes by ordinary user %s', async id => {
		const { endpoint, service } = endpointFixture(false);
		await expect(endpoint.exec({ noteId: 'note', visibility: 'home' }, { id } as any, null, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(service.updateVisibility).not.toHaveBeenCalled();
	});

	test('rejects third party moderation tokens including the author', async () => {
		const { endpoint } = endpointFixture();
		await expect(endpoint.exec({ noteId: 'note', visibility: 'home' }, { id: 'author' } as any, {} as any, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
	});

	test.each([
		{ text: 'changed' }, { cw: null }, { fileIds: ['file'] }, { mediaIds: ['file'] },
		{ poll: null }, { event: null }, { disableRightClick: false }, { scheduledDelete: null },
	])('rejects combining moderation with content fields: %j', async content => {
		const { endpoint, service } = endpointFixture();
		await expect(endpoint.exec({ noteId: 'note', visibility: 'home', ...content }, { id: 'moderator' } as any, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(service.update).not.toHaveBeenCalled();
		expect(service.updateVisibility).not.toHaveBeenCalled();
	});

	test('rejects editing another user’s content even for moderators', async () => {
		const { endpoint, service } = endpointFixture();
		await expect(endpoint.exec({ noteId: 'note', text: 'changed', cw: null }, { id: 'moderator' } as any, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_NOTE' });
		expect(service.update).not.toHaveBeenCalled();
	});

	test('retains the author editor and default right-click behavior', async () => {
		const { endpoint, service } = endpointFixture(false);
		await endpoint.exec({ noteId: 'note', text: 'changed', cw: null }, { id: 'author' } as any, {} as any, null);
		expect(service.update).toHaveBeenCalledWith({ id: 'author' }, expect.objectContaining({ text: 'changed', cw: null, disableRightClick: false }), expect.anything(), false);
		expect(service.updateVisibility).not.toHaveBeenCalled();
	});

	test('retains the author edit policy and rejects an empty edit', async () => {
		await expect(endpointFixture(false, false).endpoint.exec({ noteId: 'note', text: 'changed', cw: null }, { id: 'author' } as any, null, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		await expect(endpointFixture().endpoint.exec({ noteId: 'note' }, { id: 'author' } as any, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	});

	test('does not change the fixed audience of channel notes', async () => {
		const { endpoint, note } = endpointFixture();
		Object.assign(note, { channelId: 'channel' });
		await expect(endpoint.exec({ noteId: 'note', visibility: 'followers' }, { id: 'moderator' } as any, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	});
});

function serviceFixture(local = false) {
	const note = new MiNote({
		id: 'note', userId: 'author', visibility: 'public', text: 'keep this', cw: 'keep cw',
		fileIds: ['file'], hasPoll: true, hasEvent: true, tags: ['tag'], emojis: ['emoji'],
		visibleUserIds: [], mentionedRemoteUsers: '[]', replyUserId: 'reply', localOnly: false,
	});
	let updated = note;
	const manager = { update: vi.fn(async (entity, _where, values) => {
		if (entity === MiNote) updated = new MiNote({ ...updated, ...values });
	}) };
	const author = { id: 'author', username: 'author', host: local ? null : 'remote.test' };
	const stream = { publishNoteStream: vi.fn() };
	const fanout = { remove: vi.fn().mockResolvedValue(0) };
	const search = { unindexNote: vi.fn(), indexNote: vi.fn() };
	const moderation = { log: vi.fn() };
	const history = { recordHistory: vi.fn() };
	const deliver = { deliverToFollowers: vi.fn(), deliverToUsers: vi.fn(), deliverToUser: vi.fn() };
	const relay = { deliverToRelays: vi.fn() };
	const renderer = {
		renderNote: vi.fn().mockResolvedValue({ id: 'https://local.test/notes/note', content: 'keep this', to: ['https://local.test/users/author/followers'], cc: [] }),
		renderDelete: vi.fn((object, _author) => ({ type: 'Delete', object })),
		renderUpdate: vi.fn((object, _author) => ({ type: 'Update', to: ['https://www.w3.org/ns/activitystreams#Public'], object })),
		addContext: vi.fn(value => value),
	};
	const usersRepository = { findOneByOrFail: vi.fn().mockResolvedValue(author), find: vi.fn().mockResolvedValue([]) };
	const notesRepository = { findOneByOrFail: vi.fn(async () => updated), findOneBy: vi.fn(async () => updated) };
	const noteEntityService = { isVisibleForMe: vi.fn().mockResolvedValue(true) };
	const meta = {
		ugcVisibilityForVisitor: 'all' as 'all' | 'local' | 'none',
		prohibitedWords: [] as string[],
		sensitiveWords: [] as string[],
	};
	const utilityService = new UtilityService({ host: 'local.test' } as any, meta as any);
	const pollVotesRepository = { delete: vi.fn() };
	const service = new NoteUpdateService(
		{ transaction: vi.fn(cb => cb(manager)) } as any,
		usersRepository as any,
		notesRepository as any,
		{ isLocalUser: vi.fn(() => local) } as any,
		stream as any, {} as any, relay as any, deliver as any, renderer as any,
		search as any, {} as any, history as any, fanout as any, moderation as any,
		noteEntityService as any,
		meta as any, utilityService, pollVotesRepository as any,
	);
	return { service, note, manager, stream, fanout, search, moderation, history, deliver, relay, renderer, usersRepository, notesRepository, noteEntityService, meta, utilityService, pollVotesRepository };
}

describe('NoteUpdateService visibility', () => {
	test('preserves content, attachments, poll votes and events while updating their audience', async () => {
		const f = serviceFixture();
		const result = await f.service.updateVisibility({ id: 'moderator' } as any, f.note, 'followers');
		expect(result).toMatchObject({ text: 'keep this', cw: 'keep cw', fileIds: ['file'], hasPoll: true, hasEvent: true, tags: ['tag'], emojis: ['emoji'], visibility: 'followers' });
		expect(f.manager.update.mock.calls).toEqual([
			[MiNote, { id: 'note' }, { visibility: 'followers', updatedAt: expect.any(Date) }],
			[MiPoll, { noteId: 'note' }, { noteVisibility: 'followers' }],
			[MiEvent, { noteId: 'note' }, { noteVisibility: 'followers' }],
		]);
		expect(f.history.recordHistory).not.toHaveBeenCalled();
		expect(f.stream.publishNoteStream).toHaveBeenCalledWith(f.note, 'updated', { updatedAt: expect.any(Date) });
		expect(f.fanout.remove).toHaveBeenCalledTimes(5);
		expect(f.search.unindexNote).toHaveBeenCalledWith(f.note);
		expect(f.search.indexNote).toHaveBeenCalledWith(result);
		expect(f.moderation.log).toHaveBeenCalledWith({ id: 'moderator' }, 'updateNote', expect.objectContaining({ before: 'public', after: 'followers' }));
		expect(f.renderer.renderNote).not.toHaveBeenCalled();
	});

	test('does nothing for unchanged visibility', async () => {
		const f = serviceFixture();
		await f.service.updateVisibility({ id: 'moderator' } as any, f.note, 'public');
		expect(f.manager.update).not.toHaveBeenCalled();
		expect(f.moderation.log).not.toHaveBeenCalled();
	});

	test.each(['home', 'followers', 'specified'] as const)('updates previous recipients when narrowed to %s without conflicting deletions', async visibility => {
		const f = serviceFixture(true);
		await f.service.updateVisibility({ id: 'moderator' } as any, f.note, visibility);
		expect(f.relay.deliverToRelays).toHaveBeenCalledOnce();
		expect(f.relay.deliverToRelays).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'Update' }));
		expect(f.deliver.deliverToFollowers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'Update', to: visibility === 'specified' ? [] : ['https://local.test/users/author/followers'], cc: [] }));
		expect(f.deliver.deliverToUsers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'Update' }), expect.any(Array));
		expect(f.renderer.renderDelete).not.toHaveBeenCalled();
	});

	test('honors deliveryTargets and skips relays when the audience changes', async () => {
		const f = serviceFixture(true);
		f.note.deliveryTargets = { mode: 'exclude', hosts: ['evil.test'] };
		await f.service.updateVisibility({ id: 'moderator' } as any, f.note, 'home');
		expect(f.deliver.deliverToFollowers).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ type: 'Update' }),
			{ mode: 'exclude', hosts: ['evil.test'] },
		);
		expect(f.relay.deliverToRelays).not.toHaveBeenCalled();
	});

	test('updates relay caches even when a formerly public note is now home', async () => {
		const f = serviceFixture(true);
		f.note.visibility = 'home';
		await f.service.updateVisibility({ id: 'moderator' } as any, f.note, 'followers');
		expect(f.relay.deliverToRelays).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'Update' }));
		expect(f.renderer.renderDelete).not.toHaveBeenCalled();
	});

	test('informs a previously known quote recipient even after it loses access', async () => {
		const f = serviceFixture(true);
		f.note.renoteUserId = 'quoteRecipient';
		const recipient = { id: 'quoteRecipient', host: 'recipient.test' };
		(f.service as any).usersRepository.find.mockResolvedValue([recipient]);
		(f.service as any).noteEntityService.isVisibleForMe.mockResolvedValue(false);
		await f.service.updateVisibility({ id: 'moderator' } as any, f.note, 'followers');
		expect(f.deliver.deliverToUsers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'Update', to: ['https://local.test/users/author/followers'] }), [recipient]);
	});

	test('author edits to specified notes reach only their current explicit remote recipients', async () => {
		const f = serviceFixture(true);
		f.note.visibility = 'specified';
		f.note.visibleUserIds = ['recipient'];
		const recipient = { id: 'recipient', host: 'recipient.test' };
		(f.service as any).usersRepository.find.mockResolvedValue([recipient, { id: 'local', host: null }]);
		const activity = { type: 'Update' };
		await (f.service as any).deliverToConcerned({ id: 'author', host: null }, f.note, activity);
		expect(f.deliver.deliverToUsers).toHaveBeenCalledWith({ id: 'author', host: null }, activity, [recipient]);
		expect(f.deliver.deliverToFollowers).not.toHaveBeenCalled();
		expect(f.relay.deliverToRelays).not.toHaveBeenCalled();
	});

	test('specified edits exclude delivery target hosts from the audience and delivery', async () => {
		const f = serviceFixture(true);
		f.note.visibility = 'specified';
		f.note.visibleUserIds = ['allowed', 'excluded'];
		f.note.deliveryTargets = { mode: 'exclude', hosts: ['excluded.test'] };
		const allowed = { id: 'allowed', host: 'allowed.test', uri: 'https://allowed.test/users/allowed' };
		const excluded = { id: 'excluded', host: 'excluded.test', uri: 'https://excluded.test/users/excluded' };
		(f.service as any).usersRepository.find.mockResolvedValue([allowed, excluded]);

		const activity = await (f.service as any).renderNoteActivity(f.note, { id: 'author', username: 'author', host: null });
		expect(activity.to).toEqual(['https://allowed.test/users/allowed']);
		expect(activity.cc).toEqual([]);

		await (f.service as any).deliverToConcerned({ id: 'author', host: null }, f.note, activity);
		expect(f.deliver.deliverToUsers).toHaveBeenCalledWith({ id: 'author', host: null }, activity, [allowed]);
		expect(f.deliver.deliverToFollowers).not.toHaveBeenCalled();
		expect(f.relay.deliverToRelays).not.toHaveBeenCalled();
	});

	test('invalidates the previous audience when specified recipient IDs change', async () => {
		const f = serviceFixture();
		f.note.visibility = 'specified';
		f.note.visibleUserIds = ['old'];
		const updatedNote = new MiNote({ ...f.note, visibleUserIds: ['new'] });
		vi.spyOn(f.service as any, 'updateNote').mockResolvedValue(updatedNote);
		await f.service.update({ id: 'author', username: 'author', host: 'remote.test', isBot: false }, { text: 'keep this', visibility: 'specified', visibleUserIds: ['new'] }, f.note, true);
		f.service.dispose();
		expect(f.stream.publishNoteStream).toHaveBeenCalledWith(f.note, 'updated', { updatedAt: expect.any(Date) });
	});
});

describe('NoteUpdateService checkRevisionsAccess', () => {
	test('restricts anonymous viewers when the author requires sign-in', async () => {
		const f = serviceFixture();
		f.usersRepository.findOneByOrFail.mockResolvedValue({ requireSigninToViewContents: true });
		await expect(f.service.checkRevisionsAccess(f.note, null)).resolves.toBe('restrictedByUser');
		expect(f.noteEntityService.isVisibleForMe).not.toHaveBeenCalled();
	});

	test('restricts anonymous viewers when the server disallows visitor content', async () => {
		const f = serviceFixture();
		f.meta.ugcVisibilityForVisitor = 'none';
		await expect(f.service.checkRevisionsAccess(f.note, null)).resolves.toBe('restrictedByServer');
		expect(f.noteEntityService.isVisibleForMe).not.toHaveBeenCalled();
	});

	test('restricts anonymous viewers when only local content is visible and the note is remote', async () => {
		const f = serviceFixture();
		f.meta.ugcVisibilityForVisitor = 'local';
		f.note.userHost = 'remote.test';
		await expect(f.service.checkRevisionsAccess(f.note, null)).resolves.toBe('restrictedByServer');
	});

	test('allows anonymous viewers when only local content is visible and the note is local', async () => {
		const f = serviceFixture();
		f.meta.ugcVisibilityForVisitor = 'local';
		f.note.userHost = null;
		await expect(f.service.checkRevisionsAccess(f.note, null)).resolves.toBe('ok');
	});

	test('reports notes that are invisible to the viewer', async () => {
		const f = serviceFixture();
		f.noteEntityService.isVisibleForMe.mockResolvedValue(false);
		await expect(f.service.checkRevisionsAccess(f.note, 'viewer')).resolves.toBe('invisible');
	});

	test('does not apply visitor restrictions to signed-in viewers', async () => {
		const f = serviceFixture();
		f.usersRepository.findOneByOrFail.mockResolvedValue({ requireSigninToViewContents: true });
		f.meta.ugcVisibilityForVisitor = 'none';
		await expect(f.service.checkRevisionsAccess(f.note, 'viewer')).resolves.toBe('ok');
		expect(f.usersRepository.findOneByOrFail).not.toHaveBeenCalled();
		expect(f.noteEntityService.isVisibleForMe).toHaveBeenCalledWith(f.note, 'viewer');
	});

	test('lets signed-in viewers read remote notes when only local content is visible to visitors', async () => {
		const f = serviceFixture();
		f.meta.ugcVisibilityForVisitor = 'local';
		f.note.userHost = 'remote.test';
		await expect(f.service.checkRevisionsAccess(f.note, 'viewer')).resolves.toBe('ok');
	});

	test('still requires note visibility for anonymous viewers that pass visitor restrictions', async () => {
		const f = serviceFixture();
		f.noteEntityService.isVisibleForMe.mockResolvedValue(false);
		await expect(f.service.checkRevisionsAccess(f.note, null)).resolves.toBe('invisible');
		expect(f.noteEntityService.isVisibleForMe).toHaveBeenCalledWith(f.note, null);
	});
});

describe('notes/history visibility', () => {
	function historyFixture(access: 'ok' | 'restrictedByUser' | 'restrictedByServer' | 'invisible', hidden = false) {
		const note = new MiNote({
			id: 'note', userId: 'author', visibility: 'public', text: 'current', cw: null,
			fileIds: [], visibleUserIds: [], mentionedRemoteUsers: '[]', tags: [], emojis: [],
		});
		const packedNote = {
			id: note.id, userId: note.userId, visibility: 'public', createdAt: new Date().toISOString(),
			user: { requireSigninToViewContents: false, makeNotesHiddenBefore: null, makeNotesFollowersOnlyBefore: null },
			visibleUserIds: [], mentions: [], reply: undefined,
		};
		const noteEntityService = {
			pack: vi.fn().mockResolvedValue(packedNote),
			shouldHideNote: vi.fn().mockResolvedValue(hidden),
		};
		const noteUpdateService = { checkRevisionsAccess: vi.fn().mockResolvedValue(access) };
		const getHistory = vi.fn().mockResolvedValue([{ id: 'history' }]);
		const packMany = vi.fn().mockResolvedValue([{ id: 'history' }]);
		const endpoint = new HistoryEndpoint(
			{ packMany } as any, { getHistory } as any,
			{ getNote: vi.fn().mockResolvedValue(note) } as any,
			noteEntityService as any, noteUpdateService as any,
		);
		return { endpoint, note, getHistory, packMany, noteEntityService, noteUpdateService };
	}

	test.each([
		['restrictedByUser', 'CONTENT_RESTRICTED_BY_USER'],
		['restrictedByServer', 'CONTENT_RESTRICTED_BY_SERVER'],
		['invisible', 'NO_SUCH_NOTE'],
	] as const)('maps %s access to %s without reading history', async (access, code) => {
		const f = historyFixture(access);
		await expect(f.endpoint.exec({ noteId: 'note' }, null, null, null)).rejects.toMatchObject({ code });
		expect(f.getHistory).not.toHaveBeenCalled();
		expect(f.packMany).not.toHaveBeenCalled();
	});

	test('returns no history for notes hidden by the author time policy', async () => {
		const f = historyFixture('ok', true);
		await expect(f.endpoint.exec({ noteId: 'note' }, null, null, null)).resolves.toEqual([]);
		expect(f.noteEntityService.shouldHideNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'note' }), null);
		expect(f.getHistory).not.toHaveBeenCalled();
	});

	test('returns history for accessible notes', async () => {
		const f = historyFixture('ok');
		await expect(f.endpoint.exec({ noteId: 'note' }, { id: 'viewer' } as any, null, null)).resolves.toEqual([{ id: 'history' }]);
		expect(f.noteUpdateService.checkRevisionsAccess).toHaveBeenCalledWith(f.note, 'viewer');
		expect(f.packMany).toHaveBeenCalled();
	});
});

describe('private event packing', () => {
	test('clears event details with the rest of a hidden note', () => {
		const service = Object.create(NoteEntityService.prototype) as NoteEntityService;
		const note = { text: 'private', event: { title: 'private event' } } as any;
		service.hideNote(note);
		expect(note.event).toBeUndefined();
		expect(note.text).toBeNull();
	});
});

function inboundFixture(actorId = 'author') {
	const note = {
		id: 'https://remote.test/notes/note', attributedTo: 'https://remote.test/users/author',
		to: ['https://remote.test/users/author/followers'], cc: [], attachment: [], tag: [],
		source: { mediaType: 'text/x.misskeymarkdown', content: 'unchanged' },
	};
	const update = vi.fn().mockResolvedValue({ id: 'note' });
	const parseAudience = vi.fn().mockResolvedValue({ visibility: 'followers', visibleUsers: [] });
	const service = Object.assign(Object.create(ApNoteService.prototype), {
		apPersonService: { resolvePerson: vi.fn().mockResolvedValue({ id: actorId, host: 'remote.test', isSuspended: false }) },
		apAudienceService: { parseAudience },
		apQuestionService: { extractPollFromQuestion: vi.fn().mockResolvedValue(null) },
		apEventService: { extractEventFromNote: vi.fn().mockResolvedValue(null) },
		noteUpdateService: { update },
		logger: { warn: vi.fn() },
	}) as ApNoteService;
	Object.defineProperty(service, 'validateNote', { value: vi.fn().mockReturnValue(null) });
	Object.defineProperty(service, 'extractEmojis', { value: vi.fn().mockResolvedValue([]) });
	return { service, note, update, parseAudience };
}

describe('ActivityPub visibility updates', () => {
	test('applies the verified author’s new audience with content', async () => {
		const f = inboundFixture();
		await f.service.updateNote(f.note.id, { id: 'note', userId: 'author' } as any, { resolve: vi.fn().mockResolvedValue(f.note) } as any);
		expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'author' }), expect.objectContaining({ visibility: 'followers', visibleUserIds: [], text: 'unchanged' }), expect.anything(), false);
	});

	test('rejects another actor before parsing audience or updating content', async () => {
		const f = inboundFixture('attacker');
		await expect(f.service.updateNote(f.note.id, { id: 'note', userId: 'author' } as any, { resolve: vi.fn().mockResolvedValue(f.note) } as any)).rejects.toThrow('cannot update another actor');
		expect(f.parseAudience).not.toHaveBeenCalled();
		expect(f.update).not.toHaveBeenCalled();
	});
});

// A mentioned non-follower can read a followers-only note, but is absent from `following`.
// Its existing subscription must still invalidate when moderation removes that access.
describe('note stream audience invalidation', () => {
	test('sends content-free updates to subscribers who are no longer in the audience', async () => {
		const { default: Connection } = await import('@/server/api/stream/Connection.js');
		const connection = Object.assign(Object.create(Connection.prototype), {
			user: { id: 'formerMention' }, following: {}, meta: {},
		});
		const sendMessageToWs = vi.fn();
		Object.defineProperty(connection, 'sendMessageToWs', { value: sendMessageToWs });
		const body = { id: 'note', userId: 'author', visibility: 'followers', visibleUserIds: [], mentions: ['formerMention'], body: { updatedAt: new Date() } };
		await connection.onNoteStreamMessage({ type: 'updated', body });
		expect(sendMessageToWs).toHaveBeenCalledWith('noteUpdated', { id: 'note', type: 'updated', body: body.body });
		sendMessageToWs.mockClear();
		await connection.onNoteStreamMessage({ type: 'updated', body: { ...body, mentions: [] } });
		expect(sendMessageToWs).not.toHaveBeenCalled();
	});
});

describe('ActivityPub Question update routing', () => {
	test('updates the verified note audience/content before reconciling poll vote totals', async () => {
		const actor = { id: 'author', uri: 'https://remote.test/users/author' };
		const question = { id: 'https://remote.test/notes/poll', type: 'Question', attributedTo: actor.uri, content: 'poll', attachment: [], to: [actor.uri + '/followers'] };
		const activity = { type: 'Update', actor: actor.uri, object: question };
		const resolver = { resolve: vi.fn().mockResolvedValue(question) };
		const updateNote = vi.fn().mockResolvedValue('ok');
		const updateQuestion = vi.fn().mockResolvedValue(true);
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			logger: { debug: vi.fn() }, apQuestionService: { updateQuestion },
		});
		Object.defineProperty(inbox, 'updateNote', { value: updateNote });
		expect(await inbox.update(actor, activity, resolver)).toBe('ok: Question updated');
		expect(updateNote).toHaveBeenCalledWith(resolver, actor, question, false, activity);
		expect(updateQuestion).toHaveBeenCalledWith(question, actor, resolver);
		expect(updateNote.mock.invocationCallOrder[0]).toBeLessThan(updateQuestion.mock.invocationCallOrder[0]);
	});

	test('does not update poll totals when the verified note path rejects the actor or target', async () => {
		const actor = { uri: 'https://remote.test/users/author' };
		const question = { id: 'https://remote.test/notes/poll', type: 'Question', attributedTo: actor.uri, content: 'poll', attachment: [], to: [actor.uri + '/followers'] };
		const updateQuestion = vi.fn();
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			logger: { debug: vi.fn() }, apQuestionService: { updateQuestion },
		});
		Object.defineProperty(inbox, 'updateNote', { value: vi.fn().mockResolvedValue('skip: invalid actor') });
		await expect(inbox.update(actor, { actor: actor.uri, object: question }, { resolve: vi.fn().mockResolvedValue(question) })).resolves.toBe('skip: invalid actor');
		expect(updateQuestion).not.toHaveBeenCalled();
	});

	test('normalizes full Question array attribution without bypassing the verified note path', async () => {
		const actor = { uri: 'https://remote.test/users/author' };
		const question = { id: 'https://remote.test/notes/poll', type: 'Question', attributedTo: [actor.uri], content: 'poll', attachment: [], to: [actor.uri + '/followers'] };
		const updateNote = vi.fn().mockResolvedValue('ok');
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			logger: { debug: vi.fn() }, apQuestionService: { updateQuestion: vi.fn().mockResolvedValue(true) },
		});
		Object.defineProperty(inbox, 'updateNote', { value: updateNote });
		const resolver = { resolve: vi.fn().mockResolvedValue(question) };
		const activity = { actor: actor.uri, object: question };
		await inbox.update(actor, activity, resolver);
		expect(updateNote).toHaveBeenCalledWith(resolver, actor, { ...question, attributedTo: actor.uri }, false, activity);
	});

	test('does not treat an unsupported source format as a complete text representation', async () => {
		const actor = { uri: 'https://remote.test/users/author' };
		const question = {
			id: 'https://remote.test/notes/poll', type: 'Question', attributedTo: actor.uri,
			source: { mediaType: 'text/plain', content: 'unsupported source' }, attachment: [], to: [actor.uri + '/followers'],
		};
		const updateNote = vi.fn();
		const updateQuestion = vi.fn().mockResolvedValue(true);
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			logger: { debug: vi.fn() }, apQuestionService: { updateQuestion },
		});
		Object.defineProperty(inbox, 'updateNote', { value: updateNote });
		await inbox.update(actor, { actor: actor.uri, object: question }, { resolve: vi.fn().mockResolvedValue(question) });
		expect(updateNote).not.toHaveBeenCalled();
		expect(updateQuestion).toHaveBeenCalledOnce();
	});

	test.each([undefined, 'https://remote.test/users/author', ['https://remote.test/users/author']])('preserves content for tally-only Questions with attribution %j', async attributedTo => {
		const actor = { id: 'author', uri: 'https://remote.test/users/author' };
		const note = { id: 'note', text: 'keep content', fileIds: ['file'] };
		const poll = { userId: actor.id, choices: ['one'], votes: [1] };
		const question = { id: 'https://remote.test/notes/poll', type: 'Question', attributedTo, oneOf: [{ name: 'one', replies: { totalItems: 3 } }] };
		const resolver = { resolve: vi.fn().mockResolvedValue(question) };
		const pollsRepository = { findOneBy: vi.fn().mockResolvedValue(poll), update: vi.fn() };
		const apQuestionService = new ApQuestionService(
			{} as any, { findOneBy: vi.fn().mockResolvedValue(actor) } as any,
			{ findOneBy: vi.fn().mockResolvedValue(note) } as any, pollsRepository as any,
			{} as any, { logger: { debug: vi.fn() } } as any, { isUriLocal: () => false } as any,
		);
		const updateNote = vi.fn();
		const inbox = Object.assign(Object.create(ApInboxService.prototype), { logger: { debug: vi.fn() }, apQuestionService });
		Object.defineProperty(inbox, 'updateNote', { value: updateNote });
		expect(await inbox.update(actor, { actor: actor.uri, object: question }, resolver)).toBe('ok: Question updated');
		expect(updateNote).not.toHaveBeenCalled();
		expect(pollsRepository.update).toHaveBeenCalledWith({ noteId: note.id }, { votes: [3] });
		expect(note).toEqual({ id: 'note', text: 'keep content', fileIds: ['file'] });
	});

	test('retains the existing vote-bearing poll row when content/audience updates keep choices unchanged', async () => {
		const f = serviceFixture();
		f.note.hasEvent = false;
		const poll = { noteId: f.note.id, choices: ['one', 'two'], multiple: false, votes: [4, 7], expiresAt: null };
		const manager = { update: vi.fn(), findOneBy: vi.fn().mockResolvedValue(poll), delete: vi.fn(), insert: vi.fn() };
		(f.service as any).db = {
			getRepository: vi.fn().mockReturnValue({ findOneBy: vi.fn().mockResolvedValue(poll) }),
			transaction: vi.fn(cb => cb(manager)),
		};
		(f.service as any).notesRepository.findOneBy = vi.fn().mockResolvedValue(f.note);
		await (f.service as any).updateNote({ id: 'author', host: 'remote.test' }, f.note, {
			text: 'keep this', visibility: 'followers', poll: { choices: ['one', 'two'], multiple: false, expiresAt: null },
		}, [], []);
		expect(manager.delete).not.toHaveBeenCalled();
		expect(manager.insert).not.toHaveBeenCalled();
		expect(manager.update).toHaveBeenCalledWith(MiPoll, { noteId: f.note.id }, { noteVisibility: 'followers' });
		expect(poll.votes).toEqual([4, 7]);
	});
});
