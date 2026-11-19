/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as Path from 'node:path';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

// 드라이브 파일 한도를 넘은 최종 녹화는 드라이브에 넣지 않고 여기 잠시 보관한다.
// 녹화한 본인만 한 번 내려받을 수 있고, 내려받거나 기한이 지나면 지운다.
// 드라이브에 올리지 못한 녹화 조각도 같은 상한·기한으로 여기 보관했다가 변환에 쓴다.
export const RECORDING_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
// 변환 결과(최종 파일 또는 임시 내려받기)는 응답 유실 뒤 재시도가 찾을 수 있도록 하루 동안 기억한다.
export const RECORDING_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
// 한도 초과 녹화가 임시 보관될 수 있는 총량. 넘으면 변환을 실패시켜 원본을 남긴다.
export const RECORDING_DOWNLOAD_STORAGE_MAX_BYTES = 1024 * 1024 * 1024;
// 한 사용자가 임시 보관에 둘 수 있는 항목(최종 파일과 조각) 수. 정상 녹화는 조각이 총량 상한 안에서 만들어지므로 여기에 닿지 않는다.
export const RECORDING_DOWNLOAD_USER_MAX_ENTRIES = 4096;
const SWEEP_INTERVAL_MS = 60 * 1000;

const downloadKey = (id: string) => `chatVoice:recordingDownload:${id}`;
const partKey = (id: string) => `chatVoice:recordingPart:${id}`;
// 保管中の録画の索引。ENTRIES: id → `userId|size|expiresAt|reservedAt`、TOTAL: 合計の大きさ、USERS: userId → 項目数、EXPIRY: 期限順の id。
// 総量の検査と予約を Redis の中で一度に行い、予約のたびに全項目を数え直さないための集計。
// 索引ができたことを示す印 (SEEDED_KEY) が無いときは、先に保存済みの録画を取り込む。
const ENTRIES_KEY = 'chatVoice:recordingIndex:entries';
const TOTAL_KEY = 'chatVoice:recordingIndex:total';
const USERS_KEY = 'chatVoice:recordingIndex:users';
const EXPIRY_KEY = 'chatVoice:recordingIndex:expiry';
const SEEDED_KEY = 'chatVoice:recordingIndex:seeded';
const INDEX_KEYS = [ENTRIES_KEY, TOTAL_KEY, USERS_KEY, EXPIRY_KEY, SEEDED_KEY];
// 記録 (録画の保存) が書かれる前の予約は、これだけ経っても記録が無ければ sweep で捨てる
const ORPHAN_RESERVATION_MS = 5 * 60 * 1000;
const resultKey = (userId: string, requestId: string) => `chatVoice:recordingResult:${userId}:${requestId}`;
const DOWNLOAD_PREFIX = 'chatVoice:recordingDownload:';
const PART_PREFIX = 'chatVoice:recordingPart:';
const RESULT_PREFIX = 'chatVoice:recordingResult:';

export type RecordingDownload = {
	id: string;
	userId: string;
	requestId: string;
	path: string;
	name: string;
	size: number;
};

// 드라이브에 올리지 못한 녹화 조각. 변환가 이미 올라간 조각과 이어 붙여 최종 파일 하나를 만든다.
export type RecordingPart = {
	id: string;
	userId: string;
	path: string;
	name: string;
	size: number;
	type: string;
};

export type RecordingResult = {
	fileId?: string;
	folderId?: string | null;
	download?: { id: string; name: string; size: number; reason: 'tooLarge' | 'noFreeSpace' };
	remainingParts: string[];
};

export class RecordingStorageFullError extends Error {
	constructor(message = 'Recording download storage is full') {
		super(message);
	}
}

/** 保管する場所が安全に使えないとき。呼び出し側では、容量不足と同じく保管できなかったものとして扱う。 */
export class RecordingStorageUnavailableError extends RecordingStorageFullError {
	constructor() {
		super('Recording download storage is unavailable');
	}
}

// KEYS: ENTRIES, TOTAL, USERS, EXPIRY, SEEDED。項目を索引から外し、集計を戻す。
const DROP_LUA = `
local function drop(id)
	local v = redis.call('HGET', KEYS[1], id)
	redis.call('ZREM', KEYS[4], id)
	if not v then return end
	redis.call('HDEL', KEYS[1], id)
	local u, s = string.match(v, '^([^|]*)|(%d+)|')
	if u then
		if redis.call('DECRBY', KEYS[2], tonumber(s)) < 0 then redis.call('SET', KEYS[2], 0) end
		if redis.call('HINCRBY', KEYS[3], u, -1) <= 0 then redis.call('HDEL', KEYS[3], u) end
	end
end
local function purge(now)
	for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)) do drop(id) end
end
`;

// 期限切れの項目だけを捨ててから、総量と本人の項目数を見て、空きがあれば予約する。ARGV: id, userId, size, now, expiresAt, 総量の上限, 項目数の上限
// 1: 予約した / 0: 総量を超える / -2: 本人の項目数が上限 / -1: まだ取り込んでいない
const RESERVE_SCRIPT = DROP_LUA + `
if redis.call('EXISTS', KEYS[5]) == 0 then return -1 end
purge(ARGV[4])
local size = tonumber(ARGV[3])
local total = tonumber(redis.call('GET', KEYS[2]) or '0')
if total + size > tonumber(ARGV[6]) then return 0 end
if tonumber(redis.call('HGET', KEYS[3], ARGV[2]) or '0') >= tonumber(ARGV[7]) then return -2 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '|' .. ARGV[3] .. '|' .. ARGV[5] .. '|' .. ARGV[4])
redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])
redis.call('INCRBY', KEYS[2], size)
redis.call('HINCRBY', KEYS[3], ARGV[2], 1)
return 1
`;

// ARGV: id
const RELEASE_SCRIPT = DROP_LUA + `
drop(ARGV[1])
return 1
`;

// ARGV: now。期限が切れた項目を捨て、合計を返す。
const PURGE_SCRIPT = DROP_LUA + `
purge(ARGV[1])
return tonumber(redis.call('GET', KEYS[2]) or '0')
`;

// 保存済みの録画を索引に取り込む。すでにあれば何もしない。ARGV: id, userId, size, expiresAt, reservedAt
const ADOPT_SCRIPT = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2] .. '|' .. ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5]) == 0 then return 0 end
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[1])
redis.call('INCRBY', KEYS[2], ARGV[3])
redis.call('HINCRBY', KEYS[3], ARGV[2], 1)
return 1
`;

@Injectable()
export class RecordingStorageService implements OnModuleInit, OnApplicationShutdown {
	private logger: Logger;
	private readonly dir: string;
	private dirUsable = true;
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
		// 같은 호스트의 다른 인스턴스가 임시 폴더를 공유하면 서로의 보관 파일을 기록 없는 파일로 보고 지운다.
		// 스윕이 자기 기록만 보는 범위에 맞추어 보관 폴더를 인스턴스(Redis keyPrefix)별로 나눈다.
		const instancePrefix = this.redisClient.options.keyPrefix ?? '';
		const instanceLabel = instancePrefix.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
		const instanceHash = createHash('sha256').update(instancePrefix).digest('hex').slice(0, 8);
		this.dir = Path.join(os.tmpdir(), `cherrypick-recording-downloads-${instanceLabel}-${instanceHash}`);
	}

	@bindThis
	public async onModuleInit(): Promise<void> {
		this.prepareDir();
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
		this.assertDirUsable();
		const size = fs.statSync(srcPath).size;
		const id = randomUUID();
		await this.reserve(id, userId, size);
		try {
			const path = Path.join(this.dir, id);
			fs.renameSync(srcPath, path);
			const record: RecordingDownload = { id, userId, requestId, path, name, size };
			await this.redisClient.set(downloadKey(id), JSON.stringify(record), 'PX', RECORDING_DOWNLOAD_TTL_MS);
			return record;
		} catch (err) {
			await this.release(id);
			throw err;
		}
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
		await this.release(id);
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

	/** 드라이브에 올리지 못한 조각을 임시 보관에 넣는다. 최종 내려받기와 같은 총량 상한·기한을 쓴다. */
	@bindThis
	public async storePart(userId: string, srcPath: string, name: string, type: string): Promise<RecordingPart> {
		this.assertDirUsable();
		const size = fs.statSync(srcPath).size;
		// 조각 id는 변환 요청의 fileIds(misskey:id 형식)에 섞여 들어가므로 대시 없는 식별자를 쓴다.
		const id = randomUUID().replaceAll('-', '');
		await this.reserve(id, userId, size);
		const path = Path.join(this.dir, id);
		try {
			await fs.promises.copyFile(srcPath, path);
			const record: RecordingPart = { id, userId, path, name, size, type };
			await this.redisClient.set(partKey(id), JSON.stringify(record), 'PX', RECORDING_DOWNLOAD_TTL_MS);
			return record;
		} catch (err) {
			await this.release(id);
			this.unlink(path);
			throw err;
		}
	}

	@bindThis
	public async getPart(id: string): Promise<RecordingPart | null> {
		const raw = await this.redisClient.get(partKey(id));
		if (raw == null) return null;
		try {
			return JSON.parse(raw) as RecordingPart;
		} catch {
			return null;
		}
	}

	@bindThis
	public async removePart(id: string): Promise<void> {
		const record = await this.getPart(id);
		await this.redisClient.del(partKey(id));
		await this.release(id);
		if (record != null) this.unlink(record.path);
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

	/** 保管中の録画の合計。期限が切れた予約は数えない。 */
	@bindThis
	private async storageUsage(): Promise<number> {
		await this.ensureSeeded();
		return Number(await this.redisClient.eval(PURGE_SCRIPT, INDEX_KEYS.length, ...INDEX_KEYS, Date.now()));
	}

	/** 総量と本人の項目数に空きがあれば、検査と予約を Redis の中で一度に行う。 */
	private async reserve(id: string, userId: string, size: number): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const now = Date.now();
			const result = await this.redisClient.eval(RESERVE_SCRIPT, INDEX_KEYS.length, ...INDEX_KEYS, id, userId, size, now, now + RECORDING_DOWNLOAD_TTL_MS + SWEEP_INTERVAL_MS, RECORDING_DOWNLOAD_STORAGE_MAX_BYTES, RECORDING_DOWNLOAD_USER_MAX_ENTRIES);
			if (result === 1) return;
			if (result === -1) {
				await this.ensureSeeded();
				continue;
			}
			throw new RecordingStorageFullError();
		}
		throw new RecordingStorageFullError();
	}

	private async release(id: string): Promise<void> {
		await this.redisClient.eval(RELEASE_SCRIPT, INDEX_KEYS.length, ...INDEX_KEYS, id);
	}

	/** 予約の記録が無かったころに保管された録画を、予約の記録に取り込む (一度だけ)。 */
	private async ensureSeeded(): Promise<void> {
		if (await this.redisClient.exists(SEEDED_KEY)) return;
		const now = Date.now();
		for (const prefix of [DOWNLOAD_PREFIX, PART_PREFIX]) {
			for await (const key of this.scanKeys(prefix)) {
				const raw = await this.redisClient.get(key);
				if (raw == null) continue;
				try {
					const record = JSON.parse(raw) as { id: string; userId: string; size: number };
					const ttl = await this.redisClient.pttl(key);
					if (ttl === -2) continue;
					const expiresAt = now + (ttl > 0 ? ttl : RECORDING_DOWNLOAD_TTL_MS);
					await this.redisClient.eval(ADOPT_SCRIPT, INDEX_KEYS.length, ...INDEX_KEYS, record.id, record.userId, record.size, expiresAt, now);
				} catch { /* ignore malformed */ }
			}
		}
		await this.redisClient.set(SEEDED_KEY, '1');
	}

	@bindThis
	private async sweep(): Promise<void> {
		// 기록이 만료된 임시 파일은 지운다
		const now = Date.now();
		const live = new Set<string>();
		const liveIds = new Set<string>();
		for (const prefix of [DOWNLOAD_PREFIX, PART_PREFIX]) {
			for await (const key of this.scanKeys(prefix)) {
				const raw = await this.redisClient.get(key);
				if (raw == null) continue;
				try {
					const record = JSON.parse(raw) as { id: string; path: string };
					live.add(record.path);
					liveIds.add(record.id);
				} catch { /* ignore malformed */ }
			}
		}
		await this.dropStaleReservations(liveIds);
		// 보관 폴더를 쓸 수 없을 때는 폴더를 읽고 지우는 일만 건너뛴다
		if (this.dirUsable) {
			for (const entry of fs.readdirSync(this.dir)) {
				const path = Path.join(this.dir, entry);
				if (live.has(path)) continue;
				// 조각을 복사하는 동안은 파일만 있고 기록이 아직 없으므로, 최근에 바뀐 파일은 지우지 않는다
				try {
					if (fs.statSync(path).mtimeMs > now - ORPHAN_RESERVATION_MS) continue;
				} catch { continue; }
				this.unlink(path);
			}
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

	/** 期限が切れたか、記録が無いまま時間が過ぎた予約を捨てる。 */
	private async dropStaleReservations(liveIds: Set<string>): Promise<void> {
		if (!await this.redisClient.exists(SEEDED_KEY)) return;
		const now = Date.now();
		await this.redisClient.eval(PURGE_SCRIPT, INDEX_KEYS.length, ...INDEX_KEYS, now);
		for (const [id, value] of Object.entries(await this.redisClient.hgetall(ENTRIES_KEY))) {
			const entry = parseUsage(value);
			if (entry == null || (!liveIds.has(id) && entry.reservedAt <= now - ORPHAN_RESERVATION_MS)) await this.release(id);
		}
	}

	/**
	 * 保管する場所は所有者だけが使えるようにする (0700)。すでにあるときは、シンボリックリンクでない自分のディレクトリだけを使い、権限を合わせる。
	 * 確かめられなければその場所は使わない。
	 */
	private prepareDir(): void {
		try {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			const fd = fs.openSync(this.dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
			try {
				const stat = fs.fstatSync(fd);
				if (!stat.isDirectory()) throw new Error('not a directory');
				if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('owned by another user');
				if ((stat.mode & 0o777) !== 0o700) fs.fchmodSync(fd, 0o700);
			} finally {
				fs.closeSync(fd);
			}
			this.dirUsable = true;
		} catch (err) {
			this.dirUsable = false;
			this.logger.error(`Recording storage directory cannot be used: ${String(err)}`);
		}
	}

	private assertDirUsable(): void {
		if (!this.dirUsable) throw new RecordingStorageUnavailableError();
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
		// MATCH는 glob 패턴이므로 keyPrefix에 든 glob 문자는 리터럴로 이스케이프한다.
		// 돌려받은 키에서 prefix를 뗄 때는 이스케이프하지 않은 원래 keyPrefix를 쓴다.
		const matchPrefix = keyPrefix.replace(/[\\*?[\]]/g, ch => `\\${ch}`);
		let cursor = '0';
		do {
			const [next, keys] = await this.redisClient.scan(cursor, 'MATCH', `${matchPrefix}${prefix}*`, 'COUNT', 500);
			cursor = next;
			for (const key of keys) yield key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;
		} while (cursor !== '0');
	}
}

function parseUsage(value: string): { userId: string; size: number; expiresAt: number; reservedAt: number } | null {
	const [userId, size, expiresAt, reservedAt] = value.split('|');
	if (userId == null || !/^\d+$/.test(size ?? '') || !/^\d+$/.test(expiresAt ?? '') || !/^\d+$/.test(reservedAt ?? '')) return null;
	return { userId, size: Number(size), expiresAt: Number(expiresAt), reservedAt: Number(reservedAt) };
}
