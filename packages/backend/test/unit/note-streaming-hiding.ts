/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '@/server/api/stream/NoteStreamingHidingService.js';

function createService(followings: Record<string, unknown> = {}) {
	const meta = { ugcVisibilityForVisitor: 'all' } as any;
	const moduleRef = {
		get: (name: string) => name === 'CacheService' ? { userFollowingsCache: { fetch: async () => followings } } : {},
	};
	const noteEntityService = new NoteEntityService(moduleRef as any, meta, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
	noteEntityService.onModuleInit();
	return new NoteStreamingHidingService(meta, noteEntityService);
}

let seq = 0;

function note(userId: string, visibility: string, extra: Record<string, unknown> = {}): any {
	seq++;
	return {
		id: `n${seq}`, userId, visibility, text: `text-${userId}-${seq}`, cw: null, files: [], fileIds: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		user: { id: userId, host: null, makeNotesHiddenBefore: null, makeNotesFollowersOnlyBefore: null },
		reply: null, renote: null,
		...extra,
	};
}

describe('NoteStreamingHidingService', () => {
	test('returns the same note when everything is visible', async () => {
		const service = createService();
		const top = note('u1', 'public', { reply: note('u2', 'public', { reply: note('u3', 'public') }) });
		expect(await service.filter(top, 'me')).toBe(top);
	});

	test('hides a followers-only note two levels up a reply chain', async () => {
		const service = createService();
		const top = note('u1', 'public', {
			reply: note('u2', 'public', { reply: note('u3', 'followers') }),
		});
		const result = await service.filter(top, 'me');
		expect(result).not.toBeNull();
		expect(result).not.toBe(top);
		expect(result!.text).toBe(top.text);
		expect(result!.reply!.text).toBe(top.reply.text);
		expect(result!.reply!.reply!.text).toBeNull();
		expect(result!.reply!.reply!.isHidden).toBe(true);
		// 元のノートは変更しない
		expect(top.reply.reply.text).not.toBeNull();
	});

	test('hides a followers-only note quoted by a public reply target', async () => {
		const service = createService();
		const top = note('u1', 'public', {
			reply: note('u2', 'public', { renote: note('u2', 'followers') }),
		});
		const result = await service.filter(top, 'me');
		expect(result!.reply!.text).toBe(top.reply.text);
		expect(result!.reply!.renote!.text).toBeNull();
		expect(result!.reply!.renote!.isHidden).toBe(true);
	});

	test('keeps a followers-only note visible to a follower at any depth', async () => {
		const service = createService({ u3: {} });
		const top = note('u1', 'public', {
			reply: note('u2', 'public', { reply: note('u3', 'followers') }),
		});
		expect(await service.filter(top, 'me')).toBe(top);
	});

	test('still hides the direct reply target', async () => {
		const service = createService();
		const top = note('u1', 'public', { reply: note('u3', 'followers') });
		const result = await service.filter(top, 'me');
		expect(result!.reply!.text).toBeNull();
		expect(result!.text).toBe(top.text);
	});

	test('still skips a pure renote of a hidden note', async () => {
		const service = createService();
		const top = note('u1', 'public', { text: null, renote: note('u3', 'followers'), renoteId: 'r' });
		expect(await service.filter(top, 'me')).toBeNull();
	});

	test('still hides a quoted note without skipping the quote', async () => {
		const service = createService();
		const top = note('u1', 'public', { renote: note('u3', 'followers'), renoteId: 'r' });
		const result = await service.filter(top, 'me');
		expect(result!.text).toBe(top.text);
		expect(result!.renote!.text).toBeNull();
	});
});
