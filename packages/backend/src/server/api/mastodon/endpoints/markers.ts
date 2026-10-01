/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiUser } from '@/models/User.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { MastodonNotificationService } from '@/server/api/mastodon/MastodonNotificationService.js';
import type { FastifyInstance } from 'fastify';

type Timeline = 'home' | 'notifications';
const TIMELINES: readonly Timeline[] = ['home', 'notifications'];

interface Marker {
	last_read_id: string;
	version: number;
	updated_at: string;
}

type MarkersBody = Record<string, unknown>;

/**
 * Reads last_read_id for a timeline from either a nested JSON body or a flat form body ("home[last_read_id]").
 */
function readLastReadId(body: MarkersBody, timeline: Timeline): string | undefined {
	const nested = body[timeline];
	if (nested != null && typeof nested === 'object' && 'last_read_id' in nested) {
		const value = (nested as { last_read_id: unknown }).last_read_id;
		if (typeof value === 'string' && value !== '') return value;
	}
	const flat = body[`${timeline}[last_read_id]`];
	return typeof flat === 'string' && flat !== '' ? flat : undefined;
}

/**
 * Saved reading positions (/api/v1/markers).
 *
 * The notifications marker follows the read state shared with the Misskey web client,
 * so reading notifications in either place clears them in both.
 */
@Injectable()
export class ApiMarkersMastodon {
	constructor(
		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		private readonly clientService: MastodonClientService,
		private readonly notificationService: MastodonNotificationService,
	) {}

	private key(userId: MiUser['id']): string {
		return `mastodonMarkers:${userId}`;
	}

	private async getStored(userId: MiUser['id'], timeline: Timeline): Promise<Marker | null> {
		const value = await this.redisClient.hget(this.key(userId), timeline);
		return value ? JSON.parse(value) as Marker : null;
	}

	private async getMarkers(userId: MiUser['id'], timelines: readonly Timeline[]): Promise<Partial<Record<Timeline, Marker>>> {
		const result: Partial<Record<Timeline, Marker>> = {};
		for (const timeline of timelines) {
			const stored = await this.getStored(userId, timeline);
			if (timeline === 'notifications') {
				const lastReadId = await this.notificationService.getLastReadId(userId);
				if (lastReadId == null && stored == null) continue;
				result.notifications = {
					last_read_id: lastReadId ?? stored!.last_read_id,
					version: stored?.version ?? 0,
					updated_at: stored?.updated_at ?? new Date().toISOString(),
				};
			} else if (stored != null) {
				result[timeline] = stored;
			}
		}
		return result;
	}

	public register(fastify: FastifyInstance): void {
		fastify.get<{ Querystring: { timeline?: string | string[] } }>('/v1/markers', async (request, reply) => {
			const me = await this.clientService.requireAuth(request, 'read:account');

			const requested = request.query.timeline == null
				? []
				: Array.isArray(request.query.timeline) ? request.query.timeline : [request.query.timeline];
			const timelines = TIMELINES.filter(t => requested.includes(t));

			return reply.send(await this.getMarkers(me.id, timelines));
		});

		fastify.post<{ Body?: MarkersBody }>('/v1/markers', async (request, reply) => {
			const body = request.body ?? {};
			// The notifications marker marks notifications as read, like notifications/mark-all-as-read
			const me = await this.clientService.requireAuth(request, readLastReadId(body, 'notifications') != null ? 'write:notifications' : 'write:account');

			const updated: Timeline[] = [];
			for (const timeline of TIMELINES) {
				let lastReadId = readLastReadId(body, timeline);
				if (lastReadId == null) continue;
				// Clients of grouped notifications send the integer ID of the group's most recent notification
				if (timeline === 'notifications') lastReadId = await this.notificationService.resolveId(me.id, lastReadId);

				const stored = await this.getStored(me.id, timeline);
				const marker: Marker = {
					last_read_id: lastReadId,
					version: (stored?.version ?? 0) + 1,
					updated_at: new Date().toISOString(),
				};
				await this.redisClient.hset(this.key(me.id), timeline, JSON.stringify(marker));

				if (timeline === 'notifications') {
					await this.notificationService.markReadUpTo(me.id, lastReadId);
				}
				updated.push(timeline);
			}

			return reply.send(await this.getMarkers(me.id, updated));
		});
	}
}
