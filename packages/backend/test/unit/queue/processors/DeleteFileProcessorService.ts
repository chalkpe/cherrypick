/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { DriveService } from '@/core/DriveService.js';
import { QueueService } from '@/core/QueueService.js';
import { DeleteFileProcessorService } from '@/queue/processors/DeleteFileProcessorService.js';
import type { MiDriveFile } from '@/models/DriveFile.js';

// 큐 접수 → 처리기 → 오브젝트 스토리지 삭제까지 실제 메서드를 쓰고, Redis와 S3 전송 경계만 대체한다.
function fixture() {
	const jobs: { name: string; data: Record<string, unknown> }[] = [];
	const queue = Object.create(QueueService.prototype) as QueueService;
	Object.assign(queue, { objectStorageQueue: { add: async (name: string, data: Record<string, unknown>) => { jobs.push({ name, data }); return {}; } } });

	const s3Calls: { bucket: string | undefined; key: string | undefined; isRemote: boolean | undefined }[] = [];
	const drive = Object.create(DriveService.prototype) as DriveService;
	Object.assign(drive, {
		queueService: queue,
		meta: { useRemoteObjectStorage: true, objectStorageBucket: 'local-bucket', remoteObjectStorageBucket: 'remote-bucket', enableChartsForFederatedInstances: false },
		s3Service: { delete: async (_meta: unknown, input: { Bucket?: string; Key?: string }, isRemote?: boolean) => { s3Calls.push({ bucket: input.Bucket, key: input.Key, isRemote }); } },
		deleteLogger: { warn: vi.fn() },
		driveFilesRepository: { delete: async () => ({ affected: 1, raw: [] }) },
		driveChart: { update: vi.fn() },
		perUserDriveChart: { update: vi.fn() },
		instanceChart: { updateDrive: vi.fn() },
		globalEventService: { publishDriveStream: vi.fn() },
	});

	const processor = Object.create(DeleteFileProcessorService.prototype) as DeleteFileProcessorService;
	Object.assign(processor, {
		driveFilesRepository: { createQueryBuilder: () => { const q = { where: () => q, orWhere: () => q, getOne: async () => null }; return q; } },
		driveService: drive,
		userEntityService: { isRemoteUser: (u: { host: string | null }) => u.host != null },
	});

	const run = async () => {
		for (const job of jobs) await processor.process({ data: job.data } as never);
	};
	return { jobs, s3Calls, drive, run };
}

function file(userHost: string | null): MiDriveFile {
	return {
		id: 'file', userId: 'owner', userHost, isLink: false, storedInternal: false,
		accessKey: 'original', thumbnailUrl: null, webpublicUrl: null,
	} as unknown as MiDriveFile;
}

test('원격 사용자의 파일을 비동기로 삭제하면 원격 버킷에서 지운다', async () => {
	const f = fixture();
	await f.drive.deleteFile(file('remote.example'));
	await f.run();
	expect(f.s3Calls).toEqual([{ bucket: 'remote-bucket', key: 'original', isRemote: true }]);
});

test('로컬 사용자의 파일을 비동기로 삭제하면 로컬 버킷에서 지운다', async () => {
	const f = fixture();
	await f.drive.deleteFile(file(null));
	await f.run();
	expect(f.s3Calls).toEqual([{ bucket: 'local-bucket', key: 'original', isRemote: false }]);
});

test('원격 여부가 없는 작업은 로컬 버킷에서 지운다', async () => {
	const f = fixture();
	f.jobs.push({ name: 'deleteFile', data: { key: 'legacy' } });
	await f.run();
	expect(f.s3Calls).toEqual([{ bucket: 'local-bucket', key: 'legacy', isRemote: false }]);
});
