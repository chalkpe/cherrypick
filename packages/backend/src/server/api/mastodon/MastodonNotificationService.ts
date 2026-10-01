/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Converter } from 'megalodon';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import type { MiNotification } from '@/models/Notification.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import { MastodonConverters } from '@/server/api/mastodon/MastodonConverters.js';
import type { MastodonEntity, MisskeyEntity } from 'megalodon';

/**
 * Misskey notification types that have a Mastodon counterpart, the same ones notification lists show.
 * Others (achievements, role assignments, exports...) are not shown to Mastodon clients.
 */
const MASTODON_VISIBLE_TYPES: ReadonlySet<string> = new Set(Converter.decodableNotificationTypes);

// Digits of an integer notification ID that tell apart notifications of the same millisecond
const NUMERIC_ID_SCALE = 1000;

function compareStreamIds(a: string, b: string): number {
	const [aMs, aSeq] = a.split('-').map(x => BigInt(x));
	const [bMs, bSeq] = b.split('-').map(x => BigInt(x));
	if (aMs !== bMs) return aMs < bMs ? -1 : 1;
	if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
	return 0;
}

/**
 * Notification operations the Misskey API does not offer, working directly on the notification stream in Redis.
 */
@Injectable()
export class MastodonNotificationService {
	constructor(
		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		private readonly idService: IdService,
		private readonly notificationService: NotificationService,
		private readonly notificationEntityService: NotificationEntityService,
		private readonly mastoConverters: MastodonConverters,
	) {}

	private streamKey(userId: MiUser['id']): string {
		return `notificationTimeline:${userId}`;
	}

	private readPointerKey(userId: MiUser['id']): string {
		return `latestReadNotification:${userId}`;
	}

	/**
	 * Redis stream entry ID of a notification. Mirrors NotificationService.toXListId.
	 */
	private toStreamId(notificationId: string): string | null {
		try {
			const { date, additional } = this.idService.parseFull(notificationId);
			return date.toString() + '-' + BigInt.asUintN(64, additional).toString();
		} catch {
			return null;
		}
	}

	private parseEntry(entry: [id: string, fields: string[]]): MiNotification {
		return JSON.parse(entry[1][1]) as MiNotification;
	}

	/**
	 * Integer form of a notification ID, for the fields that Mastodon gives as integers and strict clients only accept as such.
	 * Notification IDs do not fit in an integer, so it is the time of the notification in milliseconds
	 * followed by three digits of the rest of its ID, which resolveId finds the notification by.
	 * It stays a safe integer until the year 2255.
	 */
	public toNumericId(notificationId: string): number {
		const { date, additional } = this.idService.parseFull(notificationId);
		return date * NUMERIC_ID_SCALE + Number(BigInt.asUintN(64, additional) % BigInt(NUMERIC_ID_SCALE));
	}

	/**
	 * Notification ID for an ID sent by a client, which may be the integer form from toNumericId.
	 * An integer whose notification is gone becomes an ID of the same time, so that paginating from it still works.
	 */
	public async resolveId(userId: MiUser['id'], id: string): Promise<string> {
		if (!/^\d+$/.test(id)) return id;

		const numericId = Number(id);
		const time = Math.floor(numericId / NUMERIC_ID_SCALE);
		// Notification IDs may consist of digits alone too. In practice those are too long for an integer or read as a time no ID carries.
		if (!Number.isSafeInteger(numericId) || !this.idService.isSafeT(time)) return id;

		const rest = BigInt(numericId % NUMERIC_ID_SCALE);
		// Incomplete stream IDs cover every entry of the millisecond
		const entries = await this.redisClient.xrange(this.streamKey(userId), time.toString(), time.toString());
		const entry = entries.find(([streamId]) => BigInt(streamId.split('-')[1]) % BigInt(NUMERIC_ID_SCALE) === rest);
		return entry ? this.parseEntry(entry).id : this.idService.gen(time);
	}

	public async find(userId: MiUser['id'], id: string): Promise<MiNotification | null> {
		const notificationId = await this.resolveId(userId, id);
		const streamId = this.toStreamId(notificationId);
		if (streamId == null) return null;

		const [entry] = await this.redisClient.xrange(this.streamKey(userId), streamId, streamId);
		if (entry == null) return null;

		const notification = this.parseEntry(entry);
		return notification.id === notificationId ? notification : null;
	}

	/**
	 * Returns a single notification as a Mastodon entity, or null if it does not exist or has no Mastodon counterpart.
	 */
	public async show(me: MiLocalUser, notificationId: string): Promise<MastodonEntity.Notification | null> {
		const notification = await this.find(me.id, notificationId);
		if (notification == null) return null;

		const packed = await this.notificationEntityService.pack(notification, me.id, {});
		if (packed == null) return null;

		const entity = Converter.notification(packed as unknown as MisskeyEntity.Notification);
		if (entity instanceof Error) return null;

		return await this.mastoConverters.convertNotification(entity, me);
	}

	/**
	 * Deletes a single notification.
	 */
	public async dismiss(userId: MiUser['id'], id: string): Promise<void> {
		const streamId = this.toStreamId(await this.resolveId(userId, id));
		if (streamId == null) return;
		await this.redisClient.xdel(this.streamKey(userId), streamId);
	}

	/**
	 * Counts unread notifications that Mastodon clients can display, up to the limit.
	 */
	public async countUnread(userId: MiUser['id'], limit: number): Promise<number> {
		const readPointer = await this.redisClient.get(this.readPointerKey(userId));
		const entries = await this.redisClient.xrange(
			this.streamKey(userId),
			readPointer ? '(' + readPointer : '-',
			'+',
			'COUNT', limit);

		return entries.filter(entry => MASTODON_VISIBLE_TYPES.has(this.parseEntry(entry).type)).length;
	}

	/**
	 * ID of the last read notification, from the read state shared with the Misskey web client.
	 */
	public async getLastReadId(userId: MiUser['id']): Promise<string | null> {
		const readPointer = await this.redisClient.get(this.readPointerKey(userId));
		if (readPointer == null) return null;

		// The entry itself may have been trimmed or dismissed, so take the newest one at or before it
		const [entry] = await this.redisClient.xrevrange(this.streamKey(userId), readPointer, '-', 'COUNT', 1);
		return entry ? this.parseEntry(entry).id : null;
	}

	/**
	 * Marks notifications up to and including the given one as read.
	 * The read state never moves backwards, like Misskey's own read handling.
	 */
	public async markReadUpTo(userId: MiUser['id'], notificationId: string): Promise<void> {
		const streamId = this.toStreamId(notificationId);
		if (streamId == null) return;

		const [latest] = await this.redisClient.xrevrange(this.streamKey(userId), '+', '-', 'COUNT', 1);
		if (latest != null && compareStreamIds(streamId, latest[0]) >= 0) {
			// Also tells the web client that everything has been read
			await this.notificationService.readAllNotification(userId);
			return;
		}

		const current = await this.redisClient.get(this.readPointerKey(userId));
		if (current == null || compareStreamIds(streamId, current) > 0) {
			await this.redisClient.set(this.readPointerKey(userId), streamId);
		}
	}
}
