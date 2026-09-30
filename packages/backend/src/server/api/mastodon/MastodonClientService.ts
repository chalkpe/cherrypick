/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Misskey } from 'megalodon';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiLocalUser } from '@/models/User.js';
import { AuthenticateService, AuthenticationError } from '@/server/api/AuthenticateService.js';
import { ApiError } from '@/server/api/error.js';
import type { FastifyRequest } from 'fastify';

@Injectable()
export class MastodonClientService {
	constructor(
		@Inject(DI.config)
		private readonly config: Config,

		private readonly authenticateService: AuthenticateService,
	) {}

	/**
	 * Gets the authenticated user and API client for a request.
	 */
	public async getAuthClient(request: FastifyRequest, accessToken?: string | null): Promise<{ client: Misskey, me: MiLocalUser | null }> {
		accessToken = accessToken !== undefined ? accessToken : getAccessToken(request);

		const me = await this.getAuth(request, accessToken);
		const client = this.getClient(request, accessToken);

		return { client, me };
	}

	/**
	 * Gets the authenticated client user for a request.
	 */
	public async getAuth(request: FastifyRequest, accessToken?: string | null): Promise<MiLocalUser | null> {
		accessToken = accessToken !== undefined ? accessToken : getAccessToken(request);
		const [me] = await this.authenticateService.authenticate(accessToken);
		return me;
	}

	/**
	 * Gets the authenticated user of a request, for routes that read or write data directly instead of through the Misskey API.
	 * Fails with 401 when there is none, and with 403 when the access token lacks the permission the Misskey API would ask for.
	 */
	public async requireAuth(request: FastifyRequest, permission?: string): Promise<MiLocalUser> {
		const [me, token] = await this.authenticateService.authenticate(getAccessToken(request));
		if (me == null) throw new AuthenticationError('Credential required.');

		// Native user tokens carry no permission list and may do anything
		if (permission != null && token != null && !token.permission.includes(permission)) {
			throw new ApiError({
				message: 'Your app does not have the necessary permissions to use this endpoint.',
				code: 'PERMISSION_DENIED',
				id: '1370e5b7-d4eb-4566-bb1d-7748ee6a1838',
				kind: 'permission',
				httpStatusCode: 403,
			});
		}

		return me;
	}

	/**
	 * Creates an authenticated API client for a request.
	 */
	public getClient(request: FastifyRequest, accessToken?: string | null): Misskey {
		accessToken = accessToken !== undefined ? accessToken : getAccessToken(request);

		const userAgent = request.headers['user-agent'];
		return new Misskey(this.getPublicBaseUrl(), accessToken, userAgent, {
			// Call back into this process directly rather than through the public URL.
			// The public URL may be unreachable from the server itself, and the request's Host header is client-controlled.
			apiUrl: this.config.socket ? 'http://localhost' : `http://127.0.0.1:${this.config.port}`,
			socketPath: this.config.socket,
			headers: {
				// Loopback is a trusted proxy by default, so rate limits keep applying per client
				'X-Forwarded-For': request.ip,
			},
			// The request carries the user's access token, so it must not leave the host through an HTTP(S)_PROXY
			proxy: false,
		});
	}

	/**
	 * Base URL used to build URLs in API responses.
	 */
	public getPublicBaseUrl(): string {
		return this.config.url.replace(/\/$/, '');
	}

	/**
	 * Calls a Misskey API endpoint that megalodon does not wrap, on behalf of the requesting user.
	 */
	public async callApi<T>(request: FastifyRequest, endpoint: string, body: Record<string, unknown>): Promise<T> {
		const res = await this.getClient(request).callApi<T>(`/api/${endpoint}`, body);
		return res.data;
	}
}

/**
 * Gets the base URL (origin) of the incoming request
 */
export function getBaseUrl(request: FastifyRequest): string {
	return `${request.protocol}://${request.host}`;
}

/**
 * Extracts the access token from the Authorization header, or from the access_token parameter as a fallback.
 * Returns null if none were found.
 */
export function getAccessToken(request: FastifyRequest): string | null {
	const authorization = request.headers.authorization;
	if (authorization) {
		const parts = authorization.split(' ');
		return parts[parts.length - 1] || null;
	}

	const query = request.query as Record<string, unknown> | undefined;
	if (typeof query?.access_token === 'string') {
		return query.access_token;
	}

	return null;
}
