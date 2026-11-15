/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In } from 'typeorm';
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
import {
	recordingConversionArgs, recordingConcatArgs, recordingConcatList, recordingOutputLimitBytes,
	assertRecordingInput, runRecordingFfmpeg, RecordingOutputLimitError, RecordingInputLimitError,
	type RecordingProbe,
} from '@/core/recording-conversion.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';
import { RoleService } from '@/core/RoleService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { Config } from '@/config.js';

// 녹화 원본(들)을 MP3/MP4 하나로 변환한다. 긴 녹화는 올리는 동안만 조각으로 나뉘고,
// 여기서 순서대로 이어 붙여 최종 파일 하나만 드라이브에 남긴 뒤 임시 조각은 지운다.
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
	description: 'Convert recording parts into a single file without deleting the originals until it succeeds. A null response means that no conversion was performed and the originals remain.',

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
		inputTooLarge: {
			message: 'The recording is too long or too large to convert. The original was kept.',
			code: 'INPUT_TOO_LARGE',
			id: '7c9d21e4-6a3b-4f5e-9c8d-2b1a0e3f4d56',
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
		noSuchFolder: {
			message: 'No such folder.',
			code: 'NO_SUCH_FOLDER',
			id: '94dbf480-1bb3-4aae-9dd8-c89931f5fba4',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		// 업로드 순서대로 정렬된 임시 조각 원본들. 하나로 이어 붙여 최종 파일 하나를 만든다.
		fileIds: { type: 'array', items: { type: 'string', format: 'misskey:id' }, minItems: 1, maxItems: 512 },
		// whether the saved file should keep video; defaults to whether the uploaded recording has video
		video: { type: 'boolean' },
		folderId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
	},
	required: ['fileIds'],
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
			const files = await this.driveFilesRepository.findBy({ id: In(ps.fileIds) } as any);
			const byId = new Map(files.map(f => [f.id, f]));
			const parts = ps.fileIds.map(id => byId.get(id));
			if (parts.some(f => f == null || f.userId !== me.id)) throw new ApiError(meta.errors.noSuchFile);
			const originals = parts as NonNullable<typeof parts[number]>[];
			if (originals.some(f => !f.storedInternal || f.accessKey == null)) throw new ApiError(meta.errors.conversionFailed);
			// already converted, or not a recording
			const isRecordingType = (t: string) => t.startsWith('audio/webm') || t.startsWith('audio/mp4') || t.startsWith('video/webm') || t.startsWith('video/mp4');
			if (originals.some(f => !isRecordingType(f.type))) return null;
			const isVideo = originals[0].type.startsWith('video/');
			// a recording that never had video is saved as audio only, even if the recorder captured a black canvas
			const hasVideo = ps.video ?? isVideo;
			// conversion turned off by the admin: keep the originals as they are
			const maxConversions = this.serverSettings.voiceCallMaxRecordingConversions;
			if (maxConversions <= 0) return null;
			const token = randomUUID();
			const slots = [CONVERSION_SLOTS_KEY, conversionUserKey(me.id)];
			const acquired = await this.redisClient.eval(ACQUIRE_CONVERSION_SCRIPT, 2, ...slots, token, Date.now(), CONVERSION_SLOT_TTL_MS, maxConversions);
			if (acquired !== 1) throw new ApiError(meta.errors.busy);

			let dir: string | null = null;
			let dst: string | null = null;
			let outputBytes: number | null = null;
			try {
				const srcs = originals.map(f => this.internalStorageService.resolvePath(f.accessKey!));
				// 입력 한도(스트림·길이·해상도)를 실행 전에 검사한다. 조각은 길이를 합산한다.
				const probes = await Promise.all(srcs.map(src => this.probe(src)));
				const total: RecordingProbe = {
					durationSec: probes.reduce((sum, p) => sum + p.durationSec, 0),
					width: Math.max(...probes.map(p => p.width)),
					height: Math.max(...probes.map(p => p.height)),
					hasAudio: probes.every(p => p.hasAudio),
					hasVideo: probes.some(p => p.hasVideo),
				};
				assertRecordingInput(total, hasVideo);

				const policies = await this.roleService.getUserPolicies(me.id);
				const limitBytes = recordingOutputLimitBytes(this.config.maxFileSize, policies.maxFileSizeMb);

				dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'voice-recording-'));
				dst = Path.join(dir, hasVideo ? 'recording.mp4' : 'recording.mp3');
				let args: string[];
				if (srcs.length === 1) {
					args = recordingConversionArgs(srcs[0], dst, hasVideo);
				} else {
					const listPath = Path.join(dir, 'parts.txt');
					fs.writeFileSync(listPath, recordingConcatList(srcs));
					args = recordingConcatArgs(listPath, dst, hasVideo);
				}
				await runRecordingFfmpeg(args, dst, limitBytes, CONVERSION_TIMEOUT_MS);
				outputBytes = fs.statSync(dst).size;
				if (outputBytes > limitBytes) throw new ApiError(meta.errors.outputTooLarge);
				const name = originals[0].name.replace(/\.[^.]+$/, '') + (hasVideo ? '.mp4' : '.mp3');
				const converted = await this.driveService.addFile({ user: me, path: dst, name, folderId: ps.folderId, force: true });
				// 최종 파일 하나가 저장된 뒤에만 임시 조각을 지운다. 실패하면 원본을 유지해 재시도·기기 저장·버리기가 가능하다.
				await Promise.all(originals.map(f => this.driveService.deleteFile(f, false, me).catch(error => {
					this.apiLoggerService.logger.warn(`Could not delete a recording part: ${JSON.stringify({ fileId: f.id, error: String(error) })}`);
				})));
				return await this.driveFileEntityService.pack(converted, { self: true });
			} catch (error) {
				const identifiableId = error instanceof IdentifiableError ? error.id : null;
				const policies = outputBytes != null ? await this.roleService.getUserPolicies(me.id).catch(() => null) : null;
				const failure = error as { code?: string | number; signal?: string | null; killed?: boolean; stderr?: string };
				let stderr = typeof failure?.stderr === 'string' ? failure.stderr.slice(-2048) : undefined;
				if (stderr && dst) stderr = stderr.replaceAll(dst, '[output]');
				this.apiLoggerService.logger.warn(`Recording conversion failed: ${JSON.stringify({ fileIds: ps.fileIds, inputBytes: originals.reduce((s, f) => s + f.size, 0), outputBytes, serverMaxBytes: this.config.maxFileSize, roleMaxBytes: policies ? policies.maxFileSizeMb * 1024 * 1024 : null, driveCapacityBytes: policies ? policies.driveCapacityMb * 1024 * 1024 : null, identifiableId, code: failure?.code, signal: failure?.signal, killed: failure?.killed, stderr })}`);
				if (error instanceof ApiError) throw error;
				if (error instanceof RecordingOutputLimitError) throw new ApiError(meta.errors.outputTooLarge);
				if (error instanceof RecordingInputLimitError) throw new ApiError(meta.errors.inputTooLarge);
				if (error instanceof Error && error.message === 'folder-not-found') throw new ApiError(meta.errors.noSuchFolder);
				if (identifiableId === 'f9e4e5f3-4df4-40b5-b400-f236945f7073') throw new ApiError(meta.errors.outputTooLarge);
				if (identifiableId === 'c6244ed2-a39a-4e1c-bf93-f0fbd7764fa6') throw new ApiError(meta.errors.noFreeSpace);
				throw new ApiError(meta.errors.conversionFailed);
			} finally {
				await this.redisClient.eval(RELEASE_CONVERSION_SCRIPT, 2, ...slots, token).catch(() => {});
				if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	private async probe(src: string): Promise<RecordingProbe> {
		const result = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', src], { timeout: 30_000 });
		const stdout = typeof result === 'string' ? result : result.stdout;
		const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
		const streams = parsed.streams ?? [];
		const video = streams.find(s => s.codec_type === 'video');
		// WebM 등은 format.duration 이 없을 수 있어 스트림 길이로 대체한다
		const formatDuration = parseFloat(parsed.format?.duration ?? 'NaN');
		const streamDuration = Math.max(...streams.map(s => parseFloat(s.duration ?? 'NaN')), 0);
		return {
			durationSec: Number.isFinite(formatDuration) ? formatDuration : (Number.isFinite(streamDuration) ? streamDuration : NaN),
			width: video?.width ?? 0,
			height: video?.height ?? 0,
			hasAudio: streams.some(s => s.codec_type === 'audio'),
			hasVideo: video != null,
		};
	}
}
