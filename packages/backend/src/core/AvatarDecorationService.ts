/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, Not } from 'typeorm';
import type { AvatarDecorationsRepository, InstancesRepository, UsersRepository, MiAvatarDecoration, MiInstance, MiUser } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { MemorySingleCache } from '@/misc/cache.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { appendQuery, query } from '@/misc/prelude/url.js';
import type { Config } from '@/config.js';
import { normalizeAvatarDecoration } from '@/core/avatar-decoration.js';
import { checkHttps } from '@/misc/check-https.js';

// Software that serves the Misskey API, which avatar decorations are fetched through, without saying so
const DECORATION_SOFTWARE = ['misskey', 'cherrypick', 'sharkey'];

// TODO:
// 1. checkDuplicateする => done
// 2. リモートのデコレーションをproxy通してないメディアURLで保存できるようにする => プロキシのURLだと403になるので必須
// 3. AvatarDecorationsEntityServiceを作ってpackする
// 4. リモートユーザーのデコレーションを適宜fetchできる関数とAPIを作る
// 5. remoteUserUpdateの処理をAPIfetchの部分とアップデートの部分に分ける => 4をやるためには必要
// 6. するか迷う: MiAvatarDecorationのカラムにdescriptionの他にライセンス欄を追加する
// 7. するか迷う: APubでデコレーションを配信する? => Misskey自体は今のところやることなさそうだからやるならnsを作る必要がある
// 8. avatar-decorationのjson-schemaを作る => packするためには必要
@Injectable()
export class AvatarDecorationService implements OnApplicationShutdown {
	public cache: MemorySingleCache<MiAvatarDecoration[]>;
	public cacheWithRemote: MemorySingleCache<MiAvatarDecoration[]>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.avatarDecorationsRepository)
		private avatarDecorationsRepository: AvatarDecorationsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private moderationLogService: ModerationLogService,
		private globalEventService: GlobalEventService,
		private httpRequestService: HttpRequestService,
	) {
		this.cache = new MemorySingleCache<MiAvatarDecoration[]>(1000 * 60 * 30); // 30s
		this.cacheWithRemote = new MemorySingleCache<MiAvatarDecoration[]>(1000 * 60 * 30); // 30s

		this.redisForSub.on('message', this.onMessage);
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body: _ } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'avatarDecorationCreated':
				case 'avatarDecorationUpdated':
				case 'avatarDecorationDeleted': {
					this.cache.delete();
					break;
				}
				default:
					break;
			}
		}
	}

	@bindThis
	public async create(options: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<MiAvatarDecoration> {
		const created = await this.avatarDecorationsRepository.insertOne({
			id: this.idService.gen(),
			...options,
		});

		this.globalEventService.publishInternalEvent('avatarDecorationCreated', created);

		if (moderator) {
			this.moderationLogService.log(moderator, 'createAvatarDecoration', {
				avatarDecorationId: created.id,
				avatarDecoration: created,
			});
		}

		return created;
	}

	@bindThis
	public async update(id: MiAvatarDecoration['id'], params: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<void> {
		const avatarDecoration = await this.avatarDecorationsRepository.findOneByOrFail({ id });

		const date = new Date();
		await this.avatarDecorationsRepository.update(avatarDecoration.id, {
			updatedAt: date,
			...params,
		});

		const updated = await this.avatarDecorationsRepository.findOneByOrFail({ id: avatarDecoration.id });
		this.globalEventService.publishInternalEvent('avatarDecorationUpdated', updated);

		if (moderator) {
			this.moderationLogService.log(moderator, 'updateAvatarDecoration', {
				avatarDecorationId: avatarDecoration.id,
				before: avatarDecoration,
				after: updated,
			});
		}
	}

	@bindThis
	public getProxiedUrl(url: string, mode?: 'static' | 'avatar'): string {
		return appendQuery(
			`${this.config.mediaProxy}/${mode ?? 'image'}.webp`,
			query({
				url,
				...(mode ? { [mode]: '1' } : {}),
			}),
		);
	}

	/**
	 * 그룹처럼 방금 만든 장식을 바로 보여 주어야 하는 곳에서 쓴다.
	 * getAll의 캐시는 다른 프로세스가 만든 장식을 몰라서 캐시를 거치지 않고 id로 직접 읽는다.
	 */
	@bindThis
	public async findByIds(ids: MiAvatarDecoration['id'][]): Promise<MiAvatarDecoration[]> {
		if (ids.length === 0) return [];
		return this.avatarDecorationsRepository.findBy({ id: In(ids) });
	}

	@bindThis
	public async pack(used: MiUser['avatarDecorations']) {
		if (used.length === 0) return [];
		const decorations = await this.findByIds(used.map(d => d.id));
		return used.flatMap(d => {
			const decoration = decorations.find(item => item.id === d.id);
			return decoration == null ? [] : [{
				id: d.id, angle: d.angle || undefined, flipH: d.flipH || undefined,
				offsetX: d.offsetX || undefined, offsetY: d.offsetY || undefined,
				scale: d.scale || undefined, opacity: d.opacity || undefined, url: decoration.url,
			}];
		});
	}

	@bindThis
	public async registerRemote(host: string, remoteId: string, url: string, name: string, description?: string, options?: { preserveDescription?: boolean }) {
		const existing = await this.avatarDecorationsRepository.findOneBy({ host, remoteId });
		const data = { host, remoteId, url: this.getProxiedUrl(url, 'avatar'), rawUrl: url, name, description: options?.preserveDescription ? existing?.description ?? '' : description };
		const decoration = existing == null ? await this.create(data) : (await this.update(existing.id, data), existing);
		this.cacheWithRemote.delete();
		return decoration.id;
	}

	@bindThis
	public async resolveChatDecorations(host: string, value: unknown): Promise<MiUser['avatarDecorations'] | undefined> {
		if (!Array.isArray(value) || value.length > 16) return undefined;
		const result: MiUser['avatarDecorations'] = [];
		for (const item of value) {
			if (item == null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 32) continue;
			if (typeof item.url !== 'string' || item.url.length > 4096 || !checkHttps(item.url)) continue;
			try {
				const url = new URL(item.url);
				if (url.username || url.password || this.getProxiedUrl(item.url, 'avatar').length > 1024) continue;
			} catch {
				continue;
			}
			if (typeof item.name !== 'string' || item.name.length > 256) continue;
			if (item.flipH != null && typeof item.flipH !== 'boolean') continue;
			const ranges = { angle: [-0.5, 0.5], offsetX: [-0.25, 0.25], offsetY: [-0.25, 0.25], scale: [0.5, 1.5], opacity: [0.1, 1] };
			if (Object.entries(ranges).some(([key, [min, max]]) => item[key] != null && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < min || item[key] > max))) continue;
			const id = await this.registerRemote(host, item.id, item.url, item.name, undefined, { preserveDescription: true });
			result.push(normalizeAvatarDecoration({ id, angle: item.angle, flipH: item.flipH, offsetX: item.offsetX, offsetY: item.offsetY, scale: item.scale, opacity: item.opacity }));
		}
		return result;
	}

	/**
	 * Whether the instance serves the API that avatar decorations are fetched through.
	 * Other software, such as Sharlayan Mastodon, serves it as well and advertises that in its NodeInfo.
	 */
	@bindThis
	private getDecorationSupport(instance: MiInstance | null): 'certain' | 'advertised' | 'none' {
		if (instance == null) return 'none';
		if (instance.softwareName != null && DECORATION_SOFTWARE.includes(instance.softwareName)) return 'certain';
		if (instance.supportsAvatarDecorations) return 'advertised';
		return 'none';
	}

	@bindThis
	public async remoteUserUpdate(user: MiUser) {
		const userHost = user.host ?? '';
		const instance = await this.instancesRepository.findOneBy({ host: userHost });
		const userHostUrl = `https://${user.host}`;
		const showUserApiUrl = `${userHostUrl}/api/users/show`;

		const support = this.getDecorationSupport(instance);
		if (support === 'none') return;

		let userData: any;
		try {
			const res = await this.httpRequestService.send(showUserApiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 'username': user.username }),
			});

			userData = await res.json();
		} catch (err) {
			// What other software serves is not the API itself, so its failure must not fail the update of the user
			if (support === 'advertised') return;
			throw err;
		}
		const userAvatarDecorations = userData.avatarDecorations ?? undefined;

		if (!userAvatarDecorations || userAvatarDecorations.length === 0) {
			const updates = {} as Partial<MiUser>;
			updates.avatarDecorations = [];

			if (!(await this.usersRepository.update({ id: user.id, isDeleted: false }, updates)).affected) {
				return 'skip';
			}

			return;
		}

		const instanceHost = instance!.host;
		const decorationApiUrl = `https://${instanceHost}/api/get-avatar-decorations`;
		const allRes = await this.httpRequestService.send(decorationApiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});

		const allDecorations: any = await allRes.json();
		const updates = {} as Partial<MiUser>;
		updates.avatarDecorations = [];

		for (const avatarDecoration of userAvatarDecorations) {
			let name;
			let description;
			const avatarDecorationId = avatarDecoration.id;

			for (const decoration of allDecorations) {
				// eslint-disable-next-line eqeqeq
				if (decoration.id == avatarDecorationId) {
					name = decoration.name;
					description = decoration.description;
					break;
				}
			}

			const existingDecoration = await this.avatarDecorationsRepository.findOneBy({
				host: userHost,
				remoteId: avatarDecorationId,
			});

			const decorationData = {
				name: name,
				description: description,
				url: this.getProxiedUrl(avatarDecoration.url, 'avatar'),
				remoteId: avatarDecorationId,
				host: userHost,
				rawUrl: avatarDecoration.url,
			};

			if (existingDecoration == null) {
				await this.create(decorationData);
				this.cacheWithRemote.delete();
			} else {
				await this.update(existingDecoration.id, decorationData);
				this.cacheWithRemote.delete();
			}

			const findDecoration = await this.avatarDecorationsRepository.findOneBy({
				host: userHost,
				remoteId: avatarDecorationId,
			});

			updates.avatarDecorations.push({
				id: findDecoration?.id ?? '',
				angle: avatarDecoration.angle ?? 0,
				flipH: avatarDecoration.flipH ?? false,
				offsetX: avatarDecoration.offsetX ?? 0,
				offsetY: avatarDecoration.offsetY ?? 0,
				scale: avatarDecoration.scale ?? 1,
				opacity: avatarDecoration.opacity ?? 1,
			});
		}
		if (!(await this.usersRepository.update({ id: user.id, isDeleted: false }, updates)).affected) {
			return 'skip';
		}

		return undefined;
	}

	@bindThis
	public async delete(id: MiAvatarDecoration['id'], moderator?: MiUser): Promise<void> {
		const avatarDecoration = await this.avatarDecorationsRepository.findOneByOrFail({ id });

		await this.avatarDecorationsRepository.delete({ id: avatarDecoration.id });
		this.globalEventService.publishInternalEvent('avatarDecorationDeleted', avatarDecoration);

		if (moderator) {
			this.moderationLogService.log(moderator, 'deleteAvatarDecoration', {
				avatarDecorationId: avatarDecoration.id,
				avatarDecoration: avatarDecoration,
			});
		}
	}

	@bindThis
	public async getAll(noCache = false, withRemote = false, remoteOnly = false): Promise<MiAvatarDecoration[]> {
		if (noCache) {
			this.cache.delete();
			this.cacheWithRemote.delete();
		}

		if (remoteOnly) {
			return this.cacheWithRemote.fetch(() => this.avatarDecorationsRepository.find({
				where: {
					host: Not(IsNull()),
				},
			}));
		} else if (withRemote) {
			return this.cacheWithRemote.fetch(() => this.avatarDecorationsRepository.find());
		} else {
			return this.cache.fetch(() => this.avatarDecorationsRepository.find({
				where: {
					host: IsNull(),
				},
			}));
		}
	}

	@bindThis
	private async fetchRemoteDecorations(id: string): Promise<string | null> {
		const decoration = await this.avatarDecorationsRepository.findOneBy({ id });
		if (decoration == null) return null;
		if (!decoration.host) return null;

		const instance = await this.instancesRepository.findOneBy({ host: decoration.host });
		if (!instance) return null;

		if (this.getDecorationSupport(instance) === 'none') {
			return null;
		}

		const decorationApiUrl = `https://${instance.host}/api/get-avatar-decorations`;

		try {
			const res = await this.httpRequestService.send(decorationApiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			const allDecorations: any = await res.json();
			const remoteDecoration = allDecorations.find((d: any) => d.id === decoration.remoteId);

			if (remoteDecoration?.url) {
				return remoteDecoration.url;
			}
		} catch (e) {
			return null;
		}
		return null;
	}

	@bindThis
	public async getRawUrl(decoration: MiAvatarDecoration): Promise<string | null> {
		if (decoration.rawUrl) return decoration.rawUrl;

		const remoteUrl = await this.fetchRemoteDecorations(decoration.id);
		if (remoteUrl) {
			await this.update(decoration.id, { rawUrl: remoteUrl });
		}
		return remoteUrl;
	}

	@bindThis
	public checkDuplicate(url: string, name: string): Promise<boolean> {
		return this.avatarDecorationsRepository.exists({ where: { url, name, host: IsNull() } });
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
