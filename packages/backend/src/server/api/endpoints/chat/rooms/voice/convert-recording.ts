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
import { recordingConversionArgs } from '@/core/recording-conversion.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';
import { RoleService } from '@/core/RoleService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { Config } from '@/config.js';

// Turns a recorded voice call (WebM) into MP3, or MP4 when it has video, which players handle more widely
const execFileAsync = promisify(execFile);

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
	description: 'Convert a recording without deleting the original. A null response means that no conversion was performed and the original remains.',

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
		busy: {
			message: 'Too many recordings are being converted. Try again later.',
			code: 'BUSY',
			id: 'b9a7e2c4-31d8-4f0a-8b6e-7c2d9e5f1a03',
		},
		outputTooLarge: {
			message: 'The converted file exceeds the maximum file size. The original was kept.',
			code: 'OUTPUT_TOO_LARGE',
			id: '5150ba37-9451-4e36-bc67-d190715935b4',
		},
		noFreeSpace: {
			message: 'There is not enough drive space for the converted file. The original was kept.',
			code: 'NO_FREE_SPACE',
			id: '3bbe49fe-1726-4211-96ad-788b76b89427',
		},
		conversionFailed: {
			message: 'Could not convert the recording. The original was kept.',
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
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private driveService: DriveService,
		private internalStorageService: InternalStorageService,
		private driveFileEntityService: DriveFileEntityService,
		private roleService: RoleService,
		private apiLoggerService: ApiLoggerService,
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
			const token = randomUUID();
			const slots = [CONVERSION_SLOTS_KEY, conversionUserKey(me.id)];
			const acquired = await this.redisClient.eval(ACQUIRE_CONVERSION_SCRIPT, 2, ...slots, token, Date.now(), CONVERSION_SLOT_TTL_MS, maxConversions);
			if (acquired !== 1) throw new ApiError(meta.errors.busy);

			let dir: string | null = null;
			let src: string | null = null;
			let dst: string | null = null;
			let outputBytes: number | null = null;
			try {
				src = this.internalStorageService.resolvePath(file.accessKey);
				dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'voice-recording-'));
				dst = Path.join(dir, isVideo ? 'recording.mp4' : 'recording.mp3');
				await execFileAsync('ffmpeg', recordingConversionArgs(src, dst, isVideo), { timeout: CONVERSION_TIMEOUT_MS });
				outputBytes = fs.statSync(dst).size;
				if (outputBytes > this.config.maxFileSize) throw new ApiError(meta.errors.outputTooLarge);
				const name = file.name.replace(/\.[^.]+$/, '') + (isVideo ? '.mp4' : '.mp3');
				const converted = await this.driveService.addFile({ user: me, path: dst, name, force: true });
				return await this.driveFileEntityService.pack(converted, { self: true });
			} catch (error) {
				const identifiableId = error instanceof IdentifiableError ? error.id : null;
				const policies = outputBytes != null ? await this.roleService.getUserPolicies(me.id).catch(() => null) : null;
				const failure = error as { code?: string | number; signal?: string | null; killed?: boolean; stderr?: string };
				let stderr = typeof failure?.stderr === 'string' ? failure.stderr.slice(-2048) : undefined;
				if (stderr && src) stderr = stderr.replaceAll(src, '[source]');
				if (stderr && dst) stderr = stderr.replaceAll(dst, '[output]');
				this.apiLoggerService.logger.warn(`Recording conversion failed: ${JSON.stringify({ fileId: file.id, inputBytes: file.size, outputBytes, serverMaxBytes: this.config.maxFileSize, roleMaxBytes: policies ? policies.maxFileSizeMb * 1024 * 1024 : null, driveCapacityBytes: policies ? policies.driveCapacityMb * 1024 * 1024 : null, identifiableId, code: failure?.code, signal: failure?.signal, killed: failure?.killed, stderr })}`);
				if (error instanceof ApiError) throw error;
				if (identifiableId === 'f9e4e5f3-4df4-40b5-b400-f236945f7073') throw new ApiError(meta.errors.outputTooLarge);
				if (identifiableId === 'c6244ed2-a39a-4e1c-bf93-f0fbd7764fa6') throw new ApiError(meta.errors.noFreeSpace);
				throw new ApiError(meta.errors.conversionFailed);
			} finally {
				await this.redisClient.eval(RELEASE_CONVERSION_SCRIPT, 2, ...slots, token).catch(() => {});
				if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
}
