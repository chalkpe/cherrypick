/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { RoleService } from '@/core/RoleService.js';
import type { MiLocalUser } from '@/models/User.js';
import { attachMinMaxPagination, attachOffsetPagination } from '@/server/api/mastodon/pagination.js';
import { promiseMap } from '@/misc/promise-map.js';
import { MastodonConverters } from '../MastodonConverters.js';
import { parseTimelineArgs, TimelineArgs, toBoolean, toInt } from '../argsUtils.js';
import type { FastifyInstance } from 'fastify';
import { Converter } from 'megalodon';
import type { Entity, MisskeyEntity } from 'megalodon';

interface ApiSearchMastodonRoute {
	Querystring: TimelineArgs & {
		type?: string;
		q?: string;
		resolve?: string;
	}
}

@Injectable()
export class ApiSearchMastodon {
	constructor(
		private readonly mastoConverters: MastodonConverters,
		private readonly clientService: MastodonClientService,
		private readonly roleService: RoleService,
	) {}

	/**
	 * Whether statuses can be searched for the query.
	 * Misskey leaves note search to a role policy, which is off for regular users by default, while Mastodon has no such limit.
	 * Without it the search returns no statuses rather than failing as a whole. Looking up a status by its URL is always allowed.
	 */
	private async canSearchStatuses(q: string, me: MiLocalUser | null): Promise<boolean> {
		if (/^https?:\/\//.test(q)) return true;
		return (await this.roleService.getUserPolicies(me?.id ?? null)).canSearchNotes;
	}

	public register(fastify: FastifyInstance): void {
		fastify.get<ApiSearchMastodonRoute>('/v1/search', async (request, reply) => {
			if (!request.query.q) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "q"' });
			if (!request.query.type) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "type"' });

			const type = request.query.type;
			if (type !== 'hashtags' && type !== 'statuses' && type !== 'accounts') {
				return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Invalid type' });
			}

			const { client, me } = await this.clientService.getAuthClient(request);

			if (toBoolean(request.query.resolve) && !me) {
				return reply.code(401).send({ error: 'The access token is invalid', error_description: 'Authentication is required to use the "resolve" property' });
			}
			if (toInt(request.query.offset) && !me) {
				return reply.code(401).send({ error: 'The access token is invalid', error_description: 'Authentication is required to use the "offset" property' });
			}

			// resolve lets the search look up accounts and statuses of other servers that this one does not know yet
			const query = { ...parseTimelineArgs(request.query), resolve: toBoolean(request.query.resolve) };
			const { data } = type === 'statuses' && !await this.canSearchStatuses(request.query.q, me)
				? { data: { accounts: [], statuses: [], hashtags: [] } }
				: await client.search(request.query.q, { type, ...query });
			const response = {
				...data,
				accounts: await promiseMap(data.accounts, (account: Entity.Account) => this.mastoConverters.convertAccount(account), { limiter: 3 }),
				statuses: await promiseMap(data.statuses, (status: Entity.Status) => this.mastoConverters.convertStatus(status, me), { limiter: 3 }),
			};

			if (type === 'hashtags') {
				attachOffsetPagination(request, reply, response.hashtags, this.clientService.getPublicBaseUrl());
			} else {
				attachMinMaxPagination(request, reply, response[type], this.clientService.getPublicBaseUrl());
			}

			return reply.send(response);
		});

		fastify.get<ApiSearchMastodonRoute>('/v2/search', async (request, reply) => {
			if (!request.query.q) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "q"' });

			const type = request.query.type;
			if (type !== undefined && type !== 'hashtags' && type !== 'statuses' && type !== 'accounts') {
				return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Invalid type' });
			}

			const { client, me } = await this.clientService.getAuthClient(request);

			if (toBoolean(request.query.resolve) && !me) {
				return reply.code(401).send({ error: 'The access token is invalid', error_description: 'Authentication is required to use the "resolve" property' });
			}
			if (toInt(request.query.offset) && !me) {
				return reply.code(401).send({ error: 'The access token is invalid', error_description: 'Authentication is required to use the "offset" property' });
			}

			// resolve lets the search look up accounts and statuses of other servers that this one does not know yet
			const query = { ...parseTimelineArgs(request.query), resolve: toBoolean(request.query.resolve) };
			const q = request.query.q;
			const searchStatuses = (!type || type === 'statuses') && await this.canSearchStatuses(q, me);
			const [acct, stat, tags] = await Promise.all([
				!type || type === 'accounts' ? client.search(q, { type: 'accounts', ...query }) : null,
				searchStatuses ? client.search(q, { type: 'statuses', ...query }) : null,
				!type || type === 'hashtags' ? client.search(q, { type: 'hashtags', ...query }) : null,
			]);
			const response = {
				accounts: acct ? await promiseMap(acct.data.accounts, async (account: Entity.Account) => await this.mastoConverters.convertAccount(account), { limiter: 3 }) : [],
				statuses: stat ? await promiseMap(stat.data.statuses, async (status: Entity.Status) => await this.mastoConverters.convertStatus(status, me), { limiter: 3 }) : [],
				hashtags: tags?.data.hashtags ?? [],
			};

			// Pagination hack, based on "best guess" expected behavior.
			// Mastodon doesn't document this part at all!
			const longestResult = [response.statuses, response.hashtags]
				.reduce((longest: unknown[], current: unknown[]) => current.length > longest.length ? current : longest, response.accounts);

			// Ignore min/max pagination because how TF would that work with multiple result sets??
			// Offset pagination is the only possible option
			attachOffsetPagination(request, reply, longestResult, this.clientService.getPublicBaseUrl());

			return reply.send(response);
		});

		// Trending statuses are ranked rather than ordered by ID, so they are paginated by offset as on Mastodon
		fastify.get<ApiSearchMastodonRoute>('/v1/trends/statuses', async (request, reply) => {
			const args = parseTimelineArgs(request.query);
			const limit = Math.min(Math.max(args.limit ?? 20, 1), 40);
			const offset = Math.max(args.offset ?? 0, 0);
			const data = offset < 100
				? await this.clientService.callApi<MisskeyEntity.Note[]>(request, 'notes/featured', { limit: Math.min(offset + limit, 100) })
				: [];
			const me = await this.clientService.getAuth(request);
			const baseUrl = this.clientService.getPublicBaseUrl();
			const response = await promiseMap(data.slice(offset, offset + limit), async note => await this.mastoConverters.convertStatus(Converter.note(note, baseUrl), me), { limiter: 4 });

			attachOffsetPagination(request, reply, response, baseUrl);
			return reply.send(response);
		});

		// Mastodon 2.x suggestions are plain accounts
		fastify.get<ApiSearchMastodonRoute>('/v1/suggestions', async (request, reply) => {
			const data = await this.clientService.callApi<Entity.Account[]>(request, 'users', {
				limit: parseTimelineArgs(request.query).limit ?? 20,
				origin: 'local',
				sort: '+follower',
				state: 'alive',
			});
			const response = await promiseMap(data, async account => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			return reply.send(response);
		});

		// Suggestions are the most followed local accounts, which cannot be dismissed one by one
		fastify.delete('/v1/suggestions/:id', async (_request, reply) => {
			return reply.send({});
		});

		fastify.get<ApiSearchMastodonRoute>('/v2/suggestions', async (request, reply) => {
			const data = await this.clientService.callApi<Entity.Account[]>(request, 'users', {
				limit: parseTimelineArgs(request.query).limit ?? 20,
				origin: 'local',
				sort: '+follower',
				state: 'alive',
			});
			const response = await promiseMap(data, async entry => ({
				source: 'global',
				account: await this.mastoConverters.convertAccount(entry),
			}), {
				limiter: 4,
			});

			attachOffsetPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});
	}
}
