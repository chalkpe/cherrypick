/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import push from 'web-push';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { AccessTokensRepository, MiMeta } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { CacheService } from '@/core/CacheService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';

export const PUSH_ALERT_TYPES = ['mention', 'status', 'reblog', 'follow', 'follow_request', 'favourite', 'poll', 'update', 'quote'] as const;
export type PushAlertType = typeof PUSH_ALERT_TYPES[number];
export const PUSH_POLICIES = ['all', 'followed', 'follower', 'none'] as const;
export type PushPolicy = typeof PUSH_POLICIES[number];

export interface MastodonPushSubscription {
	/** Mastodon clients parse this as an integer */
	id: number;
	userId: MiUser['id'];
	/** The subscription belongs to one access token, like in Mastodon */
	accessTokenId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	/** RFC 8291 (aes128gcm) instead of the legacy aesgcm encoding */
	standard: boolean;
	alerts: Partial<Record<PushAlertType, boolean>>;
	policy: PushPolicy;
}

type PackedNotification = Packed<'Notification'>;

// Mastodon keeps undelivered pushes for two days
const PUSH_TTL_SECONDS = 60 * 60 * 48;

/**
 * Maps a Misskey notification to the Mastodon push type and title. Returns null for types Mastodon clients do not know.
 */
function describe(notification: PackedNotification): { type: PushAlertType; title: string } | null {
	const user = 'user' in notification ? notification.user : null;
	const name = user ? (user.name ?? user.username) : '';

	switch (notification.type) {
		case 'mention':
		case 'reply':
			return { type: 'mention', title: `${name} mentioned you` };
		case 'renote':
			return { type: 'reblog', title: `${name} boosted your post` };
		case 'quote':
			return { type: 'reblog', title: `${name} quoted your post` };
		case 'reaction':
			return { type: 'favourite', title: `${name} reacted ${notification.reaction} to your post` };
		case 'follow':
			return { type: 'follow', title: `${name} followed you` };
		case 'receiveFollowRequest':
			return { type: 'follow_request', title: `${name} requested to follow you` };
		case 'pollEnded':
			return { type: 'poll', title: 'A poll has ended' };
		case 'note':
			return { type: 'status', title: `${name} just posted` };
		default:
			return null;
	}
}

function truncate(text: string, length: number): string {
	return text.length > length ? text.slice(0, length - 1) + '…' : text;
}

/**
 * Mastodon-compatible Web Push (/api/v1/push/subscription).
 *
 * Subscriptions live in Redis next to the notifications themselves.
 * Pushes are sent at the same moment as Misskey's own pushes: when a notification is still unread after a short delay.
 */
@Injectable()
export class MastodonPushService implements OnApplicationShutdown {
	private readonly logger: Logger;

	constructor(
		@Inject(DI.config)
		private readonly config: Config,

		@Inject(DI.meta)
		private readonly meta: MiMeta,

		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		@Inject(DI.redisForSub)
		private readonly redisForSub: Redis.Redis,

		@Inject(DI.accessTokensRepository)
		private readonly accessTokensRepository: AccessTokensRepository,

		private readonly cacheService: CacheService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('masto-push');
		this.redisForSub.on('message', this.onRedisMessage);
	}

	/**
	 * VAPID public key, or null when the administrator has not enabled push notifications.
	 */
	public get serverKey(): string | null {
		if (!this.meta.enableServiceWorker || this.meta.swPublicKey == null || this.meta.swPrivateKey == null) return null;
		return this.meta.swPublicKey;
	}

	private subscriptionKey(accessTokenId: string): string {
		return `mastodonPush:subscription:${accessTokenId}`;
	}

	private userKey(userId: MiUser['id']): string {
		return `mastodonPush:user:${userId}`;
	}

	public async get(accessTokenId: string): Promise<MastodonPushSubscription | null> {
		const value = await this.redisClient.get(this.subscriptionKey(accessTokenId));
		return value ? JSON.parse(value) as MastodonPushSubscription : null;
	}

	/**
	 * Creates or replaces the subscription of an access token.
	 */
	public async save(subscription: Omit<MastodonPushSubscription, 'id'> & { id?: number }): Promise<MastodonPushSubscription> {
		const saved: MastodonPushSubscription = {
			...subscription,
			id: subscription.id ?? await this.redisClient.incr('mastodonPush:sequence'),
		};
		await this.redisClient.multi()
			.set(this.subscriptionKey(saved.accessTokenId), JSON.stringify(saved))
			.sadd(this.userKey(saved.userId), saved.accessTokenId)
			.exec();
		return saved;
	}

	public async remove(userId: MiUser['id'], accessTokenId: string): Promise<void> {
		await this.redisClient.multi()
			.del(this.subscriptionKey(accessTokenId))
			.srem(this.userKey(userId), accessTokenId)
			.exec();
	}

	@bindThis
	private onRedisMessage(_: string, data: string): void {
		// Cheap check before parsing, as every stream event passes through here
		if (!data.includes('"unreadNotification"')) return;

		const { channel, message } = JSON.parse(data) as { channel: string; message: { type: string; body: PackedNotification } };
		if (!channel.startsWith('mainStream:') || message.type !== 'unreadNotification') return;

		const userId = channel.slice('mainStream:'.length);
		this.deliver(userId, message.body).catch(err => this.logger.error('Failed to send push notifications', { error: err }));
	}

	private async deliver(userId: MiUser['id'], notification: PackedNotification): Promise<void> {
		const serverKey = this.serverKey;
		if (serverKey == null) return;

		const accessTokenIds = await this.redisClient.smembers(this.userKey(userId));
		if (accessTokenIds.length === 0) return;

		const description = describe(notification);
		if (description == null) return;

		// Every server process receives the event, so only the first one sends
		const claimed = await this.redisClient.set(`mastodonPush:sent:${notification.id}`, '1', 'EX', 60 * 10, 'NX');
		if (claimed == null) return;

		const notifierId = 'userId' in notification ? notification.userId as string | undefined : undefined;
		const profile = await this.cacheService.userProfileCache.fetch(userId).catch(() => null);

		for (const accessTokenId of accessTokenIds) {
			const subscription = await this.get(accessTokenId);
			if (subscription == null) {
				await this.redisClient.srem(this.userKey(userId), accessTokenId);
				continue;
			}
			if (!subscription.alerts[description.type]) continue;
			if (!await this.matchesPolicy(subscription.policy, userId, notifierId)) continue;

			const accessToken = await this.accessTokensRepository.findOneBy({ id: accessTokenId });
			if (accessToken == null) {
				// The token was revoked, so is its subscription
				await this.remove(userId, accessTokenId);
				continue;
			}

			await this.send(subscription, {
				access_token: accessToken.token,
				preferred_locale: profile?.lang ?? 'en',
				notification_id: notification.id,
				notification_type: description.type,
				icon: this.getIcon(notification),
				title: description.title,
				body: this.getBody(notification),
			});
		}
	}

	private async matchesPolicy(policy: PushPolicy, userId: MiUser['id'], notifierId: string | undefined): Promise<boolean> {
		switch (policy) {
			case 'all': return true;
			case 'none': return false;
			case 'followed':
				return notifierId != null && Object.hasOwn(await this.cacheService.userFollowingsCache.fetch(userId), notifierId);
			case 'follower':
				return notifierId != null && Object.hasOwn(await this.cacheService.userFollowingsCache.fetch(notifierId), userId);
		}
	}

	private getIcon(notification: PackedNotification): string {
		const user = 'user' in notification ? notification.user : null;
		return user?.avatarUrl ?? `${this.config.url}/static-assets/avatar.png`;
	}

	private getBody(notification: PackedNotification): string {
		const note = 'note' in notification ? notification.note : null;
		if (note) return truncate(note.cw ?? note.text ?? '', 140);

		const user = 'user' in notification ? notification.user : null;
		return user ? `@${user.username}${user.host ? `@${user.host}` : ''}` : '';
	}

	/**
	 * VAPID contact. Push services accept only https: and mailto: URIs.
	 */
	private get vapidSubject(): string | null {
		if (this.config.url.startsWith('https://')) return this.config.url;
		return this.meta.maintainerEmail ? `mailto:${this.meta.maintainerEmail}` : null;
	}

	private async send(subscription: MastodonPushSubscription, payload: Record<string, string>): Promise<void> {
		const subject = this.vapidSubject;
		if (subject == null) {
			this.logger.warn('Skipping push: the instance URL is not HTTPS and no maintainer email is set');
			return;
		}

		try {
			await push.sendNotification({
				endpoint: subscription.endpoint,
				keys: { p256dh: subscription.p256dh, auth: subscription.auth },
			}, JSON.stringify(payload), {
				vapidDetails: {
					subject,
					publicKey: this.meta.swPublicKey!,
					privateKey: this.meta.swPrivateKey!,
				},
				// Mastodon clients before RFC 8291 support, such as the official apps, decrypt aesgcm
				contentEncoding: subscription.standard ? 'aes128gcm' : 'aesgcm',
				TTL: PUSH_TTL_SECONDS,
				proxy: this.config.proxy,
			});
		} catch (err) {
			const statusCode = (err as { statusCode?: number }).statusCode;
			if (statusCode === 404 || statusCode === 410) {
				// The push service forgot this subscription
				await this.remove(subscription.userId, subscription.accessTokenId);
				return;
			}
			this.logger.warn(`Push to ${new URL(subscription.endpoint).host} failed`, { statusCode });
		}
	}

	@bindThis
	public onApplicationShutdown(): void {
		this.redisForSub.off('message', this.onRedisMessage);
	}
}
