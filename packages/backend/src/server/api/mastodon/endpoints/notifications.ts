/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { MastodonEntity } from 'megalodon';
import { parseTimelineArgs, TimelineArgs } from '@/server/api/mastodon/argsUtils.js';
import { MastodonConverters } from '@/server/api/mastodon/MastodonConverters.js';
import { MastodonNotificationService } from '@/server/api/mastodon/MastodonNotificationService.js';
import { attachMinMaxPagination } from '@/server/api/mastodon/pagination.js';
import { promiseMap } from '@/misc/promise-map.js';
import type { MiLocalUser } from '@/models/User.js';
import { MastodonClientService } from '../MastodonClientService.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface ApiNotifyMastodonRoute {
	Params: {
		id?: string,
	},
	Querystring: TimelineArgs,
}

interface GroupedNotificationsQuery extends TimelineArgs {
	types?: string | string[];
	exclude_types?: string | string[];
	grouped_types?: string | string[];
}

interface NotificationGroup {
	group_key: string;
	notifications_count: number;
	type: string;
	most_recent_notification_id: string;
	page_min_id: string;
	page_max_id: string;
	latest_page_notification_at: string;
	sample_account_ids: string[];
	status_id: string | null;
}

// Types Mastodon groups when the client does not say otherwise
const DEFAULT_GROUPED_TYPES = ['favourite', 'reblog', 'follow'];
const MAX_SAMPLE_ACCOUNTS = 8;

function toArray(value: string | string[] | undefined): string[] | undefined {
	if (value == null) return undefined;
	return Array.isArray(value) ? value : [value];
}

function toLimit(value: string | undefined, fallback: number, max: number): number {
	const parsed = value ? parseInt(value, 10) : NaN;
	return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, 1), max);
}

/**
 * Notification types as grouped notification clients expect them.
 * Emoji reactions become favourites, since Mastodon clients have no reaction type.
 */
function toGroupedType(type: string): string {
	return type === 'reaction' ? 'favourite' : type;
}

@Injectable()
export class ApiNotificationsMastodon {
	constructor(
		private readonly mastoConverters: MastodonConverters,
		private readonly clientService: MastodonClientService,
		private readonly notificationService: MastodonNotificationService,
	) {}

	private async requireMe(request: FastifyRequest, reply: FastifyReply): Promise<MiLocalUser | null> {
		const me = await this.clientService.getAuth(request);
		if (me == null) {
			reply.code(401).send({ error: 'The access token is invalid' });
		}
		return me;
	}

	public register(fastify: FastifyInstance): void {
		fastify.get<ApiNotifyMastodonRoute>('/v1/notifications', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);
			const data = await client.getNotifications(parseTimelineArgs(request.query));
			const notifications = await promiseMap(data.data, async n => await this.mastoConverters.convertNotification(n, me), { limiter: 4 });
			const response: MastodonEntity.Notification[] = [];
			for (const notification of notifications) {
				// Notifications for inaccessible notes will be null and should be ignored
				if (!notification) continue;

				response.push(notification);
				if (notification.type === 'reaction') {
					response.push({
						...notification,
						type: 'favourite',
					});
				}
			}

			attachMinMaxPagination(request, reply, response);
			return reply.send(response);
		});

		for (const path of ['/v1/notifications/unread_count', '/v2/notifications/unread_count']) {
			fastify.get<{ Querystring: { limit?: string } }>(path, async (request, reply) => {
				const me = await this.requireMe(request, reply);
				if (me == null) return;

				// Mastodon caps the count, as clients only show a badge
				const limit = toLimit(request.query.limit, 100, 1000);
				return reply.send({ count: await this.notificationService.countUnread(me.id, limit) });
			});
		}

		// Mastodon uses the plural path. The singular one is kept for clients written against Sharkey.
		for (const path of ['/v1/notifications/:id', '/v1/notification/:id']) {
			fastify.get<ApiNotifyMastodonRoute & { Params: { id?: string } }>(path, async (request, reply) => {
				if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

				const me = await this.requireMe(request, reply);
				if (me == null) return;

				const response = await this.notificationService.show(me, request.params.id);
				if (!response) return reply.code(404).send({ error: 'Record not found' });

				return reply.send(response);
			});
		}

		for (const path of ['/v1/notifications/:id/dismiss', '/v1/notification/:id/dismiss']) {
			fastify.post<ApiNotifyMastodonRoute & { Params: { id?: string } }>(path, async (request, reply) => {
				if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

				const me = await this.requireMe(request, reply);
				if (me == null) return;

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
	}

	/**
	 * Grouped notifications (Mastodon 4.3+, /api/v2/notifications)
	 */
	private registerGrouped(fastify: FastifyInstance): void {
		fastify.get<{ Querystring: GroupedNotificationsQuery }>('/v2/notifications', async (request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(request);

			const includeTypes = toArray(request.query.types);
			const excludeTypes = toArray(request.query.exclude_types) ?? [];
			const groupedTypes = toArray(request.query.grouped_types) ?? DEFAULT_GROUPED_TYPES;
			const limit = toLimit(request.query.limit, 40, 80);

			const data = await client.getNotifications({ ...parseTimelineArgs(request.query), limit });
			const converted = await promiseMap(data.data, async n => await this.mastoConverters.convertNotification(n, me), { limiter: 4 });
			const notifications = converted
				.filter(n => n != null)
				.map(n => ({ ...n, type: toGroupedType(n.type) }))
				.filter(n => (includeTypes == null || includeTypes.includes(n.type)) && !excludeTypes.includes(n.type));

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
						most_recent_notification_id: notification.id,
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

			attachMinMaxPagination(request, reply, notifications);
			return reply.send({
				accounts: [...accounts.values()],
				statuses: [...statuses.values()],
				notification_groups: [...groups.values()],
			});
		});

		fastify.get<{ Params: { group_key: string } }>('/v2/notifications/:group_key', async (request, reply) => {
			const me = await this.requireMe(request, reply);
			if (me == null) return;

			const notification = await this.findGroupNotification(me, request.params.group_key);
			if (notification == null) return reply.code(404).send({ error: 'Record not found' });

			const type = toGroupedType(notification.type);
			return reply.send({
				accounts: [notification.account],
				statuses: notification.status ? [notification.status] : [],
				notification_groups: [{
					group_key: request.params.group_key,
					notifications_count: 1,
					type,
					most_recent_notification_id: notification.id,
					page_min_id: notification.id,
					page_max_id: notification.id,
					latest_page_notification_at: notification.created_at,
					sample_account_ids: [notification.account.id],
					status_id: notification.status?.id ?? null,
				}],
			});
		});

		fastify.get<{ Params: { group_key: string } }>('/v2/notifications/:group_key/accounts', async (request, reply) => {
			const me = await this.requireMe(request, reply);
			if (me == null) return;

			const notification = await this.findGroupNotification(me, request.params.group_key);
			return reply.send(notification ? [notification.account] : []);
		});

		fastify.post<{ Params: { group_key: string } }>('/v2/notifications/:group_key/dismiss', async (request, reply) => {
			const me = await this.requireMe(request, reply);
			if (me == null) return;

			const notificationId = request.params.group_key.split('-').at(-1);
			if (notificationId) await this.notificationService.dismiss(me.id, notificationId);
			return reply.send({});
		});
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
