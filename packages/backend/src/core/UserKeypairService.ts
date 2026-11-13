/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import * as nodeCrypto from 'crypto';
import { EntityNotFoundError } from 'typeorm';
import type { MiUser } from '@/models/User.js';
import type { UserKeypairsRepository } from '@/models/_.js';
import { RedisKVCache } from '@/misc/cache.js';
import type { MiUserKeypair } from '@/models/UserKeypair.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';

class MissingUserKeypair {
	constructor(public readonly cause: EntityNotFoundError) {}
}

export type UserKeypairAvailability = { available: true; keypair: MiUserKeypair } | { available: false };

@Injectable()
export class UserKeypairService implements OnApplicationShutdown {
	private cache: RedisKVCache<MiUserKeypair>;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.userKeypairsRepository)
		private userKeypairsRepository: UserKeypairsRepository,
	) {
		this.cache = new RedisKVCache<MiUserKeypair>(this.redisClient, 'userKeypair:v2', {
			lifetime: 1000 * 60 * 60 * 24, // 24h
			memoryCacheLifetime: 1000 * 60 * 60, // 1h
			fetcher: (key) => this.loadKeypair(key),
			toRedisConverter: (value) => JSON.stringify(value),
			fromRedisConverter: (value) => JSON.parse(value),
		});
	}

	@bindThis
	public async getUserKeypair(userId: MiUser['id']): Promise<MiUserKeypair> {
		try {
			return await this.cache.fetch(userId);
		} catch (error) {
			throw error instanceof MissingUserKeypair ? error.cause : error;
		}
	}

	// 원본 키 행의 부재만 구분하며 캐시와 인프라 오류는 그대로 유지한다.
	@bindThis
	public async getUserKeypairAvailability(userId: MiUser['id']): Promise<UserKeypairAvailability> {
		try {
			return { available: true, keypair: await this.cache.fetch(userId) };
		} catch (error) {
			if (error instanceof MissingUserKeypair) return { available: false };
			throw error;
		}
	}

	@bindThis
	public dispose(): void {
		this.cache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}

	@bindThis
	public async fetcher(userId: MiUser['id']): Promise<MiUserKeypair> {
		try {
			return await this.loadKeypair(userId);
		} catch (error) {
			throw error instanceof MissingUserKeypair ? error.cause : error;
		}
	}

	private async loadKeypair(userId: MiUser['id']): Promise<MiUserKeypair> {
		const keyPair = await this.userKeypairsRepository.findOneByOrFail({ userId }).catch(error => {
			if (error instanceof EntityNotFoundError) throw new MissingUserKeypair(error);
			throw error;
		});

		// migrate PKCS#1 => PKCS#8. legacy misskey generated PKCS#1 but slacc only accepts PKCS#8
		if (keyPair.privateKey.includes('-----BEGIN RSA PRIVATE KEY-----')) {
			const pkcs8Key = nodeCrypto.createPrivateKey({ key: keyPair.privateKey, format: 'pem', type: 'pkcs1' }).export({ format: 'pem', type: 'pkcs8' });
			keyPair.privateKey = pkcs8Key;
			void this.userKeypairsRepository.update(userId, { privateKey: pkcs8Key });
		}

		return keyPair;
	}
}
