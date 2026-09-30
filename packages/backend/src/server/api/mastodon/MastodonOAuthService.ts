/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { verifyChallenge } from 'pkce-challenge';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { AccessTokensRepository, AppsRepository, AuthSessionsRepository, MiApp } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { MASTODON_OAUTH_PREFIX } from '@/misc/mastodon-oauth.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import type { FastifyReply } from 'fastify';

export type MastodonOAuthParameters = Record<string, string | string[] | undefined>;

// Mastodon clients show this URI when they want the user to copy the code by hand.
const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// Redirecting to these schemes after authorization would run code in, or leak data from, this server's origin.
// Keep in sync with MASTODON_FORBIDDEN_REDIRECT_PROTOCOLS in the frontend auth page.
const FORBIDDEN_REDIRECT_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];

// Authorization requests are kept until the user finishes signing in and approving the app.
const AUTHORIZATION_TTL_SECONDS = 60 * 60;

// Permissions of the Misskey endpoints the Mastodon-compatible API calls, so tokens get no more than that
const readPermissions = [
	'read:account',
	'read:blocks',
	'read:drive',
	'read:favorites',
	'read:following',
	'read:mutes',
	'read:notifications',
];
const writePermissions = [
	'write:account',
	'write:blocks',
	'write:drive',
	'write:favorites',
	'write:following',
	'write:mutes',
	'write:notes',
	'write:notifications',
	'write:reactions',
	'write:report-abuse',
	'write:votes',
];
const followPermissions = ['read:following', 'write:following', 'read:blocks', 'write:blocks', 'read:mutes', 'write:mutes'];

interface PendingAuthorization {
	redirectUri: string;
	scope: string;
	codeChallenge: string | null;
}

class MastodonOAuthError extends Error {
	constructor(
		public readonly error: string,
		public readonly description: string,
		public readonly statusCode = 400,
	) {
		super(description);
	}
}

function firstValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/**
 * Splits Mastodon's space (or "+") separated scope list.
 */
export function parseMastodonScopes(scopes: string | string[] | undefined): string[] {
	const list = Array.isArray(scopes) ? scopes : (scopes ?? 'read').split(/[\s+]+/);
	return list.map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Maps Mastodon scopes to CherryPick permissions.
 * Granular scopes such as read:statuses are widened to their top-level scope, because CherryPick permissions do not line up with them.
 */
export function toCherryPickPermissions(scopes: string[]): string[] {
	const result = new Set<string>();
	for (const scope of scopes) {
		if (scope === 'read' || scope.startsWith('read:')) readPermissions.forEach(p => result.add(p));
		if (scope === 'write' || scope.startsWith('write:')) writePermissions.forEach(p => result.add(p));
		if (scope === 'follow') followPermissions.forEach(p => result.add(p));
		if (scope === 'profile') result.add('read:account');
	}
	return Array.from(result);
}

/**
 * Splits the redirect URIs registered through /api/v1/apps.
 * Mastodon accepts both an array and a newline separated string.
 */
export function parseRedirectUris(value: string | string[] | undefined): string[] {
	const list = Array.isArray(value) ? value : (value ?? '').split(/\s+/);
	return list.map(s => s.trim()).filter(s => s.length > 0);
}

export function isAllowedRedirectUri(uri: string): boolean {
	if (uri === OOB_REDIRECT_URI) return true;
	try {
		const url = new URL(uri);
		return !FORBIDDEN_REDIRECT_PROTOCOLS.includes(url.protocol);
	} catch {
		return false;
	}
}

/**
 * Mastodon-compatible OAuth 2.0 flow on top of the legacy app authentication sessions.
 *
 * Mastodon clients use the app ID as client_id, which is never a URL.
 * IndieAuth clients handled by OAuth2ProviderService always use a URL, so the two flows can share the /oauth endpoints.
 */
@Injectable()
export class MastodonOAuthService {
	private readonly logger: Logger;

	constructor(
		@Inject(DI.config)
		private readonly config: Config,

		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		@Inject(DI.appsRepository)
		private readonly appsRepository: AppsRepository,

		@Inject(DI.authSessionsRepository)
		private readonly authSessionsRepository: AuthSessionsRepository,

		@Inject(DI.accessTokensRepository)
		private readonly accessTokensRepository: AccessTokensRepository,

		private readonly idService: IdService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('masto-oauth');
	}

	/**
	 * Whether the request carries a Mastodon client_id rather than an IndieAuth one.
	 */
	@bindThis
	public isMastodonRequest(params: MastodonOAuthParameters): boolean {
		const clientId = firstValue(params.client_id);
		if (clientId == null || clientId === '') return false;
		return !URL.canParse(clientId);
	}

	/**
	 * GET /oauth/authorize
	 * Starts an app authentication session and sends the user to the authorization page.
	 */
	@bindThis
	public async authorize(params: MastodonOAuthParameters, reply: FastifyReply): Promise<void> {
		try {
			const app = await this.findApp(params);

			const responseType = firstValue(params.response_type);
			if (responseType !== 'code') {
				throw new MastodonOAuthError('unsupported_response_type', 'Only the "code" response type is supported');
			}

			const redirectUri = firstValue(params.redirect_uri);
			if (!redirectUri || !this.getRegisteredRedirectUris(app).includes(redirectUri)) {
				throw new MastodonOAuthError('invalid_request', 'redirect_uri does not match any registered redirect URI');
			}
			if (redirectUri === OOB_REDIRECT_URI) {
				throw new MastodonOAuthError('invalid_request', 'Out-of-band authorization is not supported');
			}

			const codeChallenge = firstValue(params.code_challenge) ?? null;
			if (codeChallenge != null && (firstValue(params.code_challenge_method) ?? 'plain') !== 'S256') {
				throw new MastodonOAuthError('invalid_request', 'code_challenge_method must be S256');
			}

			const scopes = parseMastodonScopes(params.scope);
			const permissions = toCherryPickPermissions(scopes);
			if (permissions.some(permission => !app.permission.includes(permission))) {
				throw new MastodonOAuthError('invalid_scope', 'The requested scope exceeds the registered permissions');
			}

			const session = await this.authSessionsRepository.insertOne({
				id: this.idService.gen(),
				appId: app.id,
				token: MASTODON_OAUTH_PREFIX + randomUUID(),
			});

			const pending: PendingAuthorization = {
				redirectUri,
				scope: scopes.join(' '),
				codeChallenge,
			};
			await this.redisClient.set(this.pendingKey(session.token), JSON.stringify(pending), 'EX', AUTHORIZATION_TTL_SECONDS);

			const authUrl = new URL(`${this.config.authUrl}/${session.token}`);
			authUrl.searchParams.set('mastodon', 'true');
			authUrl.searchParams.set('redirect_uri', redirectUri);
			const state = firstValue(params.state);
			if (state) authUrl.searchParams.set('state', state);

			this.logger.info(`Starting authorization of app ${app.id}`);
			reply.redirect(authUrl.toString());
		} catch (err) {
			this.sendError(reply, err);
		}
	}

	/**
	 * POST /oauth/token
	 */
	@bindThis
	public async token(params: MastodonOAuthParameters, reply: FastifyReply): Promise<void> {
		reply.header('Cache-Control', 'no-store');
		reply.header('Pragma', 'no-cache');

		try {
			const grantType = firstValue(params.grant_type);

			if (grantType === 'client_credentials') {
				// CherryPick has no app-only tokens. Some clients still request one right after registering,
				// so hand out a token that is never stored, as Sharkey does.
				await this.findApp(params, true);
				reply.send({
					access_token: randomUUID(),
					token_type: 'Bearer',
					scope: 'read',
					created_at: Math.floor(Date.now() / 1000),
				});
				return;
			}

			if (grantType !== 'authorization_code') {
				throw new MastodonOAuthError('unsupported_grant_type', 'Only the authorization_code grant type is supported');
			}

			const app = await this.findApp(params, true);

			const code = firstValue(params.code);
			if (!code?.startsWith(MASTODON_OAUTH_PREFIX)) throw new MastodonOAuthError('invalid_grant', 'Invalid authorization code');

			const session = await this.authSessionsRepository.findOneBy({ token: code, appId: app.id });
			if (session == null || session.userId == null) {
				throw new MastodonOAuthError('invalid_grant', 'The authorization code is invalid or has not been approved yet');
			}

			const pendingJson = await this.redisClient.get(this.pendingKey(code));
			if (pendingJson == null) {
				throw new MastodonOAuthError('invalid_grant', 'The authorization code has expired');
			}
			const pending = JSON.parse(pendingJson) as PendingAuthorization;

			const redirectUri = firstValue(params.redirect_uri);
			if (redirectUri != null && redirectUri !== pending.redirectUri) {
				throw new MastodonOAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
			}

			if (pending.codeChallenge != null) {
				const codeVerifier = firstValue(params.code_verifier);
				if (!codeVerifier || !(await verifyChallenge(codeVerifier, pending.codeChallenge))) {
					throw new MastodonOAuthError('invalid_grant', 'code_verifier does not match the code challenge');
				}
			}

			// Claim the code atomically only after all checks. Concurrent exchanges must not issue two tokens.
			if (await this.redisClient.getdel(this.pendingKey(code)) == null) {
				throw new MastodonOAuthError('invalid_grant', 'The authorization code has expired or was already used');
			}
			await this.authSessionsRepository.delete(session.id);

			// Each grant has its own immutable permissions; legacy app-wide tokens must never be reused.
			const token = secureRndstr(32);
			const accessToken = await this.accessTokensRepository.insertOne({
				id: this.idService.gen(),
				appId: app.id,
				userId: session.userId,
				// Never expose the token through the unauthenticated MiAuth session/check endpoint.
				session: MASTODON_OAUTH_PREFIX + randomUUID(),
				fetched: true,
				token,
				hash: createHash('sha256').update(token + app.secret).digest('hex'),
				permission: toCherryPickPermissions(parseMastodonScopes(pending.scope)),
			});

			this.logger.info(`Issued access token of app ${app.id} for user ${session.userId}`);
			reply.send({
				access_token: accessToken.token,
				token_type: 'Bearer',
				scope: pending.scope,
				created_at: Math.floor(this.idService.parse(accessToken.id).date.getTime() / 1000),
			});
		} catch (err) {
			this.sendError(reply, err);
		}
	}

	/**
	 * POST /oauth/revoke
	 */
	@bindThis
	public async revoke(params: MastodonOAuthParameters, reply: FastifyReply): Promise<void> {
		try {
			const app = await this.findApp(params, true);

			const token = firstValue(params.token);
			if (!token) throw new MastodonOAuthError('invalid_request', 'token is required');

			await this.accessTokensRepository.delete({ appId: app.id, token });

			// RFC 7009: respond with 200 whether or not the token existed.
			reply.send({});
		} catch (err) {
			this.sendError(reply, err);
		}
	}

	private async findApp(params: MastodonOAuthParameters, requireSecret = false): Promise<MiApp> {
		const clientId = firstValue(params.client_id);
		const app = clientId ? await this.appsRepository.findOneBy({ id: clientId }) : null;
		if (app == null) {
			throw new MastodonOAuthError('invalid_client', 'Unknown client_id', 401);
		}

		if (requireSecret) {
			const secret = firstValue(params.client_secret) ?? '';
			const expected = Buffer.from(app.secret);
			const actual = Buffer.from(secret);
			if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
				throw new MastodonOAuthError('invalid_client', 'client_secret is invalid', 401);
			}
		}

		return app;
	}

	private getRegisteredRedirectUris(app: MiApp): string[] {
		return parseRedirectUris(app.callbackUrl ?? undefined);
	}

	private pendingKey(sessionToken: string): string {
		return `mastodonOAuth:${sessionToken}`;
	}

	private sendError(reply: FastifyReply, err: unknown): void {
		if (err instanceof MastodonOAuthError) {
			reply.code(err.statusCode).send({ error: err.error, error_description: err.description });
			return;
		}

		this.logger.error('Unexpected error in Mastodon OAuth flow', { error: err });
		reply.code(500).send({ error: 'server_error', error_description: 'Internal server error' });
	}
}
