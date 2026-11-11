/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as Path from 'node:path';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { ApiError } from '@/server/api/error.js';

// Turns a recorded voice call (WebM) into MP3, or MP4 when it has video, which players handle more widely
const execFileAsync = promisify(execFile);

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:drive',

	limit: {
		duration: 60_000,
		max: 10,
	},

	res: {
		type: 'object',
		optional: false, nullable: true,
		ref: 'DriveFile',
	},

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: '9dece6fd-b314-408e-98ef-daa64f0fed82',
		},
		conversionFailed: {
			message: 'Could not convert the recording.',
			code: 'CONVERSION_FAILED',
			id: 'febe7309-ae3e-47d1-bae1-d393ec0bb877',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
	},
	required: ['fileId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private driveService: DriveService,
		private internalStorageService: InternalStorageService,
		private driveFileEntityService: DriveFileEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const file = await this.driveFilesRepository.findOneBy({ id: ps.fileId });
			if (file == null || file.userId !== me.id) throw new ApiError(meta.errors.noSuchFile);
			if (!file.storedInternal || file.accessKey == null) throw new ApiError(meta.errors.conversionFailed);
			// already converted, or not a recording
			const isAudio = file.type.startsWith('audio/webm');
			const isVideo = file.type.startsWith('video/webm');
			if (!isAudio && !isVideo) return null;

			const src = this.internalStorageService.resolvePath(file.accessKey);
			const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'voice-recording-'));
			const dst = Path.join(dir, isVideo ? 'recording.mp4' : 'recording.mp3');

			try {
				await execFileAsync('ffmpeg', isVideo
					? ['-y', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-af', 'alimiter=limit=0.95', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', dst]
					: ['-y', '-i', src, '-vn', '-af', 'alimiter=limit=0.95', '-c:a', 'libmp3lame', '-b:a', '320k', dst], { timeout: 30 * 60 * 1000 });
				const name = file.name.replace(/\.[^.]+$/, '') + (isVideo ? '.mp4' : '.mp3');
				const converted = await this.driveService.addFile({ user: me, path: dst, name, force: true });
				await this.driveService.deleteFile(file, false, me);
				return await this.driveFileEntityService.pack(converted, { self: true });
			} catch {
				throw new ApiError(meta.errors.conversionFailed);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
}
