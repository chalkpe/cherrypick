/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { toBoolean, toInt, unflattenFormBody } from '@/server/api/mastodon/argsUtils.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { FilterNotFoundError, MastodonFilterService } from '@/server/api/mastodon/MastodonFilterService.js';
import type { FilterInput } from '@/server/api/mastodon/MastodonFilterService.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MastodonEntity } from 'megalodon';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface FilterParams {
	Params: { id: string },
	Body?: Record<string, unknown>,
	Querystring: Record<string, unknown>,
}

class FilterInputError extends Error {
	override name = this.constructor.name;
}

function toText(value: unknown): string | undefined {
	return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function toFlag(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : toBoolean(toText(value));
}

function toTextList(value: unknown): string[] | undefined {
	if (value == null) return undefined;
	const list = Array.isArray(value) ? value : [value];
	return list.map(toText).filter(v => v != null);
}

/**
 * keywords_attributes arrive as an array from JSON clients, and as an object keyed by index from "keywords_attributes[0][keyword]" forms.
 */
function toKeywordChanges(value: unknown): NonNullable<FilterInput['keywords']> {
	if (value == null || typeof value !== 'object') return [];
	const items = Array.isArray(value) ? value : Object.values(value);
	return items
		.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
		.map(item => ({
			id: toText(item.id),
			keyword: toText(item.keyword) ?? '',
			wholeWord: toFlag(item.whole_word) ?? false,
			destroy: toFlag(item._destroy) ?? false,
		}));
}

function toFilterInput(body: Record<string, unknown>): FilterInput {
	const action = toText(body.filter_action);
	const expiresIn = toText(body.expires_in);
	return {
		title: toText(body.title),
		context: toTextList(body.context),
		action: action === 'hide' || action === 'warn' || action === 'blur' ? action : undefined,
		// An empty expires_in removes the expiry
		expiresIn: expiresIn === undefined ? undefined : (toInt(expiresIn) ?? null),
		keywords: toKeywordChanges(body.keywords_attributes),
	};
}

/**
 * A v1 filter is a single keyword of a v2 filter.
 */
function toV1(filter: MastodonEntity.FilterV2, keyword: MastodonEntity.FilterKeyword): MastodonEntity.Filter {
	return {
		id: keyword.id,
		phrase: keyword.keyword,
		context: filter.context,
		expires_at: filter.expires_at,
		irreversible: filter.filter_action === 'hide',
		whole_word: keyword.whole_word,
	};
}

@Injectable()
export class ApiFilterMastodon {
	constructor(
		private readonly clientService: MastodonClientService,
		private readonly filterService: MastodonFilterService,
	) {}

	private async requireMe(request: FastifyRequest, reply: FastifyReply): Promise<MiLocalUser | null> {
		const me = await this.clientService.getAuth(request);
		if (me == null) reply.code(401).send({ error: 'The access token is invalid' });
		return me;
	}

	/**
	 * Runs a filter operation, answering 404 for unknown filters and keywords as Mastodon does.
	 */
	private async withFilters<T>(request: FastifyRequest, reply: FastifyReply, run: (me: MiLocalUser, body: Record<string, unknown>) => Promise<T>): Promise<FastifyReply> {
		const me = await this.requireMe(request, reply);
		if (me == null) return reply;

		// Some clients, such as Ice Cubes, send keywords as query parameters
		const body = { ...(request.query as Record<string, unknown>), ...unflattenFormBody((request.body ?? {}) as Record<string, unknown>) };
		try {
			return reply.send(await run(me, body));
		} catch (err) {
			if (err instanceof FilterNotFoundError) return reply.code(404).send({ error: 'Record not found' });
			if (err instanceof FilterInputError) return reply.code(422).send({ error: err.message });
			throw err;
		}
	}

	public register(fastify: FastifyInstance): void {
		this.registerV2(fastify);
		this.registerV1(fastify);
	}

	private registerV2(fastify: FastifyInstance): void {
		fastify.get('/v2/filters', async (request, reply) => {
			return await this.withFilters(request, reply, me => this.filterService.list(me, request));
		});

		fastify.post<FilterParams>('/v2/filters', async (request, reply) => {
			return await this.withFilters(request, reply, (me, body) => this.filterService.create(me, request, toFilterInput(body)));
		});

		fastify.get<FilterParams>('/v2/filters/keywords/:id', async (request, reply) => {
			return await this.withFilters(request, reply, async me => (await this.filterService.findByKeyword(me, request, request.params.id)).keyword);
		});

		fastify.put<FilterParams>('/v2/filters/keywords/:id', async (request, reply) => {
			return await this.withFilters(request, reply, async (me, body) => {
				const { filter, keyword } = await this.filterService.findByKeyword(me, request, request.params.id);
				const updated = await this.filterService.update(me, request, filter.id, {
					keywords: [{ id: keyword.id, keyword: toText(body.keyword) ?? keyword.keyword, wholeWord: toFlag(body.whole_word) ?? keyword.whole_word }],
				});
				return updated.keywords.find(k => k.id === keyword.id) ?? updated.keywords.at(-1);
			});
		});

		fastify.delete<FilterParams>('/v2/filters/keywords/:id', async (request, reply) => {
			return await this.withFilters(request, reply, async me => {
				const { filter, keyword } = await this.filterService.findByKeyword(me, request, request.params.id);
				await this.filterService.update(me, request, filter.id, { keywords: [{ id: keyword.id, keyword: keyword.keyword, wholeWord: keyword.whole_word, destroy: true }] });
				return {};
			});
		});

		fastify.get<FilterParams>('/v2/filters/:id', async (request, reply) => {
			return await this.withFilters(request, reply, me => this.filterService.get(me, request, request.params.id));
		});

		fastify.put<FilterParams>('/v2/filters/:id', async (request, reply) => {
			return await this.withFilters(request, reply, (me, body) => this.filterService.update(me, request, request.params.id, toFilterInput(body)));
		});

		fastify.delete<FilterParams>('/v2/filters/:id', async (request, reply) => {
			return await this.withFilters(request, reply, async me => {
				await this.filterService.delete(me, request, request.params.id);
				return {};
			});
		});

		fastify.get<FilterParams>('/v2/filters/:id/keywords', async (request, reply) => {
			return await this.withFilters(request, reply, async me => (await this.filterService.get(me, request, request.params.id)).keywords);
		});

		fastify.post<FilterParams>('/v2/filters/:id/keywords', async (request, reply) => {
			return await this.withFilters(request, reply, async (me, body) => {
				const keyword = toText(body.keyword);
				if (!keyword) throw new FilterInputError('Keyword can\'t be blank');
				const updated = await this.filterService.update(me, request, request.params.id, {
					keywords: [{ keyword, wholeWord: toFlag(body.whole_word) ?? false }],
				});
				return updated.keywords.at(-1);
			});
		});

		// Misskey word mutes cannot hold single statuses
		fastify.get<FilterParams>('/v2/filters/:id/statuses', async (request, reply) => {
			return await this.withFilters(request, reply, async me => {
				await this.filterService.get(me, request, request.params.id);
				return [];
			});
		});

		fastify.post<FilterParams>('/v2/filters/:id/statuses', async (_request, reply) => {
			return reply.code(422).send({ error: 'Filtering single statuses is not supported by this server' });
		});
	}

	/**
	 * Legacy filters (Mastodon 3.x), one keyword each.
	 */
	private registerV1(fastify: FastifyInstance): void {
		fastify.get('/v1/filters', async (request, reply) => {
			return await this.withFilters(request, reply, async me => {
				const filters = await this.filterService.list(me, request);
				return filters.flatMap(f => f.keywords.map(k => toV1(f, k)));
			});
		});

		fastify.get<FilterParams>('/v1/filters/:id', async (request, reply) => {
			return await this.withFilters(request, reply, async me => {
				const { filter, keyword } = await this.filterService.findByKeyword(me, request, request.params.id);
				return toV1(filter, keyword);
			});
		});

		fastify.post<FilterParams>('/v1/filters', async (request, reply) => {
			return await this.withFilters(request, reply, async (me, body) => {
				const phrase = toText(body.phrase);
				if (!phrase) throw new FilterInputError('Phrase can\'t be blank');

				const expiresIn = toInt(toText(body.expires_in));
				const created = await this.filterService.create(me, request, {
					title: phrase,
					context: toTextList(body.context),
					action: toFlag(body.irreversible) ? 'hide' : 'warn',
					expiresIn: expiresIn ?? null,
					keywords: [{ keyword: phrase, wholeWord: toFlag(body.whole_word) ?? false }],
				});
				return toV1(created, created.keywords[0]);
			});
		});

		// Mastodon updates v1 filters with PUT. POST is kept for clients written against older versions of this API.
		for (const method of ['PUT', 'POST'] as const) {
			fastify.route<FilterParams>({
				method,
				url: '/v1/filters/:id',
				handler: async (request, reply) => {
					return await this.withFilters(request, reply, async (me, body) => {
						const { filter, keyword } = await this.filterService.findByKeyword(me, request, request.params.id);
						const irreversible = toFlag(body.irreversible);
						const expiresIn = toText(body.expires_in);
						const updated = await this.filterService.update(me, request, filter.id, {
							context: toTextList(body.context),
							action: irreversible === undefined ? undefined : irreversible ? 'hide' : 'warn',
							expiresIn: expiresIn === undefined ? undefined : (toInt(expiresIn) ?? null),
							keywords: [{ id: keyword.id, keyword: toText(body.phrase) ?? keyword.keyword, wholeWord: toFlag(body.whole_word) ?? keyword.whole_word }],
						});
						return toV1(updated, updated.keywords.find(k => k.id === keyword.id) ?? updated.keywords[0]);
					});
				},
			});
		}

		fastify.delete<FilterParams>('/v1/filters/:id', async (request, reply) => {
			return await this.withFilters(request, reply, async me => {
				const { filter, keyword } = await this.filterService.findByKeyword(me, request, request.params.id);
				if (filter.keywords.length <= 1) {
					await this.filterService.delete(me, request, filter.id);
				} else {
					await this.filterService.update(me, request, filter.id, { keywords: [{ id: keyword.id, keyword: keyword.keyword, wholeWord: keyword.whole_word, destroy: true }] });
				}
				return {};
			});
		});
	}
}
