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
import { MemoryKVCache, MemorySingleCache } from '@/misc/cache.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { appendQuery, query } from '@/misc/prelude/url.js';
import type { Config } from '@/config.js';
import { normalizeAvatarDecoration } from '@/core/avatar-decoration.js';
import { checkHttps } from '@/misc/check-https.js';
import { isStorableText } from '@/core/chat-room-channels.js';

// Software that serves the Misskey API, which avatar decorations are fetched through, without saying so
const DECORATION_SOFTWARE = ['misskey', 'cherrypick', 'sharkey'];

// 다른 서버의 사용자나 그룹 한 곳에서 받아들이는 장식의 최대 수
const MAX_REMOTE_DECORATIONS = 16;

// 사용자 응답에 쓰는 장식 주소 캐시. 장식 표 전체가 아니라 id별로 보관하고 개수에 상한을 둔다
const URL_CACHE_LIFETIME = 1000 * 60 * 5;
const URL_CACHE_LIMIT = 5000;

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
	private listCacheGeneration = 0;
	private listWithRemoteCacheGeneration = 0;
	private urlCache = new MemoryKVCache<{ id: string; url: string } | null>(URL_CACHE_LIFETIME, URL_CACHE_LIMIT);

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
			const { type, body } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'avatarDecorationCreated':
				case 'avatarDecorationUpdated':
				case 'avatarDecorationDeleted': {
					this.invalidateListCache();
					if (typeof (body as { id?: unknown } | null)?.id === 'string') this.urlCache.delete((body as { id: string }).id);
					break;
				}
				default:
					break;
			}
		}
	}

	private invalidateListCache(): void {
		this.listCacheGeneration++;
		this.listWithRemoteCacheGeneration++;
		this.cache.delete();
		this.cacheWithRemote.delete();
	}

	@bindThis
	public async create(options: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<MiAvatarDecoration> {
		const created = await this.avatarDecorationsRepository.insertOne({
			id: this.idService.gen(),
			...options,
		});

		this.invalidateListCache();
		this.urlCache.delete(created.id);
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

		this.invalidateListCache();
		const updated = await this.avatarDecorationsRepository.findOneByOrFail({ id: avatarDecoration.id });
		this.urlCache.delete(avatarDecoration.id);
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

	/**
	 * 사용자 응답에 쓰는 장식 주소를 id로 찾는다. 장식 표 전체를 읽지 않고, 캐시에 없는 id만 한 번에 조회한다.
	 * 없는 id는 결과에 들어가지 않는다.
	 */
	@bindThis
	public async findUrlsByIds(ids: MiAvatarDecoration['id'][]): Promise<Map<string, { id: string; url: string }>> {
		const found = new Map<string, { id: string; url: string }>();
		const missing: string[] = [];
		for (const id of new Set(ids)) {
			const cached = this.urlCache.get(id);
			if (cached === undefined) missing.push(id);
			else if (cached !== null) found.set(id, cached);
		}
		if (missing.length === 0) return found;

		const rows = await this.avatarDecorationsRepository.find({ select: { id: true, url: true }, where: { id: In(missing) } });
		const byId = new Map(rows.map(row => [row.id, { id: row.id, url: row.url }]));
		for (const id of missing) {
			const row = byId.get(id) ?? null;
			this.urlCache.set(id, row);
			if (row != null) found.set(id, row);
		}
		return found;
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
		return decoration.id;
	}

	@bindThis
	public async resolveChatDecorations(host: string, value: unknown): Promise<MiUser['avatarDecorations'] | undefined> {
		if (!Array.isArray(value) || value.length > MAX_REMOTE_DECORATIONS) return undefined;
		const result: MiUser['avatarDecorations'] = [];
		for (const item of value) {
			if (!this.isValidRemoteDecoration(item)) continue;
			if (typeof item.name !== 'string' || item.name.length > 256 || !isStorableText(item.name)) continue;
			const id = await this.registerRemote(host, item.id, item.url, item.name, undefined, { preserveDescription: true });
			result.push(normalizeAvatarDecoration({ id, angle: item.angle, flipH: item.flipH, offsetX: item.offsetX, offsetY: item.offsetY, scale: item.scale, opacity: item.opacity }));
		}
		return result;
	}

	/**
	 * 다른 서버가 보낸 장식을 저장하지 않고 표시용 값으로만 바꾼다. 형식과 범위는 resolveChatDecorations와 같게 검사한다.
	 */
	@bindThis
	public previewChatDecorations(value: unknown): { id: string; angle: number | undefined; flipH: true | undefined; offsetX: number | undefined; offsetY: number | undefined; scale: number | undefined; opacity: number | undefined; url: string }[] {
		if (!Array.isArray(value) || value.length > MAX_REMOTE_DECORATIONS) return [];
		const result: ReturnType<AvatarDecorationService['previewChatDecorations']> = [];
		for (const item of value) {
			if (!this.isValidRemoteDecoration(item)) continue;
			if (typeof item.name !== 'string' || item.name.length > 256 || !isStorableText(item.name)) continue;
			const d = normalizeAvatarDecoration({ id: item.id, angle: item.angle, flipH: item.flipH, offsetX: item.offsetX, offsetY: item.offsetY, scale: item.scale, opacity: item.opacity });
			result.push({
				id: d.id, angle: d.angle || undefined, flipH: d.flipH || undefined,
				offsetX: d.offsetX || undefined, offsetY: d.offsetY || undefined,
				scale: d.scale || undefined, opacity: d.opacity || undefined, url: this.getProxiedUrl(item.url, 'avatar'),
			});
		}
		return result;
	}

	/** 다른 서버가 알려 준 장식 한 건의 id·주소·flipH·수치 범위를 확인한다. name과 description은 받는 쪽이 따로 확인한다 */
	@bindThis
	private isValidRemoteDecoration(item: unknown): item is Record<string, any> & { id: string; url: string } {
		if (item == null || typeof item !== 'object') return false;
		const d = item as Record<string, unknown>;
		if (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > 32 || !isStorableText(d.id)) return false;
		if (typeof d.url !== 'string' || d.url.length > 4096 || !isStorableText(d.url) || !checkHttps(d.url)) return false;
		try {
			const url = new URL(d.url);
			if (url.username || url.password || this.getProxiedUrl(d.url, 'avatar').length > 1024) return false;
		} catch {
			return false;
		}
		if (d.flipH != null && typeof d.flipH !== 'boolean') return false;
		return this.isDecorationValuesInRange(d);
	}

	@bindThis
	private isDecorationValuesInRange(item: Record<string, unknown>): boolean {
		const ranges = { angle: [-0.5, 0.5], offsetX: [-0.25, 0.25], offsetY: [-0.25, 0.25], scale: [0.5, 1.5], opacity: [0.1, 1] };
		return !Object.entries(ranges).some(([key, [min, max]]) => {
			const value = item[key];
			return value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max);
		});
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
		const userAvatarDecorations: unknown[] = Array.isArray(userData?.avatarDecorations) ? userData.avatarDecorations.slice(0, MAX_REMOTE_DECORATIONS) : [];

		if (userAvatarDecorations.length === 0) {
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

		const allResult: unknown = await allRes.json();
		const allDecorations: any[] = Array.isArray(allResult) ? allResult : [];
		const updates = {} as Partial<MiUser>;
		updates.avatarDecorations = [];

		for (const avatarDecoration of userAvatarDecorations) {
			if (!this.isValidRemoteDecoration(avatarDecoration)) continue;

			let name;
			let description;
			const avatarDecorationId = avatarDecoration.id;

			for (const decoration of allDecorations) {
				if (decoration != null && decoration.id === avatarDecorationId) {
					name = decoration.name;
					description = decoration.description;
					break;
				}
			}

			if (typeof name !== 'string' || name.length > 256 || !isStorableText(name)) continue;
			if (description != null && (typeof description !== 'string' || description.length > 2048 || !isStorableText(description))) continue;

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
			} else if (
				existingDecoration.name !== decorationData.name
				|| (existingDecoration.description ?? null) !== (decorationData.description ?? null)
				|| existingDecoration.url !== decorationData.url
				|| existingDecoration.rawUrl !== decorationData.rawUrl
			) {
				await this.update(existingDecoration.id, decorationData);
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
		this.invalidateListCache();
		this.urlCache.delete(avatarDecoration.id);
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
			this.listCacheGeneration++;
			this.cache.delete();
		}
		if (remoteOnly) {
			// 원격 장식만 담은 목록이 모든 장식의 캐시를 대신하지 않도록 캐시를 거치지 않는다
			return this.avatarDecorationsRepository.find({
				where: {
					host: Not(IsNull()),
				},
			});
		}

		const cache = withRemote ? this.cacheWithRemote : this.cache;
		const cached = cache.get();
		if (cached !== undefined) return cached;

		const generation = withRemote ? this.listWithRemoteCacheGeneration : this.listCacheGeneration;
		const decorations = await this.avatarDecorationsRepository.find(withRemote ? undefined : { where: { host: IsNull() } });
		const currentGeneration = withRemote ? this.listWithRemoteCacheGeneration : this.listCacheGeneration;
		if (currentGeneration === generation) cache.set(decorations);
		return decorations;
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
		this.urlCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
