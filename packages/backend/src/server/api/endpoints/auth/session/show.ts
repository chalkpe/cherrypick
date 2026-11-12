/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AuthSessionsRepository } from '@/models/_.js';
import { AuthSessionEntityService } from '@/core/entities/AuthSessionEntityService.js';
import { DI } from '@/di-symbols.js';
import { MASTODON_OAUTH_PREFIX, mastodonOAuthPendingKey, type MastodonPendingAuthorization } from '@/misc/mastodon-oauth.js';
import { parseMastodonScopes, toCherryPickPermissions } from '@/server/api/mastodon/MastodonOAuthService.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['auth'],

	requireCredential: false,

	errors: {
		noSuchSession: {
			message: 'No such session.',
			code: 'NO_SUCH_SESSION',
			id: 'bd72c97d-eba7-4adb-a467-f171b8847250',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			id: {
				type: 'string',
				optional: false, nullable: false,
				format: 'id',
			},
			app: {
				type: 'object',
				optional: false, nullable: false,
				ref: 'App',
			},
			token: {
				type: 'string',
				optional: false, nullable: false,
			},
			permission: {
				type: 'array',
				optional: true, nullable: false,
				description: 'CherryPick permissions for the pending Mastodon OAuth request.',
				items: { type: 'string', optional: false, nullable: false },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		token: { type: 'string' },
	},
	required: ['token'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.authSessionsRepository)
		private authSessionsRepository: AuthSessionsRepository,

		private authSessionEntityService: AuthSessionEntityService,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,
	) {
		super(meta, paramDef, async (ps, me) => {
			// Lookup session
			const session = await this.authSessionsRepository.findOneBy({
				token: ps.token,
			});

			if (session == null) {
				throw new ApiError(meta.errors.noSuchSession);
			}

			if (session.token.startsWith(MASTODON_OAUTH_PREFIX)) {
				const pendingJson = await this.redisClient.get(mastodonOAuthPendingKey(session.token));
				if (pendingJson == null) throw new ApiError(meta.errors.noSuchSession);
				const pending = JSON.parse(pendingJson) as MastodonPendingAuthorization;
				return {
					...await this.authSessionEntityService.pack(session, me),
					permission: toCherryPickPermissions(parseMastodonScopes(pending.scope)),
				};
			}

			return await this.authSessionEntityService.pack(session, me);
		});
	}
}
