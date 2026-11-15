/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as Path from 'node:path';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

// 드라이브 파일 한도를 넘은 최종 녹화는 드라이브에 넣지 않고 여기 잠시 보관한다.
// 녹화한 본인만 한 번 내려받을 수 있고, 내려받거나 기한이 지나면 지운다.
export const RECORDING_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
// 변환 결과(최종 파일 또는 임시 내려받기)는 응답 유실 뒤 재시도가 찾을 수 있도록 하루 동안 기억한다.
export const RECORDING_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
// 한도 초과 녹화가 임시 보관될 수 있는 총량. 넘으면 변환을 실패시켜 원본을 남긴다.
export const RECORDING_DOWNLOAD_STORAGE_MAX_BYTES = 1024 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 1000;

const downloadKey = (id: string) => `chatVoice:recordingDownload:${id}`;
const resultKey = (userId: string, requestId: string) => `chatVoice:recordingResult:${userId}:${requestId}`;
const DOWNLOAD_PREFIX = 'chatVoice:recordingDownload:';
const RESULT_PREFIX = 'chatVoice:recordingResult:';

export type RecordingDownload = {
	id: string;
	userId: string;
	requestId: string;
	path: string;
	name: string;
	size: number;
};

export type RecordingResult = {
	fileId?: string;
	folderId?: string | null;
	download?: { id: string; name: string; size: number; reason: 'tooLarge' | 'noFreeSpace' };
	remainingParts: string[];
};

export class RecordingStorageFullError extends Error {
	constructor() {
		super('Recording download storage is full');
	}
}

@Injectable()
export class RecordingStorageService implements OnModuleInit, OnApplicationShutdown {
	private logger: Logger;
	private readonly dir: string;
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private driveService: DriveService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('recording', 'cyan');
		this.dir = Path.join(os.tmpdir(), 'cherrypick-recording-downloads');
	}

	@bindThis
	public async onModuleInit(): Promise<void> {
		fs.mkdirSync(this.dir, { recursive: true });
		// 시작할 때는 기록이 없거나 만료된 파일만 지운다. 다른 프로세스가 보관 중인 파일은
		// 기록이 살아 있으므로 남는다. 재시작 뒤 기록 없는 파일 정리도 이때 함께 이루어진다.
		await this.sweep();
		this.sweepTimer = setInterval(() => {
			this.sweep().catch(err => this.logger.warn(`Recording storage sweep failed: ${String(err)}`));
		}, SWEEP_INTERVAL_MS);
	}

	@bindThis
	public onApplicationShutdown(): void {
		if (this.sweepTimer != null) clearInterval(this.sweepTimer);
	}

	@bindThis
	public async store(userId: string, requestId: string, srcPath: string, name: string): Promise<RecordingDownload> {
		const size = fs.statSync(srcPath).size;
		const usage = await this.storageUsage();
		if (usage + size > RECORDING_DOWNLOAD_STORAGE_MAX_BYTES) throw new RecordingStorageFullError();
		const id = randomUUID();
		const path = Path.join(this.dir, id);
		fs.renameSync(srcPath, path);
		const record: RecordingDownload = { id, userId, requestId, path, name, size };
		await this.redisClient.set(downloadKey(id), JSON.stringify(record), 'PX', RECORDING_DOWNLOAD_TTL_MS);
		return record;
	}

	@bindThis
	public async getDownload(id: string): Promise<RecordingDownload | null> {
		const raw = await this.redisClient.get(downloadKey(id));
		if (raw == null) return null;
		try {
			return JSON.parse(raw) as RecordingDownload;
		} catch {
			return null;
		}
	}

	@bindThis
	public async removeDownload(id: string): Promise<void> {
		const record = await this.getDownload(id);
		await this.redisClient.del(downloadKey(id));
		if (record != null) {
			this.unlink(record.path);
			const result = await this.getResult(record.userId, record.requestId);
			if (result != null) {
				if (result.remainingParts.length > 0) {
					// 남은 조각 정리가 이어지도록 내려받기 정보만 지운다
					await this.setResult(record.userId, record.requestId, { ...result, download: undefined });
				} else {
					await this.clearResult(record.userId, record.requestId);
				}
			}
		}
	}

	@bindThis
	public async getResult(userId: string, requestId: string): Promise<RecordingResult | null> {
		const raw = await this.redisClient.get(resultKey(userId, requestId));
		if (raw == null) return null;
		try {
			return JSON.parse(raw) as RecordingResult;
		} catch {
			return null;
		}
	}

	@bindThis
	public async setResult(userId: string, requestId: string, result: RecordingResult): Promise<void> {
		await this.redisClient.set(resultKey(userId, requestId), JSON.stringify(result), 'PX', RECORDING_RESULT_TTL_MS);
	}

	@bindThis
	public async clearResult(userId: string, requestId: string): Promise<void> {
		await this.redisClient.del(resultKey(userId, requestId));
	}

	/** 남아 있는 임시 조각을 다시 지운다. 성공한 조각은 기록에서 뺀다. */
	@bindThis
	public async retryPartCleanup(userId: string, requestId: string, result: RecordingResult): Promise<void> {
		if (result.remainingParts.length === 0) return;
		const left: string[] = [];
		for (const fileId of result.remainingParts) {
			const file = await this.driveFilesRepository.findOneBy({ id: fileId, userId });
			if (file == null) continue;
			try {
				await this.driveService.deleteFile(file, false, { id: userId } as any);
			} catch (err) {
				this.logger.warn(`Could not delete a leftover recording part: ${JSON.stringify({ fileId, error: String(err) })}`);
				left.push(fileId);
			}
		}
		await this.setResult(userId, requestId, { ...result, remainingParts: left });
	}

	@bindThis
	private async storageUsage(): Promise<number> {
		let usage = 0;
		for await (const key of this.scanKeys(DOWNLOAD_PREFIX)) {
			const raw = await this.redisClient.get(key);
			if (raw == null) continue;
			try {
				usage += (JSON.parse(raw) as RecordingDownload).size;
			} catch { /* ignore malformed */ }
		}
		return usage;
	}

	@bindThis
	private async sweep(): Promise<void> {
		// 기록이 만료된 임시 파일은 지운다
		const live = new Set<string>();
		for await (const key of this.scanKeys(DOWNLOAD_PREFIX)) {
			const raw = await this.redisClient.get(key);
			if (raw == null) continue;
			try {
				live.add((JSON.parse(raw) as RecordingDownload).path);
			} catch { /* ignore malformed */ }
		}
		for (const entry of fs.readdirSync(this.dir)) {
			const path = Path.join(this.dir, entry);
			if (!live.has(path)) this.unlink(path);
		}
		// 결과 기록 중 임시 내려받기가 사라졌거나 남은 조각이 있는 것을 정리한다
		for await (const key of this.scanKeys(RESULT_PREFIX)) {
			const raw = await this.redisClient.get(key);
			if (raw == null) continue;
			let result: RecordingResult;
			try {
				result = JSON.parse(raw) as RecordingResult;
			} catch {
				continue;
			}
			const userId = key.slice(RESULT_PREFIX.length).split(':')[0];
			const requestId = key.slice(RESULT_PREFIX.length + userId.length + 1);
			if (result.download != null && (await this.getDownload(result.download.id)) == null) {
				if (result.remainingParts.length === 0) {
					await this.redisClient.del(key);
					continue;
				}
				// 내려받기가 만료됐어도 남은 조각 정리는 계속한다
				result = { ...result, download: undefined };
				await this.setResult(userId, requestId, result);
			}
			if (result.remainingParts.length > 0) {
				await this.retryPartCleanup(userId, requestId, result);
			}
		}
	}

	@bindThis
	private unlink(path: string): void {
		try {
			fs.unlinkSync(path);
		} catch { /* already gone */ }
	}

	private async *scanKeys(prefix: string): AsyncGenerator<string> {
		// SCAN의 MATCH에는 ioredis의 keyPrefix가 자동으로 붙지 않으므로 직접 붙이고,
		// 돌려받은 키는 이후 GET/DEL에서 prefix가 다시 붙지 않도록 논리 키로 돌린다.
		// https://github.com/redis/ioredis#transparent-key-prefixing
		const keyPrefix = this.redisClient.options.keyPrefix ?? '';
		let cursor = '0';
		do {
			const [next, keys] = await this.redisClient.scan(cursor, 'MATCH', `${keyPrefix}${prefix}*`, 'COUNT', 500);
			cursor = next;
			for (const key of keys) yield key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;
		} while (cursor !== '0');
	}
}
