/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Entity, MastodonEntity } from 'megalodon';
import { parseTimelineArgs, TimelineArgs } from '@/server/api/mastodon/argsUtils.js';
import { MastodonConverters } from '@/server/api/mastodon/MastodonConverters.js';
import { MastodonNotificationService } from '@/server/api/mastodon/MastodonNotificationService.js';
import { attachMinMaxPagination, sortNewestFirst } from '@/server/api/mastodon/pagination.js';
import { promiseMap } from '@/misc/promise-map.js';
import type { MiLocalUser } from '@/models/User.js';
import { MastodonClientService } from '../MastodonClientService.js';
import type { FastifyInstance } from 'fastify';

interface ApiNotifyMastodonRoute {
	Params: {
		id?: string,
	},
	Querystring: TimelineArgs,
}

interface NotificationsQuery extends TimelineArgs {
	types?: string | string[];
	exclude_types?: string | string[];
}

interface GroupedNotificationsQuery extends NotificationsQuery {
	grouped_types?: string | string[];
}

interface NotificationGroup {
	group_key: string;
	notifications_count: number;
	type: string;
	most_recent_notification_id: number;
	page_min_id: string;
	page_max_id: string;
	latest_page_notification_at: string;
	sample_account_ids: string[];
	status_id: string | null;
}

// megalodon notification types behind each Mastodon notification type this server sends.
// Misskey reactions are reactions for clients that know them and favourites for the others.
const MEGALODON_TYPES: Record<string, Entity.NotificationType[]> = {
	mention: ['mention'],
	quote: ['quote'],
	reblog: ['reblog'],
	favourite: ['emoji_reaction'],
	reaction: ['emoji_reaction'],
	'pleroma:emoji_reaction': ['emoji_reaction'],
	follow: ['follow'],
	follow_request: ['follow_request'],
	poll: ['poll_expired', 'poll_vote'],
	status: ['status'],
};
const REACTION_TYPES = ['reaction', 'pleroma:emoji_reaction'];
const NOTIFICATION_TYPES = Object.keys(MEGALODON_TYPES);
// Grouped notifications have no reaction type, only favourites
const GROUPED_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter(type => !REACTION_TYPES.includes(type));

// Types Mastodon groups when the client does not say otherwise
const DEFAULT_GROUPED_TYPES = ['favourite', 'reblog', 'follow'];
const MAX_SAMPLE_ACCOUNTS = 8;

function toArray(value: string | string[] | undefined): string[] | undefined {
	if (value == null) return undefined;
	return Array.isArray(value) ? value : [value];
}

/**
 * Whether a Mastodon notification type passes the types[] and exclude_types[] parameters.
 */
function typeFilter(query: NotificationsQuery): (type: string) => boolean {
	const types = toArray(query.types);
	const excludeTypes = toArray(query.exclude_types) ?? [];
	return type => (types == null || types.includes(type)) && !excludeTypes.includes(type);
}

/**
 * megalodon notification types to fetch for the Mastodon types to show.
 * Misskey filters by type before paginating, so pages are not left empty by filtering here.
 */
function toMegalodonTypes(types: string[]): Entity.NotificationType[] {
	return [...new Set(types.flatMap(type => MEGALODON_TYPES[type]))];
}

/**
 * How a client wants reactions and quotes, judging from the types[] it asks for.
 * Clients that list a reaction type get reactions as that type, and the others get them as favourites.
 * Clients that list mentions but not quotes predate Mastodon 4.5 quotes, so quotes come to them as mentions.
 */
function getPresentation(query: NotificationsQuery): { reactionType: string | null, quoteAsMention: boolean } {
	const types = toArray(query.types);
	return {
		// The Pleroma type carries the emoji in the same way, and more clients know it
		reactionType: types?.includes('pleroma:emoji_reaction') ? 'pleroma:emoji_reaction' : types?.includes('reaction') ? 'reaction' : null,
		quoteAsMention: types != null && types.includes('mention') && !types.includes('quote'),
	};
}

function toLimit(value: string | undefined, fallback: number, max: number): number {
	const parsed = value ? parseInt(value, 10) : NaN;
	return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, 1), max);
}

/**
 * Notification types as grouped notification clients expect them.
 * Emoji reactions become favourites, since Mastodon clients have no reaction type.
 */
function toGroupedType(type: string, quoteAsMention: boolean): string {
	if (type === 'reaction') return 'favourite';
	if (type === 'quote' && quoteAsMention) return 'mention';
	return type;
}

@Injectable()
export class ApiNotificationsMastodon {
	constructor(
		private readonly mastoConverters: MastodonConverters,
		private readonly clientService: MastodonClientService,
		private readonly notificationService: MastodonNotificationService,
	) {}

	public register(fastify: FastifyInstance): void {
		fastify.get<{ Querystring: NotificationsQuery }>('/v1/notifications', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);
			const keep = typeFilter(request.query);
			const { reactionType, quoteAsMention } = getPresentation(request.query);
			const wanted = NOTIFICATION_TYPES.filter(keep);
			if (quoteAsMention) wanted.push('quote');

			const data = await client.getNotifications({
				...await this.parsePageArgs(me, request.query),
				types: toMegalodonTypes(wanted),
			});
			const notifications = await promiseMap(sortNewestFirst(data.data), async n => await this.mastoConverters.convertNotification(n, me), { limiter: 4 });
			const response: MastodonEntity.Notification[] = [];
			for (const notification of notifications) {
				// Notifications for inaccessible notes will be null and should be ignored
				if (!notification) continue;

				if (notification.type === 'reaction') {
					if (reactionType) {
						response.push({ ...notification, type: reactionType });
					} else if (keep('favourite')) {
						const { emoji: _emoji, emoji_url: _emojiUrl, ...favourite } = notification;
						response.push({ ...favourite, type: 'favourite' });
					}
				} else if (notification.type === 'quote' && quoteAsMention) {
					response.push({ ...notification, type: 'mention' });
				} else if (keep(notification.type)) {
					response.push(notification);
				}
			}

			// Paginate by the fetched page, as notifications for inaccessible notes may leave nothing of it
			attachMinMaxPagination(request, reply, data.data, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		for (const path of ['/v1/notifications/unread_count', '/v2/notifications/unread_count']) {
			fastify.get<{ Querystring: { limit?: string } }>(path, async (request, reply) => {
				const me = await this.clientService.requireAuth(request, 'read:notifications');

				// Mastodon caps the count, as clients only show a badge
				const limit = toLimit(request.query.limit, 100, 1000);
				return reply.send({ count: await this.notificationService.countUnread(me.id, limit) });
			});
		}

		// Mastodon uses the plural path. The singular one is kept for clients written against Sharkey.
		for (const path of ['/v1/notifications/:id', '/v1/notification/:id']) {
			fastify.get<ApiNotifyMastodonRoute & { Params: { id?: string } }>(path, async (request, reply) => {
				if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

				const me = await this.clientService.requireAuth(request, 'read:notifications');

				const response = await this.notificationService.show(me, request.params.id);
				if (!response) return reply.code(404).send({ error: 'Record not found' });

				return reply.send(response);
			});
		}

		for (const path of ['/v1/notifications/:id/dismiss', '/v1/notification/:id/dismiss']) {
			fastify.post<ApiNotifyMastodonRoute & { Params: { id?: string } }>(path, async (request, reply) => {
				if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

				const me = await this.clientService.requireAuth(request, 'write:notifications');

				await this.notificationService.dismiss(me.id, request.params.id);
				return reply.send({});
			});
		}

		fastify.post<ApiNotifyMastodonRoute>('/v1/notifications/clear', async (_request, reply) => {
			const client = this.clientService.getClient(_request);
			const data = await client.dismissNotifications();

			return reply.send(data.data);
		});

		this.registerGrouped(fastify);
		this.registerFiltering(fastify);
	}

	/**
	 * Notification filtering (Mastodon 4.3). Misskey does not hold back notifications for review, so every policy accepts and no requests exist.
	 */
	private registerFiltering(fastify: FastifyInstance): void {
		const summary = { pending_requests_count: 0, pending_notifications_count: 0 };

		fastify.get('/v2/notifications/policy', async (_request, reply) => {
			return reply.send({
				for_not_following: 'accept',
				for_not_followers: 'accept',
				for_new_accounts: 'accept',
				for_private_mentions: 'accept',
				for_limited_accounts: 'accept',
				summary,
			});
		});

		fastify.get('/v1/notifications/policy', async (_request, reply) => {
			return reply.send({
				filter_not_following: false,
				filter_not_followers: false,
				filter_new_accounts: false,
				filter_private_mentions: false,
				summary,
			});
		});

		for (const path of ['/v1/notifications/policy', '/v2/notifications/policy']) {
			fastify.patch(path, async (_request, reply) => {
				return reply.code(422).send({ error: 'Filtering notifications is not supported by this server' });
			});
		}

		fastify.get('/v1/notifications/requests', async (_request, reply) => reply.send([]));
		fastify.get('/v1/notifications/requests/merged', async (_request, reply) => reply.send({ merged: true }));
		for (const path of ['/v1/notifications/requests/accept', '/v1/notifications/requests/dismiss']) {
			fastify.post(path, async (_request, reply) => reply.send({}));
		}
		fastify.get('/v1/notifications/requests/:id', async (_request, reply) => reply.code(404).send({ error: 'Record not found' }));
		for (const path of ['/v1/notifications/requests/:id/accept', '/v1/notifications/requests/:id/dismiss']) {
			fastify.post(path, async (_request, reply) => reply.code(404).send({ error: 'Record not found' }));
		}
	}

	/**
	 * Grouped notifications (Mastodon 4.3+, /api/v2/notifications)
	 */
	private registerGrouped(fastify: FastifyInstance): void {
		fastify.get<{ Querystring: GroupedNotificationsQuery }>('/v2/notifications', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);

			const keep = typeFilter(request.query);
			const { quoteAsMention } = getPresentation(request.query);
			const groupedTypes = toArray(request.query.grouped_types) ?? DEFAULT_GROUPED_TYPES;
			const limit = toLimit(request.query.limit, 40, 80);
			const wanted = GROUPED_NOTIFICATION_TYPES.filter(keep);
			if (quoteAsMention) wanted.push('quote');

			const data = await client.getNotifications({
				...await this.parsePageArgs(me, request.query),
				limit,
				types: toMegalodonTypes(wanted),
			});
			const converted = await promiseMap(sortNewestFirst(data.data), async n => await this.mastoConverters.convertNotification(n, me), { limiter: 4 });
			const notifications = converted
				.filter(n => n != null)
				.map(n => ({ ...n, type: toGroupedType(n.type, quoteAsMention) }))
				.filter(n => keep(n.type));

			// Notifications arrive newest first, so the first one of each group is its most recent
			const groups = new Map<string, NotificationGroup>();
			const accounts = new Map<string, MastodonEntity.Account>();
			const statuses = new Map<string, MastodonEntity.Status>();
			for (const notification of notifications) {
				const statusId = notification.status?.id ?? null;
				const groupable = groupedTypes.includes(notification.type) && (notification.type === 'follow' || statusId != null);
				const bucket = groupable ? `${notification.type}-${statusId ?? ''}` : `ungrouped-${notification.id}`;

				let group = groups.get(bucket);
				if (group == null) {
					group = {
						// The most recent notification ID lets the group be looked up again later
						group_key: groupable ? `${notification.type}-${statusId ?? '0'}-${notification.id}` : `ungrouped-${notification.id}`,
						notifications_count: 0,
						type: notification.type,
						most_recent_notification_id: this.notificationService.toNumericId(notification.id),
						page_min_id: notification.id,
						page_max_id: notification.id,
						latest_page_notification_at: notification.created_at,
						sample_account_ids: [],
						status_id: statusId,
					};
					groups.set(bucket, group);
				}

				group.notifications_count++;
				group.page_min_id = notification.id;
				if (group.sample_account_ids.length < MAX_SAMPLE_ACCOUNTS && !group.sample_account_ids.includes(notification.account.id)) {
					group.sample_account_ids.push(notification.account.id);
				}

				accounts.set(notification.account.id, notification.account);
				if (notification.status) statuses.set(notification.status.id, notification.status);
			}

			// Paginate by the fetched page, as notifications for inaccessible notes may leave nothing of it
			attachMinMaxPagination(request, reply, data.data, this.clientService.getPublicBaseUrl());
			return reply.send({
				accounts: [...accounts.values()],
				statuses: [...statuses.values()],
				notification_groups: [...groups.values()],
			});
		});

		fastify.get<{ Params: { group_key: string } }>('/v2/notifications/:group_key', async (request, reply) => {
			const me = await this.clientService.requireAuth(request, 'read:notifications');

			const notification = await this.findGroupNotification(me, request.params.group_key);
			if (notification == null) return reply.code(404).send({ error: 'Record not found' });

			const type = toGroupedType(notification.type, false);
			return reply.send({
				accounts: [notification.account],
				statuses: notification.status ? [notification.status] : [],
				notification_groups: [{
					group_key: request.params.group_key,
					notifications_count: 1,
					type,
					most_recent_notification_id: this.notificationService.toNumericId(notification.id),
					page_min_id: notification.id,
					page_max_id: notification.id,
					latest_page_notification_at: notification.created_at,
					sample_account_ids: [notification.account.id],
					status_id: notification.status?.id ?? null,
				}],
			});
		});

		fastify.get<{ Params: { group_key: string } }>('/v2/notifications/:group_key/accounts', async (request, reply) => {
			const me = await this.clientService.requireAuth(request, 'read:notifications');

			const notification = await this.findGroupNotification(me, request.params.group_key);
			return reply.send(notification ? [notification.account] : []);
		});

		fastify.post<{ Params: { group_key: string } }>('/v2/notifications/:group_key/dismiss', async (request, reply) => {
			const me = await this.clientService.requireAuth(request, 'write:notifications');

			const notificationId = request.params.group_key.split('-').at(-1);
			if (notificationId) await this.notificationService.dismiss(me.id, notificationId);
			return reply.send({});
		});
	}

	/**
	 * Pagination arguments, with the integer notification IDs that grouped notifications give turned back into notification IDs.
	 */
	private async parsePageArgs(me: MiLocalUser | null, query: TimelineArgs): Promise<ReturnType<typeof parseTimelineArgs>> {
		const args = parseTimelineArgs(query);
		if (me == null) return args;

		const resolve = async (id: string | undefined) => id == null ? undefined : await this.notificationService.resolveId(me.id, id);
		return {
			...args,
			max_id: await resolve(args.max_id),
			min_id: await resolve(args.min_id),
			since_id: await resolve(args.since_id),
		};
	}

	/**
	 * Group keys end with the most recent notification ID of the group.
	 * Only that notification can be recovered from a key, as groups are formed per page.
	 */
	private async findGroupNotification(me: MiLocalUser, groupKey: string): Promise<MastodonEntity.Notification | null> {
		const notificationId = groupKey.split('-').at(-1);
		if (!notificationId) return null;
		return await this.notificationService.show(me, notificationId);
	}
}
