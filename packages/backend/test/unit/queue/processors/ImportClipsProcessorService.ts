/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { ClipService } from '@/core/ClipService.js';
import { ImportClipsProcessorService } from '@/queue/processors/ImportClipsProcessorService.js';
import importClips from '@/server/api/endpoints/i/import-clips.js';

type Policies = { clipLimit: number; noteEachClipsLimit: number };

// 처리기의 실제 메서드를 쓰고, DB·원격 조회 경계만 대체한다.
function fixture(clips: unknown, policies: Policies, resolvable: (uri: string) => boolean = () => false) {
	const resolveNote = vi.fn(async (uri: string) => resolvable(uri) ? { id: `note-${uri}` } : null);
	const addNote = vi.fn(async () => {});
	const processor = Object.create(ImportClipsProcessorService.prototype) as ImportClipsProcessorService;
	let created = 0;
	Object.assign(processor, {
		logger: { info: vi.fn(), warn: vi.fn(), succ: vi.fn(), error: vi.fn() },
		usersRepository: { findOneBy: async () => ({ id: 'user' }) },
		driveFilesRepository: { findOneBy: async () => ({ id: 'file' }) },
		notesRepository: { findOneBy: async () => null },
		userEntityService: { isLocalUser: () => true },
		driveService: { readFileAsText: async () => JSON.stringify(clips) },
		roleService: { getUserPolicies: async () => policies },
		clipService: { create: async () => ({ id: `clip-${++created}` }), addNote },
		utilityService: { isFederationAllowedUri: () => true, isUriLocal: () => false },
		apNoteService: { fetchNote: async () => null, resolveNote },
		noteEntityService: { isVisibleForMe: async () => true },
	});
	return { processor, resolveNote, addNote, run: () => processor.process({ data: { user: { id: 'user' }, fileId: 'file' } } as never) };
}

const uris = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ note: { id: `${prefix}${i}`, uri: `https://remote.example/notes/${prefix}${i}` } }));

test('가져오지 못하는 URI가 많아도 클립당 노트 한도까지만 조회한다', async () => {
	const f = fixture([{ name: 'a', clipNotes: uris('a', 50) }], { clipLimit: 10, noteEachClipsLimit: 3 });
	await f.run();
	expect(f.resolveNote).toHaveBeenCalledTimes(3);
});

test('작업 전체의 조회는 클립 한도와 클립당 노트 한도의 곱까지만 시도한다', async () => {
	const clips = Array.from({ length: 5 }, (_, i) => ({ name: `c${i}`, clipNotes: uris(`c${i}-`, 20) }));
	const f = fixture(clips, { clipLimit: 2, noteEachClipsLimit: 3 });
	await f.run();
	expect(f.resolveNote).toHaveBeenCalledTimes(6);
});

test('한도 안의 정상 파일은 모든 노트를 가져온다', async () => {
	const clips = [{ name: 'a', clipNotes: uris('a', 2) }, { name: 'b', clipNotes: uris('b', 2) }];
	const f = fixture(clips, { clipLimit: 2, noteEachClipsLimit: 3 }, () => true);
	await f.run();
	expect(f.resolveNote).toHaveBeenCalledTimes(4);
	expect(f.addNote).toHaveBeenCalledTimes(4);
});

test('이미 추가된 노트도 조회 횟수에 센다', async () => {
	const f = fixture([{ name: 'a', clipNotes: uris('a', 10) }], { clipLimit: 10, noteEachClipsLimit: 4 }, () => true);
	f.addNote.mockRejectedValue(new ClipService.AlreadyAddedError());
	await f.run();
	expect(f.resolveNote).toHaveBeenCalledTimes(4);
});

function endpoint(size: number) {
	const queueService = { createImportClipsJob: vi.fn() };
	const readFileAsText = vi.fn(async () => '[]');
	const ep = new importClips(
		{ findOneBy: async () => ({ id: 'file', size }) } as never,
		{ countBy: async () => 0 } as never,
		{ getUserPolicies: async () => ({ clipLimit: 10 }) } as never,
		queueService as never,
		{ readFileAsText } as never,
	);
	return { ep, queueService, readFileAsText };
}

test('32MB를 넘는 파일은 읽지 않고 거절한다', async () => {
	const f = endpoint(32 * 1024 * 1024 + 1);
	await expect(f.ep.exec({ fileId: 'file' }, { id: 'user' } as never, null, null)).rejects.toMatchObject({ code: 'TOO_BIG_FILE' });
	expect(f.readFileAsText).not.toHaveBeenCalled();
	expect(f.queueService.createImportClipsJob).not.toHaveBeenCalled();
});

test('32MB 이하의 파일은 작업을 접수한다', async () => {
	const f = endpoint(32 * 1024 * 1024);
	await f.ep.exec({ fileId: 'file' }, { id: 'user' } as never, null, null);
	expect(f.queueService.createImportClipsJob).toHaveBeenCalledTimes(1);
});
