/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import { promiseMap } from '@/misc/promise-map.js';
import { getErrorData, getErrorException, getErrorStatus, MastodonLogger } from '@/server/api/mastodon/MastodonLogger.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { ApiAccountMastodon } from '@/server/api/mastodon/endpoints/account.js';
import { ApiAppsMastodon } from '@/server/api/mastodon/endpoints/apps.js';
import { ApiFilterMastodon } from '@/server/api/mastodon/endpoints/filter.js';
import { ApiInstanceMastodon } from '@/server/api/mastodon/endpoints/instance.js';
import { ApiMarkersMastodon } from '@/server/api/mastodon/endpoints/markers.js';
import { ApiPushMastodon } from '@/server/api/mastodon/endpoints/push.js';
import { ApiStatusMastodon } from '@/server/api/mastodon/endpoints/status.js';
import { ApiNotificationsMastodon } from '@/server/api/mastodon/endpoints/notifications.js';
import { ApiTimelineMastodon } from '@/server/api/mastodon/endpoints/timeline.js';
import { ApiSearchMastodon } from '@/server/api/mastodon/endpoints/search.js';
import { ApiError } from '@/server/api/error.js';
import { MastodonServerUtilityService, readSavedRequestFile } from '@/server/api/mastodon/MastodonServerUtilityService.js';
import { attachMinMaxPagination } from '@/server/api/mastodon/pagination.js';
import { MastodonPreferenceService } from '@/server/api/mastodon/MastodonPreferenceService.js';
import { parseTimelineArgs, TimelineArgs, toBoolean, unflattenFormBody } from './argsUtils.js';
import { convertAnnouncement, convertAttachment, MastodonConverters, convertRelationship } from './MastodonConverters.js';
import type { Entity } from 'megalodon';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

const MASTODON_API_PREFIXES = ['/api/v1/', '/api/v2/'];

export function isMastodonApiUrl(url: string): boolean {
	return MASTODON_API_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * Mastodon (Rails) ignores trailing slashes, and some clients rely on it, such as Moshidon requesting "/api/v1/mutes/".
 */
export function stripMastodonTrailingSlash(url: string): string {
	if (!isMastodonApiUrl(url)) return url;

	const queryIndex = url.indexOf('?');
	const pathEnd = queryIndex < 0 ? url.length : queryIndex;
	let end = pathEnd;
	while (end > MASTODON_API_PREFIXES[0].length && url[end - 1] === '/') end--;
	return end === pathEnd ? url : url.slice(0, end) + url.slice(pathEnd);
}

@Injectable()
export class MastodonApiServerService {
	constructor(
		private readonly mastoConverters: MastodonConverters,
		private readonly logger: MastodonLogger,
		private readonly clientService: MastodonClientService,
		private readonly apiAccountMastodon: ApiAccountMastodon,
		private readonly apiAppsMastodon: ApiAppsMastodon,
		private readonly apiFilterMastodon: ApiFilterMastodon,
		private readonly apiInstanceMastodon: ApiInstanceMastodon,
		private readonly apiMarkersMastodon: ApiMarkersMastodon,
		private readonly apiPushMastodon: ApiPushMastodon,
		private readonly apiNotificationsMastodon: ApiNotificationsMastodon,
		private readonly apiSearchMastodon: ApiSearchMastodon,
		private readonly apiStatusMastodon: ApiStatusMastodon,
		private readonly apiTimelineMastodon: ApiTimelineMastodon,
		private readonly serverUtilityService: MastodonServerUtilityService,
		private readonly preferenceService: MastodonPreferenceService,
	) {}

	@bindThis
	public createServer(fastify: FastifyInstance, _options: FastifyPluginOptions, done: (err?: Error) => void) {
		this.serverUtilityService.addMultipartFormDataContentType(fastify);
		this.serverUtilityService.addFormUrlEncodedContentType(fastify);
		this.serverUtilityService.addCORS(fastify);
		this.serverUtilityService.addFlattenedQueryType(fastify);

		// Convert JS exceptions into error responses
		fastify.setErrorHandler((error, request, reply) => {
			const data = getErrorData(error);
			const status = getErrorStatus(error);
			const exception = getErrorException(error);

			if (exception) {
				this.logger.exception(request, exception);
			}

			return reply.code(status).send(data);
		});

		// Log error responses (including converted JSON exceptions)
		fastify.addHook('onSend', (request, reply, payload, done) => {
			if (reply.statusCode >= 400) {
				if (typeof(payload) === 'string' && String(reply.getHeader('content-type')).toLowerCase().includes('application/json')) {
					const body = JSON.parse(payload);
					const data = getErrorData(body);
					this.logger.error(request, data, reply.statusCode);
				}
			}
			done();
		});

		fastify.addHook('onRequest', (request, reply, done) => {
			// Tell crawlers not to index API endpoints.
			// https://developers.google.com/search/docs/crawling-indexing/block-indexing
			reply.header('X-Robots-Tag', 'noindex');
			// Prevent cache
			reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
			done();
		});

		// External endpoints
		this.apiAccountMastodon.register(fastify);
		this.apiAppsMastodon.register(fastify);
		this.apiFilterMastodon.register(fastify);
		this.apiInstanceMastodon.register(fastify);
		this.apiMarkersMastodon.register(fastify);
		this.apiPushMastodon.register(fastify);
		this.apiNotificationsMastodon.register(fastify);
		this.apiSearchMastodon.register(fastify);
		this.apiStatusMastodon.register(fastify);
		this.apiTimelineMastodon.register(fastify);

		// Clients check this before connecting to the streaming API over WebSocket
		fastify.get('/v1/streaming/health', async (_request, reply) => {
			return reply.type('text/plain').send('OK');
		});

		fastify.get('/v1/custom_emojis', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			const data = await client.getInstanceCustomEmojis();
			return reply.send(data.data);
		});

		fastify.get('/v1/announcements', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			const data = await client.getInstanceAnnouncements();
			const response = data.data.map((announcement) => convertAnnouncement(announcement));

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/announcements/:id/dismiss', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.dismissInstanceAnnouncement(_request.params.id);

			return reply.send(data.data);
		});

		fastify.post('/v1/media', async (_request, reply) => {
			const multipartData = _request.savedRequestFiles?.[0];
			if (!multipartData) {
				return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'No image' });
			}

			const file = await readSavedRequestFile(multipartData);
			const client = this.clientService.getClient(_request);
			const data = await client.uploadMedia(file);
			const response = convertAttachment(data.data as Entity.Attachment);

			return reply.send(response);
		});

		fastify.post<{ Body: { description?: string; focus?: string } }>('/v2/media', async (_request, reply) => {
			const multipartData = _request.savedRequestFiles?.[0];
			if (!multipartData) {
				return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'No image' });
			}
			const file = await readSavedRequestFile(multipartData);

			const client = this.clientService.getClient(_request);
			const data = await client.uploadMedia(file, _request.body);
			const response = convertAttachment(data.data as Entity.Attachment);

			return reply.send(response);
		});

		fastify.get('/v1/trends', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			const data = await client.getInstanceTrends();
			return reply.send(data.data);
		});

		fastify.get('/v1/trends/tags', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			const data = await client.getInstanceTrends();
			return reply.send(data.data);
		});

		fastify.get('/v1/trends/links', async (_request, reply) => {
			// As we do not have any system for news/links this will just return empty
			return reply.send([]);
		});

		fastify.get('/v1/preferences', async (request, reply) => {
			const me = await this.clientService.getAuth(request);
			if (me == null) return reply.code(401).send({ error: 'The access token is invalid' });
			return reply.send(await this.preferenceService.getPreferences(me.id));
		});

		fastify.get('/v1/followed_tags', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			const data = await client.getFollowedTags();
			return reply.send(data.data);
		});

		fastify.post<{ Body?: Record<string, unknown> }>('/v1/reports', async (request, reply) => {
			const body = unflattenFormBody(request.body ?? {}) as { account_id?: string, status_ids?: string | string[], comment?: string, category?: string, forward?: string | boolean };
			if (!body.account_id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "account_id"' });

			// Misskey reports only carry a comment, so the category and the reported statuses (as links) go into it
			const baseUrl = this.clientService.getPublicBaseUrl();
			const statusIds = body.status_ids == null ? [] : Array.isArray(body.status_ids) ? body.status_ids : [body.status_ids];
			const category = body.category ?? 'other';
			const comment = [
				category !== 'other' ? `[${category}]` : null,
				body.comment,
				...statusIds.map(id => `${baseUrl}/notes/${id}`),
			].filter(Boolean).join('\n') || `Reported (${category})`;

			const { client } = await this.clientService.getAuthClient(request);
			await client.callApi('/api/users/report-abuse', { userId: body.account_id, comment });
			const account = await client.getAccount(body.account_id);

			return reply.send({
				// Misskey does not return the report
				id: String(Date.now()),
				action_taken: false,
				action_taken_at: null,
				category,
				comment: body.comment ?? '',
				forwarded: false,
				created_at: new Date().toISOString(),
				status_ids: statusIds,
				rule_ids: [],
				target_account: await this.mastoConverters.convertAccount(account.data),
			});
		});

		// Blocking a domain is a Misskey instance mute
		fastify.get('/v1/domain_blocks', async (request, reply) => {
			const me = await this.clientService.callApi<{ mutedInstances?: string[] }>(request, 'i', {});
			return reply.send(me.mutedInstances ?? []);
		});

		for (const method of ['POST', 'DELETE'] as const) {
			fastify.route<{ Body?: { domain?: string }, Querystring: { domain?: string } }>({
				method,
				url: '/v1/domain_blocks',
				handler: async (request, reply) => {
					const domain = (request.body?.domain ?? request.query.domain)?.trim().toLowerCase();
					if (!domain) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "domain"' });

					const me = await this.clientService.callApi<{ mutedInstances?: string[] }>(request, 'i', {});
					const current = me.mutedInstances ?? [];
					const mutedInstances = method === 'POST'
						? [...new Set([...current, domain])]
						: current.filter(host => host !== domain);
					await this.clientService.callApi(request, 'i/update', { mutedInstances });

					return reply.send({});
				},
			});
		}

		fastify.get<{ Querystring: TimelineArgs }>('/v1/bookmarks', async (_request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(_request);

			const data = await client.getBookmarks(parseTimelineArgs(_request.query));
			const response = await promiseMap(data.data, async (status) => await this.mastoConverters.convertStatus(status, me), { limiter: 4 });

			// Misskey paginates by the favorite records rather than by the notes
			attachMinMaxPagination(_request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Querystring: TimelineArgs }>('/v1/favourites', async (_request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(_request);

			if (!me) {
				throw new ApiError({
					message: 'Credential required.',
					code: 'CREDENTIAL_REQUIRED',
					id: '1384574d-a912-4b81-8601-c7b1c4085df1',
					httpStatusCode: 401,
				});
			}

			const args = {
				...parseTimelineArgs(_request.query),
				userId: me.id,
			};
			const data = await client.getFavourites(args);
			const response = await promiseMap(data.data, async (status) => await this.mastoConverters.convertStatus(status, me), { limiter: 4 });

			// Misskey paginates by the reaction records rather than by the notes
			attachMinMaxPagination(_request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Querystring: TimelineArgs }>('/v1/mutes', async (_request, reply) => {
			const client = this.clientService.getClient(_request);

			const data = await client.getMutes(parseTimelineArgs(_request.query));
			const response = await promiseMap(data.data, async (account) => ({
				...await this.mastoConverters.convertAccount(account),
				mute_expires_at: account.mute_expires_at ?? null,
			}), { limiter: 4 });

			// Misskey paginates by the muting records rather than by the accounts
			attachMinMaxPagination(_request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Querystring: TimelineArgs }>('/v1/blocks', async (_request, reply) => {
			const client = this.clientService.getClient(_request);

			const data = await client.getBlocks(parseTimelineArgs(_request.query));
			const response = await promiseMap(data.data, async (account) => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			// Misskey paginates by the blocking records rather than by the accounts
			attachMinMaxPagination(_request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Querystring: TimelineArgs }>('/v1/follow_requests', async (_request, reply) => {
			const client = this.clientService.getClient(_request);

			const data = await client.getFollowRequests(parseTimelineArgs(_request.query));
			const response = await promiseMap(data.data, async (account) => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			// Misskey paginates by the follow request records rather than by the accounts
			attachMinMaxPagination(_request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/follow_requests/:id/authorize', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.acceptFollowRequest(_request.params.id);
			const response = convertRelationship(data.data);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/follow_requests/:id/reject', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.rejectFollowRequest(_request.params.id);
			const response = convertRelationship(data.data);

			return reply.send(response);
		});
		//#endregion

		fastify.put<{
			Params: {
				id?: string,
			},
			Body: {
				file?: unknown,
				description?: string,
				focus?: string,
				is_sensitive?: string,
			},
		}>('/v1/media/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const options = {
				..._request.body,
				is_sensitive: toBoolean(_request.body.is_sensitive),
			};
			const client = this.clientService.getClient(_request);
			const data = await client.updateMedia(_request.params.id, options);
			const response = convertAttachment(data.data);

			return reply.send(response);
		});

		done();
	}
}
