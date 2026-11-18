/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({ default: class { error() {} } }));
vi.mock('../../src/core/CacheService.js', () => ({ CacheService: class {} }));
vi.mock('../../src/core/DriveService.js', () => ({ DriveService: class {} }));
vi.mock('../../src/core/DriveFileUsageService.js', () => ({ DriveFileUsageService: class {} }));
vi.mock('../../src/core/NoteDeleteService.js', () => ({ NoteDeleteService: class {} }));
import { NoteAttachedFileService } from '../../src/core/NoteAttachedFileService.js';

function fixture({ enabled = true, cacheEnabled = undefined as boolean | undefined, cacheFails = false, failFileIds = [] as string[] } = {}) {
	const calls = { profileLookups: 0, cacheLookups: 0, deletedNotes: [] as string[], deletedFiles: [] as string[], usageOwners: [] as string[] };
	const files = [{ id: 'f1', userId: 'alice' }, { id: 'f2', userId: 'bob' }, { id: 'f3', userId: 'alice' }];
	const profiles = { findOne: async () => { calls.profileLookups++; return { userId: 'alice', autoDeleteNoteFiles: enabled }; } };
	const driveFiles = {
		createQueryBuilder: () => {
			let fileId = '';
			let owner = '';
			const builder: any = {
				andWhere: (_sql: string, params?: { fileId?: string }) => { fileId = params?.fileId ?? fileId; return builder; },
				getOne: async () => files.find(f => f.id === fileId && f.userId === owner) ?? null,
				setOwner: (userId: string) => { owner = userId; },
			};
			return builder;
		},
	};
	const cache = { userProfileCache: { fetch: async () => { calls.cacheLookups++; if (cacheFails) throw new Error('cache down'); return { autoDeleteNoteFiles: cacheEnabled ?? enabled }; } } };
	const drive = { deleteFile: async (file: { id: string }) => { if (failFileIds.includes(file.id)) throw new Error('delete failed'); calls.deletedFiles.push(file.id); } };
	// 실제 applyUnusedFilter처럼 소유자로 먼저 좁힌다.
	const usage = { applyUnusedFilter: (query: any, userId: string) => { calls.usageOwners.push(userId); query.setOwner(userId); return query; } };
	const noteDelete = { delete: async (_user: unknown, note: { id: string }) => { calls.deletedNotes.push(note.id); } };
	const service = new NoteAttachedFileService(profiles as any, driveFiles as any, cache as any, drive as any, usage as any, noteDelete as any);
	return { service, calls };
}

const local = { id: 'alice', host: null } as any;
const note = (fileIds: string[]) => ({ id: 'n1', userId: 'alice', fileIds }) as any;

test('첨부가 없는 노트는 설정을 조회하지 않고 기존 삭제만 부른다', async () => {
	const { service, calls } = fixture();

	await service.deleteOwnNote(local, note([]));

	expect(calls.deletedNotes).toEqual(['n1']);
	expect(calls.cacheLookups + calls.profileLookups).toBe(0);
	expect(calls.deletedFiles).toEqual([]);
});

test('원격 사용자의 노트는 첨부가 있어도 설정을 조회하지 않고 파일을 지우지 않는다', async () => {
	const { service, calls } = fixture();

	await service.deleteOwnNote({ id: 'alice', host: 'remote.example' } as any, note(['f1']));

	expect(calls.deletedNotes).toEqual(['n1']);
	expect(calls.cacheLookups + calls.profileLookups).toBe(0);
	expect(calls.deletedFiles).toEqual([]);
});

test('keepFiles가 켜져 있으면 설정을 조회하지 않고 파일을 남긴다', async () => {
	const { service, calls } = fixture();

	await service.deleteOwnNote(local, note(['f1']), { keepFiles: true });

	expect(calls.cacheLookups + calls.profileLookups).toBe(0);
	expect(calls.deletedFiles).toEqual([]);
});

test('로컬 사용자의 첨부가 있는 노트는 설정이 켜져 있을 때 단독 사용 파일을 지운다', async () => {
	const { service, calls } = fixture();

	await service.deleteOwnNote(local, note(['f1']));

	expect(calls.deletedNotes).toEqual(['n1']);
	expect(calls.deletedFiles).toEqual(['f1']);
});

test('설정이 꺼져 있으면 노트만 지우고 파일은 남긴다', async () => {
	const { service, calls } = fixture({ enabled: false });

	await service.deleteOwnNote(local, note(['f1']));

	expect(calls.deletedNotes).toEqual(['n1']);
	expect(calls.deletedFiles).toEqual([]);
});

test('다른 사람의 파일을 넘겨도 소유자로 좁혀 지우지 않는다', async () => {
	const { service, calls } = fixture();

	await service.deleteUnreferenced(local, ['f2', 'f1']);

	expect(calls.usageOwners).toEqual(['alice', 'alice']);
	expect(calls.deletedFiles).toEqual(['f1']);
});

test('캐시는 켜짐이지만 DB가 꺼짐이면 꺼짐으로 판단해 파일을 남긴다', async () => {
	const { service, calls } = fixture({ enabled: false, cacheEnabled: true });

	await service.deleteOwnNote(local, note(['f1']));

	expect(calls.cacheLookups).toBe(1);
	expect(calls.profileLookups).toBe(1);
	expect(await service.isEnabled('alice')).toBe(false);
	expect(calls.deletedNotes).toEqual(['n1']);
	expect(calls.deletedFiles).toEqual([]);
});

test('캐시 조회가 실패하면 DB 값으로 판단한다', async () => {
	const on = fixture({ enabled: true, cacheFails: true });
	const off = fixture({ enabled: false, cacheFails: true });

	expect(await on.service.isEnabled('alice')).toBe(true);
	expect(await off.service.isEnabled('alice')).toBe(false);
	await on.service.deleteOwnNote(local, note(['f1']));

	expect(on.calls.profileLookups).toBe(2);
	expect(on.calls.deletedFiles).toEqual(['f1']);
});

test('한 파일의 삭제가 실패해도 다음 파일은 계속 지운다', async () => {
	const { service, calls } = fixture({ failFileIds: ['f1'] });

	await expect(service.deleteUnreferenced(local, ['f1', 'f3'])).resolves.toBeUndefined();

	expect(calls.deletedFiles).toEqual(['f3']);
});
