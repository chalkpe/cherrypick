/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { parseTimelineArgs, TimelineArgs, toBoolean, toInt, unflattenFormBody } from '@/server/api/mastodon/argsUtils.js';
import { isVisibility, MastodonPreferenceService } from '@/server/api/mastodon/MastodonPreferenceService.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { readSavedRequestFile } from '@/server/api/mastodon/MastodonServerUtilityService.js';
import { CacheService } from '@/core/CacheService.js';
import { attachMinMaxPagination, sortNewestFirst } from '@/server/api/mastodon/pagination.js';
import { promiseMap } from '@/misc/promise-map.js';
import type { FollowRequestsRepository, FollowingsRepository, UserMemoRepository } from '@/models/_.js';
import { MiUserProfile } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { MastodonConverters, convertRelationship, convertFeaturedTag, convertList } from '../MastodonConverters.js';
import type { Misskey, MastodonEntity, Entity } from 'megalodon';
import type { FastifyInstance } from 'fastify';

interface ApiAccountMastodonRoute {
	Params: { id?: string },
	Querystring: TimelineArgs & { acct?: string },
	Body?: { notifications?: boolean }
}

interface FollowOptionsRoute {
	Params: { id?: string },
	Body?: { reblogs?: string | boolean, notify?: string | boolean },
}

function toFlag(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : typeof value === 'string' ? toBoolean(value) : undefined;
}

function toText(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * Browsers turn line breaks into CRLF when they encode multipart forms, while Misskey keeps LF.
 */
function toMultilineText(value: unknown): string | undefined {
	return toText(value)?.replace(/\r\n?/g, '\n');
}

/**
 * Profile fields arrive as an array from JSON clients, and as an object keyed by index from "fields_attributes[0][name]" forms.
 */
function toProfileFields(value: unknown): { name: string, value: string }[] | undefined {
	if (value == null || typeof value !== 'object') return undefined;
	const items = Array.isArray(value) ? value : Object.values(value);
	return items
		.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
		.map(item => ({ name: toText(item.name) ?? '', value: toText(item.value) ?? '' }));
}

@Injectable()
export class ApiAccountMastodon {
	constructor(
		@Inject(DI.followingsRepository)
		private readonly followingsRepository: FollowingsRepository,

		@Inject(DI.userMemosRepository)
		private readonly userMemosRepository: UserMemoRepository,

		@Inject(DI.followRequestsRepository)
		private readonly followRequestsRepository: FollowRequestsRepository,

		private readonly clientService: MastodonClientService,
		private readonly mastoConverters: MastodonConverters,
		private readonly cacheService: CacheService,
		private readonly preferenceService: MastodonPreferenceService,
	) {}

	/**
	 * The current user as a CredentialAccount, with the source of the profile.
	 */
	private async getCredentialAccount(client: Misskey, account?: Entity.Account): Promise<MastodonEntity.Account & { source: MastodonEntity.Source }> {
		const user = account ?? (await client.verifyAccountCredentials()).data;
		const [acct, profile, privacy, followRequestsCount] = await Promise.all([
			// The account is the viewer's own, whose follower counts are always visible to them
			this.mastoConverters.convertAccount(user, { id: user.id } as MiLocalUser),
			this.cacheService.userProfileCache.fetch(user.id).catch(() => null),
			this.preferenceService.getDefaultVisibility(user.id),
			this.followRequestsRepository.countBy({ followeeId: user.id }),
		]);
		return Object.assign({}, acct, {
			// Profile editors send these back as they are, so they must be the raw text rather than rendered HTML
			source: {
				note: profile?.description ?? '',
				fields: profile?.fields.map(f => ({ name: f.name, value: f.value, verified_at: null })) ?? [],
				privacy,
				sensitive: profile?.alwaysMarkNsfw ?? false,
				language: profile?.lang ?? '',
				follow_requests_count: followRequestsCount,
			},
		});
	}

	/**
	 * Adds what users/relation leaves out: the private note, and whether the domain of the account is blocked (a Misskey instance mute).
	 */
	private async completeRelationships(me: MiLocalUser | null, relationships: MastodonEntity.Relationship[]): Promise<MastodonEntity.Relationship[]> {
		if (me == null || relationships.length === 0) return relationships;

		const ids = relationships.map(r => r.id);
		const [memos, profile, users] = await Promise.all([
			this.userMemosRepository.findBy({ userId: me.id, targetUserId: In(ids) }),
			this.cacheService.userProfileCache.fetch(me.id),
			Promise.all(ids.map(id => this.cacheService.findUserById(id).catch(() => null))),
		]);
		return relationships.map((r, i) => ({
			...r,
			note: memos.find(m => m.targetUserId === r.id)?.memo ?? '',
			domain_blocking: users[i]?.host != null && profile.mutedInstances.includes(users[i].host),
		}));
	}

	public register(fastify: FastifyInstance): void {
		fastify.get<ApiAccountMastodonRoute>('/v1/accounts/verify_credentials', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			return reply.send(await this.getCredentialAccount(client));
		});

		fastify.patch<{ Body?: Record<string, unknown> }>('/v1/accounts/update_credentials', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			// The default visibility is written here rather than through the Misskey API, so its permission is checked here
			const me = await this.clientService.requireAuth(_request, 'write:account');
			// Multipart and form clients send "fields_attributes[0][name]" and "source[privacy]", and a request carrying only the images has no fields
			const body = unflattenFormBody(_request.body ?? {});
			const source = (body.source != null && typeof body.source === 'object' ? body.source : {}) as Record<string, unknown>;

			// Upload the avatar and header images to the user's drive first, then set them by ID.
			// They go through the Misskey API, so the token's permissions apply as for any other upload.
			const images: { avatar?: string, header?: string } = {};
			for (const field of ['avatar', 'header'] as const) {
				const file = _request.savedRequestFiles?.find(obj => obj.fieldname === field);
				if (!file) continue;

				const upload = await client.uploadMedia(await readSavedRequestFile(file));
				if (upload.data.type === 'image' || upload.data.type === 'gifv') {
					images[field] = upload.data.id;
				}
			}

			let fields = toProfileFields(body.fields_attributes);
			if (fields) {
				for (const field of fields) {
					if (!(field.name.trim() === '' && field.value.trim() === '')) {
						if (field.name.trim() === '') return reply.code(422).send({ error: 'Validation failed: Field name can\'t be blank' });
						if (field.value.trim() === '') return reply.code(422).send({ error: 'Validation failed: Field value can\'t be blank' });
					}
				}
				fields = fields.filter(field => field.name.trim().length > 0 && field.value.length > 0);
			}

			// The default visibility is not a Misskey profile setting
			const privacy = source.privacy;
			if (isVisibility(privacy)) {
				await this.preferenceService.setDefaultVisibility(me.id, privacy);
			}

			const data = await client.updateCredentials({
				display_name: toText(body.display_name),
				note: toMultilineText(body.note),
				...images,
				discoverable: toFlag(body.discoverable),
				bot: toFlag(body.bot),
				locked: toFlag(body.locked),
				hide_collections: toFlag(body.hide_collections),
				fields_attributes: fields,
				source: {
					sensitive: toFlag(source.sensitive),
					language: toText(source.language),
				},
			});
			// Mastodon answers with the CredentialAccount, which profile editors read the source from again
			return reply.send(await this.getCredentialAccount(client, data.data));
		});

		// Mastodon 4.2+ removes the avatar or header image of the current user
		for (const [path, field] of [['/v1/profile/avatar', 'avatarId'], ['/v1/profile/header', 'bannerId']] as const) {
			fastify.delete(path, async (request, reply) => {
				const client = this.clientService.getClient(request);
				await client.callApi('/api/i/update', { [field]: null });
				return reply.send(await this.getCredentialAccount(client));
			});
		}

		fastify.get<{ Querystring: { acct?: string } }>('/v1/accounts/lookup', async (_request, reply) => {
			if (!_request.query.acct) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "acct"' });

			// Accept only the exact account: the search falls back to a fuzzy user search when there is none
			const localHost = new URL(this.clientService.getPublicBaseUrl()).host.toLowerCase();
			const [username, host] = _request.query.acct.replace(/^@/, '').toLowerCase().split('@');
			const wanted = host && host !== localHost ? `${username}@${host}` : username;

			const client = this.clientService.getClient(_request);
			const data = await client.search(_request.query.acct, { type: 'accounts' });
			const account = data.data.accounts.find(a => a.acct.toLowerCase() === wanted);
			if (!account) return reply.code(404).send({ error: 'Record not found' });

			const response = await this.mastoConverters.convertAccount(account);

			return reply.send(response);
		});

		fastify.get<ApiAccountMastodonRoute & { Querystring: { id?: string | string[] } }>('/v1/accounts/relationships', async (_request, reply) => {
			if (!_request.query.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.getRelationships(_request.query.id);
			const response = await this.completeRelationships(me, data.data.map(relationship => convertRelationship(relationship)));

			return reply.send(response);
		});

		// Accounts followed by the current user that also follow each given account
		fastify.get<{ Querystring: { id?: string | string[] } }>('/v1/accounts/familiar_followers', async (request, reply) => {
			const me = await this.clientService.requireAuth(request, 'read:following');

			const ids = request.query.id == null ? [] : Array.isArray(request.query.id) ? request.query.id : [request.query.id];
			const myFollowings = await this.cacheService.userFollowingsCache.fetch(me.id);
			const response = await promiseMap(ids, async id => {
				// Whether the user may see the follower list of the account, as users/followers decides it
				const followersVisibility = id === me.id ? 'public' : (await this.cacheService.userProfileCache.fetch(id).catch(() => null))?.followersVisibility;
				const seesFollowers = followersVisibility === 'public' || (followersVisibility === 'followers' && Object.hasOwn(myFollowings, id));

				const query = this.followingsRepository.createQueryBuilder('following')
					.select('following.followerId', 'followerId')
					.where('following.followeeId = :id', { id })
					.andWhere(`following.followerId IN (${
						this.followingsRepository.createQueryBuilder('mine').select('mine.followeeId').where('mine.followerId = :meId').getQuery()
					})`, { meId: me.id });
				if (!seesFollowers) {
					// The relationship is then only known from the follow list of the follower, whom the user follows,
					// so it stays hidden when that list is private
					query
						.innerJoin(MiUserProfile, 'profile', 'profile.userId = following.followerId')
						.andWhere('profile.followingVisibility != \'private\'');
				}
				const followers = await query.limit(10).getRawMany<{ followerId: string }>();
				const users = (await Promise.all(followers.map(f => this.cacheService.findUserById(f.followerId).catch(() => null)))).filter(u => u != null);
				return { id, accounts: await promiseMap(users, async u => await this.mastoConverters.convertAccount(u), { limiter: 2 }) };
			}, { limiter: 2 });

			return reply.send(response);
		});

		fastify.get<{ Querystring: { q: string; limit?: string; offset?: string; resolve?: string; following?: string; } }>('/v1/accounts/search', async (request, reply) => {
			if (!request.query.q) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required property "q"' });

			const client = this.clientService.getClient(request);

			const limit = request.query.limit ? parseInt(request.query.limit) : 40;

			const options = {
				following: toBoolean(request.query.following),
				limit,
				resolve: toBoolean(request.query.resolve),
			};

			const data = await client.searchAccount(request.query.q, options);
			const response = await Promise.all(data.data.map(async (account) => await this.mastoConverters.convertAccount(account)));

			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/accounts/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.getAccount(_request.params.id);
			const account = await this.mastoConverters.convertAccount(data.data, me);

			return reply.send(account);
		});

		fastify.get<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/statuses', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(request);
			const args = parseTimelineArgs(request.query);
			const data = await client.getAccountStatuses(request.params.id, args);
			// Pinned statuses keep the order the user pinned them in
			const statuses = args.pinned ? data.data : sortNewestFirst(data.data);
			const response = await this.mastoConverters.convertStatuses(statuses, me, 2);

			// Pinned statuses are returned at once. The others are paginated by the fetched page, as statuses the viewer cannot see may leave nothing of it.
			if (!args.pinned) attachMinMaxPagination(request, reply, statuses, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/accounts/:id/featured_tags', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getFeaturedTags();
			const response = data.data.map((tag) => convertFeaturedTag(tag));

			return reply.send(response);
		});

		fastify.get<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/followers', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(request);
			const data = await client.getAccountFollowers(
				request.params.id,
				parseTimelineArgs(request.query),
			);
			const response = await promiseMap(data.data, async account => await this.mastoConverters.convertAccount(account), { limiter: 2 });

			// Misskey paginates by the follow relations rather than by the accounts
			attachMinMaxPagination(request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/following', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(request);
			const data = await client.getAccountFollowing(
				request.params.id,
				parseTimelineArgs(request.query),
			);
			const response = await promiseMap(data.data, async account => await this.mastoConverters.convertAccount(account), { limiter: 2 });

			// Misskey paginates by the follow relations rather than by the accounts
			attachMinMaxPagination(request, reply, data.pageIds, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/accounts/:id/lists', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getAccountLists(_request.params.id);
			const response = data.data.map((list) => convertList(list));

			return reply.send(response);
		});

		fastify.post<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/follow', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const body = (_request.body ?? {}) as FollowOptionsRoute['Body'] & object;
			const { client, me } = await this.clientService.getAuthClient(_request);
			// Following again changes whether boosts are shown and new posts are notified
			const data = await client.followAccount(_request.params.id, { reblogs: toFlag(body.reblogs), notify: toFlag(body.notify) });
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string }, Body?: { comment?: string } }>('/v1/accounts/:id/note', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(request);
			await client.callApi('/api/users/update-memo', { userId: request.params.id, memo: request.body?.comment ?? '' });
			const data = await client.getRelationship(request.params.id);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/accounts/:id/remove_from_followers', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(request);
			// Misskey fails when the account does not follow, while Mastodon returns the relationship as it is
			if ((await client.getRelationship(request.params.id)).data.followed_by) {
				await client.callApi('/api/following/invalidate', { userId: request.params.id });
			}
			const data = await client.getRelationship(request.params.id);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		// Misskey has no featured accounts or featured hashtags of its own
		fastify.get('/v1/endorsements', async (_request, reply) => reply.send([]));
		fastify.get('/v1/featured_tags', async (_request, reply) => reply.send([]));
		fastify.get('/v1/featured_tags/suggestions', async (_request, reply) => reply.send([]));
		fastify.post('/v1/featured_tags', async (_request, reply) => {
			return reply.code(422).send({ error: 'Featured hashtags are not supported by this server' });
		});

		// The profile directory, backed by the Misskey user list
		fastify.get<{ Querystring: { limit?: string, offset?: string, order?: string, local?: string } }>('/v1/directory', async (request, reply) => {
			const limit = Math.min(Math.max(toInt(request.query.limit) ?? 40, 1), 80);
			const data = await this.clientService.callApi<Entity.Account[]>(request, 'users', {
				limit,
				offset: toInt(request.query.offset) ?? 0,
				sort: request.query.order === 'new' ? '+createdAt' : '+updatedAt',
				origin: toBoolean(request.query.local) ? 'local' : 'combined',
				state: 'alive',
			});
			const response = await promiseMap(data, async account => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			return reply.send(response);
		});

		fastify.post<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/unfollow', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const me = await this.clientService.getAuth(_request);
			const data = await client.unfollowAccount(_request.params.id);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		fastify.post<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/block', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const me = await this.clientService.getAuth(_request);
			const data = await client.blockAccount(_request.params.id);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		fastify.post<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/unblock', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const me = await this.clientService.getAuth(_request);
			const data = await client.unblockAccount(_request.params.id);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string }, Body?: { notifications?: string | boolean, duration?: string | number } }>('/v1/accounts/:id/mute', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const me = await this.clientService.getAuth(_request);
			// Clients may send no body at all
			const duration = _request.body?.duration;
			const data = await client.muteAccount(
				_request.params.id,
				toFlag(_request.body?.notifications) ?? true,
				{ duration: typeof duration === 'number' ? duration : toInt(duration) },
			);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});

		fastify.post<ApiAccountMastodonRoute & { Params: { id?: string } }>('/v1/accounts/:id/unmute', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const me = await this.clientService.getAuth(_request);
			const data = await client.unmuteAccount(_request.params.id);
			const [response] = await this.completeRelationships(me, [convertRelationship(data.data)]);

			return reply.send(response);
		});
	}
}
