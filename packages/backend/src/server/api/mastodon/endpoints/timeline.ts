/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { attachMinMaxPagination, sortNewestFirst } from '@/server/api/mastodon/pagination.js';
import { promiseMap } from '@/misc/promise-map.js';
import { convertList, MastodonConverters } from '../MastodonConverters.js';
import { parseTimelineArgs, TimelineArgs, toBoolean, unflattenFormBody } from '../argsUtils.js';
import type { Entity } from 'megalodon';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface ListAccountsRoute {
	Params: { id?: string },
	Querystring: { account_ids?: string | string[] },
	Body?: Record<string, unknown>,
}

/**
 * Account IDs to add to or remove from a list.
 * Mastodon takes them as "account_ids[]" in the body, but some clients send them in the query string, especially with DELETE.
 */
function getListAccountIds(request: FastifyRequest<ListAccountsRoute>): string[] {
	const body = unflattenFormBody(request.body ?? {}) as { account_ids?: unknown };
	const value = body.account_ids ?? request.query.account_ids;
	const ids = Array.isArray(value) ? value : [value];
	return ids.filter((id): id is string => typeof id === 'string' && id !== '');
}

@Injectable()
export class ApiTimelineMastodon {
	constructor(
		private readonly clientService: MastodonClientService,
		private readonly mastoConverters: MastodonConverters,
	) {}

	public register(fastify: FastifyInstance): void {
		fastify.get<{ Querystring: TimelineArgs }>('/v1/timelines/public', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);
			const query = parseTimelineArgs(request.query);
			const data = toBoolean(request.query.local)
				? await client.getLocalTimeline(query)
				: await client.getPublicTimeline(query);
			const response = await promiseMap(sortNewestFirst(data.data), async (status: Entity.Status) => await this.mastoConverters.convertStatus(status, me), { limiter: 4 });

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Querystring: TimelineArgs }>('/v1/timelines/home', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);
			const query = parseTimelineArgs(request.query);
			const data = await client.getHomeTimeline(query);
			const response = await promiseMap(sortNewestFirst(data.data), async (status: Entity.Status) => await this.mastoConverters.convertStatus(status, me), { limiter: 4 });

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Params: { hashtag?: string }, Querystring: TimelineArgs }>('/v1/timelines/tag/:hashtag', async (request, reply) => {
			if (!request.params.hashtag) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "hashtag"' });

			const { client, me } = await this.clientService.getAuthClient(request);
			const query = parseTimelineArgs(request.query);
			const data = await client.getTagTimeline(request.params.hashtag, query);
			const response = await promiseMap(sortNewestFirst(data.data), async (status: Entity.Status) => await this.mastoConverters.convertStatus(status, me), { limiter: 4 });

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string }, Querystring: TimelineArgs }>('/v1/timelines/list/:id', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(request);
			const query = parseTimelineArgs(request.query);
			const data = await client.getListTimeline(request.params.id, query);
			const response = await promiseMap(sortNewestFirst(data.data), async (status: Entity.Status) => await this.mastoConverters.convertStatus(status, me), { limiter: 4 });

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Querystring: TimelineArgs }>('/v1/conversations', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);
			const query = parseTimelineArgs(request.query);
			const data = await client.getConversationTimeline(query);
			const response = await promiseMap(sortNewestFirst(data.data), async (conversation: Entity.Conversation) => await this.mastoConverters.convertConversation(conversation, me), { limiter: 4 });

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.post<{ Params: { id: string } }>('/v1/conversations/:id/read', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);
			const data = await client.readConversation(request.params.id);
			return reply.send(await this.mastoConverters.convertConversation(data.data, me));
		});

		// A conversation is a direct note of someone, which cannot be hidden from the list
		fastify.delete('/v1/conversations/:id', async (_request, reply) => {
			return reply.code(422).send({ error: 'Removing conversations is not supported by this server' });
		});

		fastify.get<{ Params: { name: string } }>('/v1/tags/:name', async (request, reply) => {
			const client = this.clientService.getClient(request);
			return reply.send((await client.getTag(request.params.name)).data);
		});

		// Misskey has no hashtag following, and pretending to follow would leave the home timeline without the hashtag
		for (const path of ['/v1/tags/:name/follow', '/v1/tags/:name/unfollow']) {
			fastify.post(path, async (_request, reply) => {
				return reply.code(422).send({ error: 'Following hashtags is not supported by this server' });
			});
		}

		// Trending links are not tracked, so no statuses share them
		fastify.get('/v1/timelines/link', async (_request, reply) => {
			return reply.send([]);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/lists/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getList(_request.params.id);
			const response = convertList(data.data);

			return reply.send(response);
		});

		fastify.get('/v1/lists', async (request, reply) => {
			const client = this.clientService.getClient(request);
			const data = await client.getLists();
			const response = data.data.map((list: Entity.List) => convertList(list));

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string }, Querystring: TimelineArgs }>('/v1/lists/:id/accounts', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(request);
			const data = await client.getAccountsInList(request.params.id, parseTimelineArgs(request.query));
			const response = await promiseMap(data.data, async (account: Entity.Account) => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.post<ListAccountsRoute>('/v1/lists/:id/accounts', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			const accountIds = getListAccountIds(_request);
			if (accountIds.length === 0) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "account_ids"' });

			const client = this.clientService.getClient(_request);
			const data = await client.addAccountsToList(_request.params.id, accountIds);

			return reply.send(data.data);
		});

		fastify.delete<ListAccountsRoute>('/v1/lists/:id/accounts', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			const accountIds = getListAccountIds(_request);
			if (accountIds.length === 0) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "account_ids"' });

			const client = this.clientService.getClient(_request);
			const data = await client.deleteAccountsFromList(_request.params.id, accountIds);

			return reply.send(data.data);
		});

		fastify.post<{ Body: { title?: string } }>('/v1/lists', async (_request, reply) => {
			if (!_request.body.title) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "title"' });

			const client = this.clientService.getClient(_request);
			const data = await client.createList(_request.body.title);
			const response = convertList(data.data);

			return reply.send(response);
		});

		fastify.put<{ Params: { id?: string }, Body: { title?: string } }>('/v1/lists/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			if (!_request.body.title) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "title"' });

			const client = this.clientService.getClient(_request);
			const data = await client.updateList(_request.params.id, _request.body.title);
			const response = convertList(data.data);

			return reply.send(response);
		});

		fastify.delete<{ Params: { id?: string } }>('/v1/lists/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			await client.deleteList(_request.params.id);

			return reply.send({});
		});
	}
}
