/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { CacheService } from '@/core/CacheService.js';
import type { MiUser } from '@/models/User.js';
import type { MastodonEntity } from 'megalodon';

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct';

const VISIBILITIES: readonly string[] = ['public', 'unlisted', 'private', 'direct'];

export function isVisibility(value: unknown): value is Visibility {
	return typeof value === 'string' && VISIBILITIES.includes(value);
}

/**
 * Posting preferences of Mastodon clients.
 * Misskey keeps the default visibility in its web client only, so it is kept in Redis for Mastodon clients.
 * The default sensitivity and language come from the Misskey profile.
 */
@Injectable()
export class MastodonPreferenceService {
	constructor(
		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		private readonly cacheService: CacheService,
	) {}

	private key(userId: MiUser['id']): string {
		return `mastodonPreferences:${userId}`;
	}

	public async getDefaultVisibility(userId: MiUser['id']): Promise<Visibility> {
		const value = await this.redisClient.hget(this.key(userId), 'privacy');
		return isVisibility(value) ? value : 'public';
	}

	public async setDefaultVisibility(userId: MiUser['id'], visibility: Visibility): Promise<void> {
		await this.redisClient.hset(this.key(userId), 'privacy', visibility);
	}

	public async getPreferences(userId: MiUser['id']): Promise<MastodonEntity.Preferences> {
		const [visibility, profile] = await Promise.all([
			this.getDefaultVisibility(userId),
			this.cacheService.userProfileCache.fetch(userId),
		]);
		return {
			'posting:default:visibility': visibility,
			'posting:default:sensitive': profile.alwaysMarkNsfw,
			'posting:default:language': profile.lang ?? null,
			'reading:expand:media': 'default',
			'reading:expand:spoilers': false,
		};
	}
}
