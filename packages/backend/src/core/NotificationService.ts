/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import * as Redis from 'ioredis';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { In } from 'typeorm';
import { ReplyError } from 'ioredis';
import Logger from '@/logger.js';
import { DI } from '@/di-symbols.js';
import type { UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { MiNotification } from '@/models/Notification.js';
import { bindThis } from '@/decorators.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { IdService } from '@/core/IdService.js';
import { CacheService } from '@/core/CacheService.js';
import type { Config } from '@/config.js';
import { UserListService } from '@/core/UserListService.js';
import { FilterUnionByProperty, groupedNotificationTypes, obsoleteNotificationTypes } from '@/types.js';
import { trackPromise } from '@/misc/promise-tracker.js';
// import { escapeHtml } from '@/misc/escape-html.js';

// 같은 규칙의 과거 세대는 새 세대를 덮지 않는다. 두 키는 같은 Redis 슬롯에 둔다.
const CLEANUP_NOTIFICATION_SCRIPT = `
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
if previous > tonumber(ARGV[1]) then return -1 end
if previous == tonumber(ARGV[1]) then return 0 end
redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], ARGV[3], 'data', ARGV[4])
redis.call('SET', KEYS[2], ARGV[1])
return 1
`;

@Injectable()
export class NotificationService implements OnApplicationShutdown {
	#shutdownController = new AbortController();
	private logger = new Logger('notification');

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private notificationEntityService: NotificationEntityService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
		private pushNotificationService: PushNotificationService,
		private cacheService: CacheService,
		private userListService: UserListService,
	) {
	}

	@bindThis
	public async readAllNotification(
		userId: MiUser['id'],
		force = false,
	) {
		const latestReadNotificationId = await this.redisClient.get(`latestReadNotification:${userId}`);

		const latestNotificationIdsRes = await this.redisClient.xrevrange(
			`notificationTimeline:${userId}`,
			'+',
			'-',
			'COUNT', 1);
		const latestNotificationId = latestNotificationIdsRes[0]?.[0];

		if (latestNotificationId == null) return;

		this.redisClient.set(`latestReadNotification:${userId}`, latestNotificationId);

		if (force || latestReadNotificationId == null || (latestReadNotificationId < latestNotificationId)) {
			return this.postReadAllNotifications(userId);
		}
	}

	@bindThis
	private postReadAllNotifications(userId: MiUser['id']) {
		this.globalEventService.publishMainStream(userId, 'readAllNotifications');
		this.pushNotificationService.pushNotification(userId, 'readAllNotifications', undefined);
	}

	@bindThis
	public createNotification<T extends MiNotification['type']>(
		notifieeId: MiUser['id'],
		type: T,
		data: Omit<FilterUnionByProperty<MiNotification, 'type', T>, 'type' | 'id' | 'createdAt' | 'notifierId'>,
		notifierId?: MiUser['id'] | null,
	) {
		trackPromise(
			this.#createNotificationInternal(notifieeId, type, data, notifierId),
		);
	}

	// 이 기능만 저장 접수를 기다린다. 화면 전파 실패는 이미 접수한 통지를 다시 만들지 않는다.
	public async createNoteCleanupProtectionNotification(
		userId: string,
		data: { ruleId: string; errorCode: string },
		generation: number,
	): Promise<'accepted' | 'suppressed'> {
		const notification = await this.#createNotificationInternal(userId, 'noteCleanupProtectionFailed', data, undefined, generation);
		return notification === null ? 'suppressed' : 'accepted';
	}

	public async deleteNoteCleanupProtectionMarker(userId: string, ruleId: string): Promise<void> {
		await this.redisClient.del(this.cleanupProtectionMarker(userId, ruleId));
	}

	private cleanupProtectionMarker(userId: string, ruleId: string): string {
		return `noteCleanupProtection:{notificationTimeline:${userId}}:${ruleId}`;
	}

	async #createNotificationInternal<T extends MiNotification['type']>(
		notifieeId: MiUser['id'],
		type: T,
		data: Omit<FilterUnionByProperty<MiNotification, 'type', T>, 'type' | 'id' | 'createdAt' | 'notifierId'>,
		notifierId?: MiUser['id'] | null,
		cleanupGeneration?: number,
	): Promise<MiNotification | null> {
		const profile = await this.cacheService.userProfileCache.fetch(notifieeId);

		// 古いMisskeyバージョンのキャッシュが残っている可能性がある
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		const recieveConfig = (profile.notificationRecieveConfig ?? {})[type];
		if (recieveConfig?.type === 'never') {
			return null;
		}

		if (notifierId) {
			if (notifieeId === notifierId) {
				return null;
			}

			const mutings = await this.cacheService.userMutingsCache.fetch(notifieeId);
			if (mutings.has(notifierId)) {
				return null;
			}

			if (recieveConfig?.type === 'following') {
				const isFollowing = await this.cacheService.userFollowingsCache.fetch(notifieeId).then(followings => Object.hasOwn(followings, notifierId));
				if (!isFollowing) {
					return null;
				}
			} else if (recieveConfig?.type === 'follower') {
				const isFollower = await this.cacheService.userFollowingsCache.fetch(notifierId).then(followings => Object.hasOwn(followings, notifieeId));
				if (!isFollower) {
					return null;
				}
			} else if (recieveConfig?.type === 'mutualFollow') {
				const [isFollowing, isFollower] = await Promise.all([
					this.cacheService.userFollowingsCache.fetch(notifieeId).then(followings => Object.hasOwn(followings, notifierId)),
					this.cacheService.userFollowingsCache.fetch(notifierId).then(followings => Object.hasOwn(followings, notifieeId)),
				]);
				if (!(isFollowing && isFollower)) {
					return null;
				}
			} else if (recieveConfig?.type === 'followingOrFollower') {
				const [isFollowing, isFollower] = await Promise.all([
					this.cacheService.userFollowingsCache.fetch(notifieeId).then(followings => Object.hasOwn(followings, notifierId)),
					this.cacheService.userFollowingsCache.fetch(notifierId).then(followings => Object.hasOwn(followings, notifieeId)),
				]);
				if (!isFollowing && !isFollower) {
					return null;
				}
			} else if (recieveConfig?.type === 'list') {
				const isMember = await this.userListService.membersCache.fetch(recieveConfig.userListId).then(members => members.has(notifierId));
				if (!isMember) {
					return null;
				}
			}
		}

		const createdAt = new Date();
		let notification: FilterUnionByProperty<MiNotification, 'type', T>;
		let redisId: string;

		do {
			notification = {
				id: this.idService.gen(),
				createdAt,
				type: type,
				...(notifierId ? {
					notifierId,
				} : {}),
				...data,
			} as unknown as FilterUnionByProperty<MiNotification, 'type', T>;

			try {
				if (cleanupGeneration !== undefined) {
					const stream = `notificationTimeline:${notifieeId}`;
					if (type !== 'noteCleanupProtectionFailed' || !('ruleId' in data) || typeof data.ruleId !== 'string') throw new Error('Invalid cleanup notification data');
					const ruleId = data.ruleId;
					const added = Number(await this.redisClient.eval(CLEANUP_NOTIFICATION_SCRIPT, 2,
						stream, this.cleanupProtectionMarker(notifieeId, ruleId), cleanupGeneration.toString(),
						this.config.perUserNotificationsMaxCount.toString(), this.toXListId(notification.id), JSON.stringify(notification)));
					if (added === 0) return notification;
					if (added !== 1) throw new Error('Invalid cleanup notification acceptance result');
					redisId = this.toXListId(notification.id);
				} else {
					redisId = (await this.redisClient.xadd(
						`notificationTimeline:${notifieeId}`,
						'MAXLEN', '~', this.config.perUserNotificationsMaxCount.toString(),
						this.toXListId(notification.id),
						'data', JSON.stringify(notification)))!;
				}
			} catch (e) {
				// The ID specified in XADD is equal or smaller than the target stream top item で失敗することがあるのでリトライ
				if (e instanceof ReplyError && e instanceof Error && (cleanupGeneration === undefined || e.message.includes('equal or smaller than the target stream top item'))) continue;
				throw e;
			}

			break;
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		} while (true);

		if (cleanupGeneration !== undefined) {
			trackPromise(this.#publishNotification(notifieeId, notification, redisId, notifierId).catch(error => {
				this.logger.error('Cleanup notification publication failed', { error });
			}));
			return notification;
		}
		return this.#publishNotification(notifieeId, notification, redisId, notifierId);
	}

	async #publishNotification(notifieeId: string, notification: MiNotification, redisId: string, notifierId?: string | null): Promise<MiNotification | null> {
		const type = notification.type;
		const packed = await this.notificationEntityService.pack(notification, notifieeId, {});

		if (packed == null) return null;

		// Publish notification event
		this.globalEventService.publishMainStream(notifieeId, 'notification', packed);

		// 2秒経っても(今回作成した)通知が既読にならなかったら「未読の通知がありますよ」イベントを発行する
		// テスト通知の場合は即時発行
		const interval = notification.type === 'test' ? 0 : 2000;
		// Aborting the timer does not stop a callback that has already started.
		trackPromise(setTimeout(interval, 'unread notification', { signal: this.#shutdownController.signal }).then(async () => {
			const latestReadNotificationId = await this.redisClient.get(`latestReadNotification:${notifieeId}`);
			if (latestReadNotificationId && (latestReadNotificationId >= redisId)) return;

			this.globalEventService.publishMainStream(notifieeId, 'unreadNotification', packed);
			this.pushNotificationService.pushNotification(notifieeId, 'notification', packed);

			if (type === 'follow') this.emailNotificationFollow(notifieeId, await this.usersRepository.findOneByOrFail({ id: notifierId! }));
			if (type === 'receiveFollowRequest') this.emailNotificationReceiveFollowRequest(notifieeId, await this.usersRepository.findOneByOrFail({ id: notifierId! }));
		}, () => { /* aborted, ignore it */ }));

		return notification;
	}

	// TODO
	//const locales = await import('i18n');

	// TODO: locale ファイルをクライアント用とサーバー用で分けたい

	@bindThis
	private async emailNotificationFollow(userId: MiUser['id'], follower: MiUser) {
		/*
		const userProfile = await UserProfiles.findOneByOrFail({ userId: userId });
		if (!userProfile.email || !userProfile.emailNotificationTypes.includes('follow')) return;
		const locale = locales[userProfile.lang ?? 'ja-JP'];
		const i18n = new I18n(locale);
		// TODO: render user information html
		const body = `${follower.name} (@${Acct.toString(follower)})`;
		sendEmail(userProfile.email, i18n.t('_email._follow.title'), escapeHtml(body), body);
		*/
	}

	@bindThis
	private async emailNotificationReceiveFollowRequest(userId: MiUser['id'], follower: MiUser) {
		/*
		const userProfile = await UserProfiles.findOneByOrFail({ userId: userId });
		if (!userProfile.email || !userProfile.emailNotificationTypes.includes('receiveFollowRequest')) return;
		const locale = locales[userProfile.lang ?? 'ja-JP'];
		const i18n = new I18n(locale);
		// TODO: render user information html
		const body = `${follower.name} (@${Acct.toString(follower)})`;
		sendEmail(userProfile.email, i18n.t('_email._receiveFollowRequest.title'), escapeHtml(body), body);
		*/
	}

	@bindThis
	public async flushAllNotifications(userId: MiUser['id']) {
		await Promise.all([
			this.redisClient.del(`notificationTimeline:${userId}`),
			this.redisClient.del(`latestReadNotification:${userId}`),
		]);
		this.globalEventService.publishMainStream(userId, 'notificationFlushed');
	}

	@bindThis
	public async deleteUserGroupInvitation(userId: MiUser['id'], invitationId: string) {
		const streamKey = `notificationTimeline:${userId}`;
		const entries = await this.redisClient.xrange(streamKey, '-', '+');

		for (const [entryId, fields] of entries) {
			const dataIndex = fields.indexOf('data');
			if (dataIndex !== -1) {
				try {
					const data = JSON.parse(fields[dataIndex + 1]);

					if (data.userGroupInvitationId === invitationId) {
						await this.redisClient.xdel(streamKey, entryId);
						break;
					}
				} catch (e) {
					console.error('(UserGroupInvitationNotification) JSON Parsing Error:', e);
				}
			} else console.log('(UserGroupInvitationNotification) Data field not found in fields:', fields);
		}
	}

	@bindThis
	public dispose(): void {
		this.#shutdownController.abort();
	}

	private toXListId(id: string): string {
		const { date, additional } = this.idService.parseFull(id);
		// Redis Stream sequenceはunit64制約があるため、収まらない場合は下位64bitを取る
		return date.toString() + '-' + BigInt.asUintN(64, additional).toString();
	}

	@bindThis
	public async getNotifications(
		userId: MiUser['id'],
		{
			sinceId,
			untilId,
			limit = 20,
			includeTypes,
			excludeTypes,
		}: {
			sinceId?: string,
			untilId?: string,
			limit?: number,
			// any extra types are allowed, those are no-op
			includeTypes?: (MiNotification['type'] | string)[],
			excludeTypes?: (MiNotification['type'] | string)[],
		},
	): Promise<MiNotification[]> {
		let sinceTime = sinceId ? this.toXListId(sinceId) : null;
		let untilTime = untilId ? this.toXListId(untilId) : null;

		let notifications: MiNotification[];
		for (; ;) {
			let notificationsRes: [id: string, fields: string[]][];

			// sinceidのみの場合は古い順、そうでない場合は新しい順。 QueryService.makePaginationQueryも参照
			if (sinceTime && !untilTime) {
				notificationsRes = await this.redisClient.xrange(
					`notificationTimeline:${userId}`,
					'(' + sinceTime,
					'+',
					'COUNT', limit);
			} else {
				notificationsRes = await this.redisClient.xrevrange(
					`notificationTimeline:${userId}`,
					untilTime ? '(' + untilTime : '+',
					sinceTime ? '(' + sinceTime : '-',
					'COUNT', limit);
			}

			if (notificationsRes.length === 0) {
				return [];
			}

			notifications = notificationsRes.map(x => JSON.parse(x[1][1])) as MiNotification[];

			if (includeTypes && includeTypes.length > 0) {
				notifications = notifications.filter(notification => includeTypes.includes(notification.type));
			} else if (excludeTypes && excludeTypes.length > 0) {
				notifications = notifications.filter(notification => !excludeTypes.includes(notification.type));
			}

			if (notifications.length !== 0) {
				// 通知が１件以上ある場合は返す
				break;
			}

			// フィルタしたことで通知が0件になった場合、次のページを取得する
			if (sinceId && !untilId) {
				sinceTime = notificationsRes[notificationsRes.length - 1][0];
			} else {
				untilTime = notificationsRes[notificationsRes.length - 1][0];
			}
		}

		return notifications;
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
