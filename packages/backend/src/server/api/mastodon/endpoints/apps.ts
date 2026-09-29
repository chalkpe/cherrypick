/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { AccessTokensRepository, AppsRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { AuthenticateService } from '@/server/api/AuthenticateService.js';
import { getAccessToken } from '@/server/api/mastodon/MastodonClientService.js';
import {
	isAllowedRedirectUri,
	parseMastodonScopes,
	parseRedirectUris,
	toCherryPickPermissions,
} from '@/server/api/mastodon/MastodonOAuthService.js';
import type { FastifyInstance } from 'fastify';

export interface AuthPayload {
	scopes?: string | string[],
	redirect_uris?: string | string[],
	client_name?: string | string[],
	website?: string | string[],
}

// Not entirely right, but it gets TypeScript to work so *shrug*
type AuthMastodonRoute = { Body?: AuthPayload, Querystring: AuthPayload };

@Injectable()
export class ApiAppsMastodon {
	constructor(
		@Inject(DI.appsRepository)
		private readonly appsRepository: AppsRepository,

		@Inject(DI.accessTokensRepository)
		private readonly accessTokensRepository: AccessTokensRepository,

		private readonly idService: IdService,
		private readonly authenticateService: AuthenticateService,
	) {}

	public register(fastify: FastifyInstance): void {
		fastify.post<AuthMastodonRoute>('/v1/apps', async (_request, reply) => {
			const body = _request.body ?? _request.query;
			if (!body.client_name) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "client_name"' });
			if (Array.isArray(body.client_name)) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Invalid payload "client_name": only one value is allowed' });
			if (Array.isArray(body.website)) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Invalid payload "website": only one value is allowed' });

			const redirectUris = parseRedirectUris(body.redirect_uris);
			if (redirectUris.length === 0) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "redirect_uris"' });
			if (!redirectUris.every(uri => isAllowedRedirectUri(uri))) return reply.code(422).send({ error: 'Validation failed: Redirect URI must be an absolute URI.' });

			const scopes = parseMastodonScopes(body.scopes);

			const app = await this.appsRepository.insertOne({
				id: this.idService.gen(),
				userId: null,
				name: body.client_name,
				description: body.website ?? '',
				permission: toCherryPickPermissions(scopes),
				callbackUrl: redirectUris.join('\n'),
				secret: secureRndstr(32),
			});

			return reply.send({
				id: app.id,
				name: app.name,
				website: body.website ?? null,
				scopes,
				redirect_uri: redirectUris.join('\n'),
				redirect_uris: redirectUris,
				client_id: app.id,
				client_secret: app.secret,
				client_secret_expires_at: 0,
			});
		});

		fastify.get('/v1/apps/verify_credentials', async (_request, reply) => {
			// authenticate() returns only the ID and permissions of app tokens, so look up the app separately.
			const [, token] = await this.authenticateService.authenticate(getAccessToken(_request));
			const accessToken = token ? await this.accessTokensRepository.findOneBy({ id: token.id }) : null;
			const app = accessToken?.appId ? await this.appsRepository.findOneBy({ id: accessToken.appId }) : null;
			if (app == null) {
				return reply.code(401).send({ error: 'The access token is invalid' });
			}

			const redirectUris = parseRedirectUris(app.callbackUrl ?? undefined);
			return reply.send({
				id: app.id,
				name: app.name,
				website: app.description || null,
				scopes: app.permission,
				redirect_uri: redirectUris.join('\n'),
				redirect_uris: redirectUris,
			});
		});
	}
}
