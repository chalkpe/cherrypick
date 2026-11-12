/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as Path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, MiMeta } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { ApiError } from '@/server/api/error.js';

// Turns a recorded voice call (WebM) into MP3, or MP4 when it has video, which players handle more widely
const execFileAsync = promisify(execFile);

// Recordings are uploaded in 100 MB chunks, so anything much larger is not one of ours
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 10 * 60 * 1000;
// ffmpeg is expensive: the control panel sets how many conversions may run at once on the whole server (voiceCallMaxRecordingConversions; 0 turns conversion off).
// The API can run in several processes, so the slots live in Redis rather than in this process's memory.
// Each slot expires a little after the ffmpeg timeout, so a slot held by a process that died is given back.
const CONVERSION_SLOT_TTL_MS = CONVERSION_TIMEOUT_MS + 60 * 1000;
const CONVERSION_SLOTS_KEY = 'chatVoice:recordingConversions';
// one conversion per user at a time, so a single user cannot hold every slot
const conversionUserKey = (userId: string) => `chatVoice:recordingConversion:${userId}`;

// KEYS[1]: the slots (sorted set of token -> expiry), KEYS[2]: the user's lock
// ARGV: token, now, ttl, max. Returns 1 when a slot was taken, 0 when every slot or the user's lock is in use
const ACQUIRE_CONVERSION_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]) + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[3])
return 1
`;

// Give back only what this conversion took: the user's lock may already belong to a later conversion after it expired
const RELEASE_CONVERSION_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
`;

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
		tooLarge: {
			message: 'The file is too large to convert.',
			code: 'TOO_LARGE',
			id: '5f0f4f3e-6f2b-4c2e-9d36-0d3c4bd0e2a1',
		},
		busy: {
			message: 'Too many recordings are being converted. Try again later.',
			code: 'BUSY',
			id: 'b9a7e2c4-31d8-4f0a-8b6e-7c2d9e5f1a03',
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
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

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
			// conversion turned off by the admin: keep the WebM as it is
			const maxConversions = this.serverSettings.voiceCallMaxRecordingConversions;
			if (maxConversions <= 0) return null;
			if (file.size > MAX_SOURCE_BYTES) throw new ApiError(meta.errors.tooLarge);
			const token = randomUUID();
			const slots = [CONVERSION_SLOTS_KEY, conversionUserKey(me.id)];
			const acquired = await this.redisClient.eval(ACQUIRE_CONVERSION_SCRIPT, 2, ...slots, token, Date.now(), CONVERSION_SLOT_TTL_MS, maxConversions);
			if (acquired !== 1) throw new ApiError(meta.errors.busy);

			let dir: string | null = null;
			try {
				const src = this.internalStorageService.resolvePath(file.accessKey);
				dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'voice-recording-'));
				const dst = Path.join(dir, isVideo ? 'recording.mp4' : 'recording.mp3');
				await execFileAsync('ffmpeg', isVideo
					? ['-y', '-threads', '2', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-af', 'alimiter=limit=0.95', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', dst]
					: ['-y', '-threads', '2', '-i', src, '-vn', '-af', 'alimiter=limit=0.95', '-c:a', 'libmp3lame', '-b:a', '320k', dst], { timeout: CONVERSION_TIMEOUT_MS });
				const name = file.name.replace(/\.[^.]+$/, '') + (isVideo ? '.mp4' : '.mp3');
				const converted = await this.driveService.addFile({ user: me, path: dst, name, force: true });
				await this.driveService.deleteFile(file, false, me);
				return await this.driveFileEntityService.pack(converted, { self: true });
			} catch {
				throw new ApiError(meta.errors.conversionFailed);
			} finally {
				await this.redisClient.eval(RELEASE_CONVERSION_SCRIPT, 2, ...slots, token).catch(() => {});
				if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
}
