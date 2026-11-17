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
import type { MiLocalUser } from '@/models/User.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { DownloadService } from '@/core/DownloadService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { RecordingStorageService, RecordingStorageFullError, RECORDING_DOWNLOAD_STORAGE_MAX_BYTES, type RecordingResult } from '@/core/RecordingStorageService.js';
import { ApiError } from '@/server/api/error.js';
import type { Packed } from '@/misc/json-schema.js';
import {
	recordingConversionArgs, recordingConcatArgs, recordingConcatList, recordingOutputLimitBytes,
	recordingConversionTimeoutMs, RECORDING_CONVERSION_MAX_TIMEOUT_MS,
	assertRecordingInput, runRecordingFfmpeg, RecordingOutputLimitError, RecordingInputLimitError,
	type RecordingProbe,
} from '@/core/recording-conversion.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';
import { RoleService } from '@/core/RoleService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { Config } from '@/config.js';

// 녹화 원본(들)을 MP3/MP4 하나로 변환한다. 긴 녹화는 올리는 동안만 조각으로 나뉘고,
// 여기서 순서대로 이어 붙여 최종 파일 하나만 드라이브에 남긴 뒤 임시 조각은 지운다.
// 드라이브 파일 한도를 넘으면 드라이브에 넣지 않고 잠시 보관해 본인만 한 번 내려받게 한다.
const execFileAsync = promisify(execFile);

// 조각 검사(ffprobe)는 변환 슬롯 안에서 작은 상한으로만 동시에 실행한다.
const PROBE_CONCURRENCY = 4;
// ffmpeg is expensive: the control panel sets how many conversions may run at once on the whole server (voiceCallMaxRecordingConversions).
// The API can run in several processes, so the slots live in Redis rather than in this process's memory.
// Each slot expires a little after the ffmpeg timeout, so a slot held by a process that died is given back.
const CONVERSION_SLOT_MARGIN_MS = 60 * 1000;
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

// After the probes the real timeout is known: tighten the already-acquired slot and user lock
// to it so a dead process is reclaimed quickly. No new keys; the sorted set's lifetime follows
// its latest slot so another running conversion's slot is never shortened.
// KEYS[1]: the slots, KEYS[2]: the user's lock. ARGV: token, now, ttl. Returns 0 if the slot is already gone
const REFRESH_CONVERSION_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]) + tonumber(ARGV[3]), ARGV[1])
local maxScore = tonumber(redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2])
redis.call('PEXPIRE', KEYS[1], maxScore - tonumber(ARGV[2]))
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
return 1
`;

export const meta = {
	tags: ['chat'],
	description: 'Convert recording parts into a single file without deleting the originals until it succeeds. Each id is either an uploaded drive file or a part kept in the temporary recording storage, in recording order. A null response means that no conversion was performed and the originals remain. A download response means the file exceeds the drive file size limit and is kept for a one-time download instead. Repeating the same requestId returns the earlier result, so a lost response can be recovered.',

	requireCredential: true,

	kind: 'write:drive',

	limit: {
		duration: 60_000,
		max: 10,
	},

	res: {
		type: 'object',
		optional: false, nullable: true,
		properties: {
			file: {
				type: 'object',
				optional: false, nullable: true,
				ref: 'DriveFile',
			},
			download: {
				type: 'object',
				optional: false, nullable: true,
				properties: {
					id: { type: 'string', optional: false, nullable: false },
					name: { type: 'string', optional: false, nullable: false },
					size: { type: 'number', optional: false, nullable: false },
					reason: { type: 'string', optional: false, nullable: false, enum: ['tooLarge', 'noFreeSpace'] },
				},
			},
		},
	},

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: '9dece6fd-b314-408e-98ef-daa64f0fed82',
		},
		duplicateFile: {
			message: 'The same file was included more than once.',
			code: 'DUPLICATE_FILE',
			id: 'a6599854-123b-4ca9-940c-41e0774b971f',
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
		// 업로드 순서대로 정렬된 조각들. 드라이브 파일 id와 임시 보관 조각 id를 순서대로 섞어 넣는다.
		// 하나로 이어 붙여 최종 파일 하나를 만든다.
		fileIds: { type: 'array', items: { type: 'string', format: 'misskey:id' }, minItems: 1, maxItems: 512 },
		// 같은 녹화의 재시도는 같은 requestId를 쓴다. 응답을 잃어도 서버가 이전 결과를 돌려준다.
		requestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
		// whether the saved file should keep video; defaults to whether the uploaded recording has video
		video: { type: 'boolean' },
		folderId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
	},
	required: ['fileIds', 'requestId'],
} as const;

type ConversionResponse = {
	file: Packed<'DriveFile'> | null;
	download: { id: string; name: string; size: number; reason: 'tooLarge' | 'noFreeSpace' } | null;
};

// 변환 입력 조각. 드라이브에 올라간 파일이거나, 드라이브에 못 올라가 임시 보관에 있는 조각이다.
type ConversionSource = {
	path: string;
	type: string;
	name: string;
	size: number;
	driveFile: MiDriveFile | null;
	partId: string | null;
	// 오브젝트 스토리지에 있는 조각은 변환 전에 서버 임시 폴더로 받아 온다.
	remoteUrl: string | null;
};

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
		private recordingStorage: RecordingStorageService,
		private roleService: RoleService,
		private apiLoggerService: ApiLoggerService,
		private downloadService: DownloadService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// 응답 유실 뒤 같은 요청이 오면 이미 만든 결과를 돌려준다. 조각은 이미 지워졌을 수 있다.
			const remembered = await this.recordingStorage.getResult(me.id, ps.requestId);
			if (remembered != null) {
				const reused = await this.reuseResult(me, ps.requestId, remembered, ps.folderId);
				if (reused != null) return reused;
			}

			if (new Set(ps.fileIds).size !== ps.fileIds.length) throw new ApiError(meta.errors.duplicateFile);
			const files = await this.driveFilesRepository.findBy({ id: In(ps.fileIds) } as any);
			const byId = new Map(files.map(f => [f.id, f]));
			const sources: ConversionSource[] = [];
			for (const id of ps.fileIds) {
				const file = byId.get(id);
				if (file != null) {
					if (file.userId !== me.id) throw new ApiError(meta.errors.noSuchFile);
					if (file.storedInternal && file.accessKey != null) {
						sources.push({ path: this.internalStorageService.resolvePath(file.accessKey), type: file.type, name: file.name, size: file.size, driveFile: file, partId: null, remoteUrl: null });
					} else if (file.url) {
						sources.push({ path: '', type: file.type, name: file.name, size: file.size, driveFile: file, partId: null, remoteUrl: file.url });
					} else {
						throw new ApiError(meta.errors.conversionFailed);
					}
				} else {
					// 드라이브에 올리지 못했던 조각은 녹화 전용 임시 보관에서 찾는다.
					const part = await this.recordingStorage.getPart(id);
					if (part == null || part.userId !== me.id || !fs.existsSync(part.path)) throw new ApiError(meta.errors.noSuchFile);
					sources.push({ path: part.path, type: part.type, name: part.name, size: part.size, driveFile: null, partId: id, remoteUrl: null });
				}
			}
			// already converted, or not a recording
			const isRecordingType = (t: string) => t.startsWith('audio/webm') || t.startsWith('audio/mp4') || t.startsWith('video/webm') || t.startsWith('video/mp4');
			if (sources.some(s => !isRecordingType(s.type))) return null;
			const isVideo = sources[0].type.startsWith('video/');
			// a recording that never had video is saved as audio only, even if the recorder captured a black canvas
			const hasVideo = ps.video ?? isVideo;
			// 동시 변환 수 설정이 0으로 저장되어 있어도 최종 파일 하나는 만든다. 최소 1로 취급한다.
			const maxConversions = Math.max(1, this.serverSettings.voiceCallMaxRecordingConversions);

			let srcs = sources.map(s => s.path);

			const token = randomUUID();
			const slots = [CONVERSION_SLOTS_KEY, conversionUserKey(me.id)];
			// 슬롯은 finally에서 반드시 반환하므로, TTL은 죽은 프로세스의 슬롯 회수용이다.
			// probe 전에는 실제 상한을 모르므로 최대 시간으로 잡고, probe 뒤 실제 상한으로 줄인다.
			const acquired = await this.redisClient.eval(ACQUIRE_CONVERSION_SCRIPT, 2, ...slots, token, Date.now(), RECORDING_CONVERSION_MAX_TIMEOUT_MS + CONVERSION_SLOT_MARGIN_MS, maxConversions);
			if (acquired !== 1) throw new ApiError(meta.errors.busy);

			let dir: string | null = null;
			let dst: string | null = null;
			let outputBytes: number | null = null;
			try {
				const policies = await this.roleService.getUserPolicies(me.id);
				const limitBytes = recordingOutputLimitBytes(this.config.maxFileSize, policies.maxFileSizeMb);
				// 한도 초과 녹화는 임시 보관으로 이어질 수 있으므로, 드라이브에 들어가지 않는 출력은
				// 보관 총량 상한에서 멈춘다. 보관 상한을 넘는 출력은 끝까지 인코딩해도 보관할 수 없다.
				const outputCapBytes = Math.max(limitBytes, RECORDING_DOWNLOAD_STORAGE_MAX_BYTES);

				dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'voice-recording-'));
				// 오브젝트 스토리지의 조각은 서버 임시 폴더로 받는다. 임시 폴더는 끝날 때 통째로 지운다.
				for (const [index, source] of sources.filter(s => s.remoteUrl != null).entries()) {
					const partPath = Path.join(dir, `part-${index}`);
					await this.downloadService.downloadUrl(source.remoteUrl!, partPath);
					source.path = partPath;
				}
				srcs = sources.map(s => s.path);

				// 입력 한도(스트림·길이·해상도)를 실행 전에 검사한다. 조각은 길이를 합산한다.
				const probes = await this.probeAll(srcs);
				const total: RecordingProbe = {
					durationSec: probes.reduce((sum, p) => sum + p.durationSec, 0),
					width: Math.max(...probes.map(p => p.width)),
					height: Math.max(...probes.map(p => p.height)),
					hasAudio: probes.every(p => p.hasAudio),
					hasVideo: probes.some(p => p.hasVideo),
				};
				assertRecordingInput(total, hasVideo);

				const timeoutMs = recordingConversionTimeoutMs(total.durationSec, hasVideo);
				await this.redisClient.eval(REFRESH_CONVERSION_SCRIPT, 2, ...slots, token, Date.now(), timeoutMs + CONVERSION_SLOT_MARGIN_MS);

				dst = Path.join(dir, hasVideo ? 'recording.mp4' : 'recording.mp3');
				let args: string[];
				if (srcs.length === 1) {
					args = recordingConversionArgs(srcs[0], dst, hasVideo);
				} else {
					const listPath = Path.join(dir, 'parts.txt');
					fs.writeFileSync(listPath, recordingConcatList(srcs));
					args = recordingConcatArgs(listPath, dst, hasVideo);
				}
				await runRecordingFfmpeg(args, dst, outputCapBytes, timeoutMs);
				outputBytes = fs.statSync(dst).size;
				const name = sources[0].name.replace(/\.[^.]+$/, '') + (hasVideo ? '.mp4' : '.mp3');
				if (outputBytes > limitBytes) {
					return await this.keepForDownload(me, ps.requestId, dst, name, sources, 'tooLarge');
				}
				let converted;
				try {
					converted = await this.driveService.addFile({ user: me, path: dst, name, folderId: ps.folderId, force: true });
				} catch (error) {
					const identifiableId = error instanceof IdentifiableError ? error.id : null;
					// 파일 한도·용량 초과도 최종 파일은 만들어졌으므로 임시 보관으로 돌려준다.
					if (identifiableId === 'f9e4e5f3-4df4-40b5-b400-f236945f7073') {
						return await this.keepForDownload(me, ps.requestId, dst, name, sources, 'tooLarge');
					}
					if (identifiableId === 'c6244ed2-a39a-4e1c-bf93-f0fbd7764fa6') {
						return await this.keepForDownload(me, ps.requestId, dst, name, sources, 'noFreeSpace');
					}
					throw error;
				}
				// 최종 파일 하나가 저장된 뒤에만 임시 조각을 지운다. 실패하면 원본을 유지해 재시도·기기 저장·버리기가 가능하다.
				await this.recordingStorage.setResult(me.id, ps.requestId, { fileId: converted.id, folderId: converted.folderId, remainingParts: sources.filter(s => s.driveFile != null).map(s => s.driveFile!.id) });
				await this.deleteParts(me, ps.requestId, sources);
				return { file: await this.driveFileEntityService.pack(converted, { self: true }), download: null };
			} catch (error) {
				const identifiableId = error instanceof IdentifiableError ? error.id : null;
				const policies = outputBytes != null ? await this.roleService.getUserPolicies(me.id).catch(() => null) : null;
				const failure = error as { code?: string | number; signal?: string | null; killed?: boolean; stderr?: string };
				let stderr = typeof failure?.stderr === 'string' ? failure.stderr.slice(-2048) : undefined;
				if (stderr) {
					if (dst) stderr = stderr.replaceAll(dst, '[output]');
					for (const src of srcs) stderr = stderr.replaceAll(src, '[input]');
				}
				this.apiLoggerService.logger.warn(`Recording conversion failed: ${JSON.stringify({ fileIds: ps.fileIds, inputBytes: sources.reduce((s, x) => s + x.size, 0), outputBytes, serverMaxBytes: this.config.maxFileSize, roleMaxBytes: policies ? policies.maxFileSizeMb * 1024 * 1024 : null, driveCapacityBytes: policies ? policies.driveCapacityMb * 1024 * 1024 : null, identifiableId, code: failure?.code, signal: failure?.signal, killed: failure?.killed, stderr })}`);
				if (error instanceof ApiError) throw error;
				if (error instanceof RecordingOutputLimitError) throw new ApiError(meta.errors.outputTooLarge);
				if (error instanceof RecordingInputLimitError) throw new ApiError(meta.errors.inputTooLarge);
				if (error instanceof Error && error.message === 'folder-not-found') throw new ApiError(meta.errors.noSuchFolder);
				throw new ApiError(meta.errors.conversionFailed);
			} finally {
				await this.redisClient.eval(RELEASE_CONVERSION_SCRIPT, 2, ...slots, token).catch(() => {});
				if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	/** 이전에 만든 결과를 돌려준다. 최종 파일이나 임시 보관이 사라졌으면 새로 변환하게 하되, 남은 조각 정리 기록은 유지한다. */
	private async reuseResult(me: MiLocalUser, requestId: string, result: RecordingResult, folderId: string | null): Promise<ConversionResponse | null> {
		if (result.fileId != null) {
			const file = await this.driveFilesRepository.findOneBy({ id: result.fileId, userId: me.id });
			if (file != null) {
				await this.recordingStorage.retryPartCleanup(me.id, requestId, result);
				return { file: await this.driveFileEntityService.pack(file, { self: true }), download: null };
			}
		} else if (result.download != null) {
			const download = await this.recordingStorage.getDownload(result.download.id);
			if (download != null && download.userId === me.id && fs.existsSync(download.path)) {
				// 한도를 되돌렸거나 용량을 확보했을 수 있으니 보관한 최종 파일을 드라이브에 다시 저장해 본다.
				let reason = result.download.reason;
				const policies = await this.roleService.getUserPolicies(me.id);
				if (download.size > recordingOutputLimitBytes(this.config.maxFileSize, policies.maxFileSizeMb)) {
					return { file: null, download: { id: download.id, name: download.name, size: download.size, reason: 'tooLarge' } };
				}
				let converted;
				try {
					converted = await this.driveService.addFile({ user: me, path: download.path, name: download.name, folderId, force: true });
				} catch (error) {
					const identifiableId = error instanceof IdentifiableError ? error.id : null;
					if (identifiableId === 'f9e4e5f3-4df4-40b5-b400-f236945f7073') reason = 'tooLarge';
					else if (identifiableId === 'c6244ed2-a39a-4e1c-bf93-f0fbd7764fa6') reason = 'noFreeSpace';
					else if (error instanceof Error && error.message === 'folder-not-found') throw new ApiError(meta.errors.noSuchFolder);
					else {
						this.apiLoggerService.logger.warn(`Could not save a kept recording: ${JSON.stringify({ downloadId: download.id, identifiableId, error: String(error) })}`);
						throw new ApiError(meta.errors.conversionFailed);
					}
				}
				if (converted != null) {
					await this.recordingStorage.removeDownload(download.id);
					await this.recordingStorage.setResult(me.id, requestId, { fileId: converted.id, folderId: converted.folderId, remainingParts: result.remainingParts });
					return { file: await this.driveFileEntityService.pack(converted, { self: true }), download: null };
				}
				return { file: null, download: { id: download.id, name: download.name, size: download.size, reason } };
			}
		}
		if (result.remainingParts.length > 0) {
			// 최종 파일·내려받기가 사라졌어도 남은 조각 정리가 이어지도록 기록을 유지한다
			const kept: RecordingResult = { ...result, fileId: undefined, download: undefined };
			await this.recordingStorage.setResult(me.id, requestId, kept);
			await this.recordingStorage.retryPartCleanup(me.id, requestId, kept);
			return null;
		}
		await this.recordingStorage.clearResult(me.id, requestId);
		return null;
	}

	/** 드라이브에 넣을 수 없는 최종 파일을 임시 보관하고, 본인만 한 번 내려받을 수 있게 한다. */
	private async keepForDownload(me: MiLocalUser, requestId: string, dst: string, name: string, sources: ConversionSource[], reason: 'tooLarge' | 'noFreeSpace'): Promise<ConversionResponse> {
		let record;
		try {
			record = await this.recordingStorage.store(me.id, requestId, dst, name);
		} catch (error) {
			if (error instanceof RecordingStorageFullError) throw new ApiError(meta.errors.outputTooLarge);
			throw error;
		}
		const download = { id: record.id, name: record.name, size: record.size, reason };
		await this.recordingStorage.setResult(me.id, requestId, { download, remainingParts: sources.filter(s => s.driveFile != null).map(s => s.driveFile!.id) });
		await this.deleteParts(me, requestId, sources);
		return { file: null, download };
	}

	/** 임시 조각을 지우고, 실패한 드라이브 조각은 결과 기록에 남겨 이후 정리(재시도·주기 정리)가 이어받게 한다. */
	private async deleteParts(me: MiLocalUser, requestId: string, sources: ConversionSource[]): Promise<void> {
		const left: string[] = [];
		await Promise.all(sources.map(async s => {
			if (s.driveFile != null) {
				try {
					await this.driveService.deleteFile(s.driveFile, false, me);
				} catch (error) {
					this.apiLoggerService.logger.warn(`Could not delete a recording part: ${JSON.stringify({ fileId: s.driveFile.id, error: String(error) })}`);
					left.push(s.driveFile.id);
				}
			} else if (s.partId != null) {
				// 임시 보관 조각은 기록과 파일을 바로 지운다. 지우지 못해도 기한 만료 뒤 주기 정리가 거둔다.
				await this.recordingStorage.removePart(s.partId).catch(error => {
					this.apiLoggerService.logger.warn(`Could not delete a kept recording part: ${JSON.stringify({ partId: s.partId, error: String(error) })}`);
				});
			}
		}));
		const result = await this.recordingStorage.getResult(me.id, requestId);
		if (result != null) await this.recordingStorage.setResult(me.id, requestId, { ...result, remainingParts: left });
	}

	/** ffprobe를 작은 상한으로만 동시에 실행한다. 하나가 실패하면 나머지를 시작하지 않고, 실행 중인 것은 끝까지 기다린다. */
	private async probeAll(srcs: string[]): Promise<RecordingProbe[]> {
		const results: RecordingProbe[] = new Array(srcs.length);
		let next = 0;
		let failure: unknown = null;
		const worker = async (): Promise<void> => {
			while (failure == null) {
				const index = next++;
				if (index >= srcs.length) return;
				try {
					results[index] = await this.probe(srcs[index]);
				} catch (error) {
					failure = error;
					return;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, srcs.length) }, () => worker()));
		if (failure != null) throw failure;
		return results;
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
