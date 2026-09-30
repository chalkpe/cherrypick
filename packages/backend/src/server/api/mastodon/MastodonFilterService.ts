/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { MemoryKVCache } from '@/misc/cache.js';
import { checkWordMute } from '@/misc/check-word-mute.js';
import type { MiNote, UserProfilesRepository } from '@/models/_.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import type { MastodonEntity } from 'megalodon';
import type { FastifyRequest } from 'fastify';

type MuteEntry = string | string[];
export type FilterAction = 'warn' | 'hide' | 'blur';
// The Misskey word mutes a filter is kept in: the soft ones ("warn") or the hard ones ("hide")
type MuteList = 'warn' | 'hide';

// Misskey has no word mutes that only blur media, so such filters are kept in the soft word mutes and clients blur the media
function muteListOf(action: FilterAction): MuteList {
	return action === 'hide' ? 'hide' : 'warn';
}

// Misskey word mutes apply everywhere, so every filter reports every context
const ALL_CONTEXTS = ['home', 'notifications', 'public', 'thread', 'account'];

interface StoredKeyword {
	id: string;
	keyword: string;
	wholeWord: boolean;
	// The word mute as it is, for word mutes added outside of the Mastodon API
	entry?: MuteEntry;
}

/**
 * The parts of a Mastodon filter that Misskey word mutes cannot hold.
 */
interface StoredFilter {
	id: string;
	title: string;
	context: string[];
	expiresAt: number | null;
	action: FilterAction;
	keywords: StoredKeyword[];
}

export interface FilterInput {
	title?: string;
	context?: string[];
	action?: FilterAction;
	expiresIn?: number | null;
	keywords?: { id?: string; keyword: string; wholeWord: boolean; destroy?: boolean }[];
}

export class FilterNotFoundError extends Error {
	override name = this.constructor.name;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The Misskey word mute for a Mastodon filter keyword.
 * Mastodon matches keywords case-insensitively, and a whole word only has boundaries on the sides that are word characters.
 */
export function toMuteEntry(keyword: string, wholeWord: boolean): MuteEntry {
	const hasCase = keyword.toLowerCase() !== keyword.toUpperCase();
	if (!wholeWord && !hasCase) return [keyword];

	const start = wholeWord && /^\w/.test(keyword) ? '\\b' : '';
	const end = wholeWord && /\w$/.test(keyword) ? '\\b' : '';
	return `/${start}${escapeRegExp(keyword)}${end}/i`;
}

function sameEntry(a: MuteEntry, b: MuteEntry): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function entryText(entry: MuteEntry): string {
	return Array.isArray(entry) ? entry.join(' ') : entry;
}

function keywordEntry(keyword: StoredKeyword): MuteEntry {
	return keyword.entry ?? toMuteEntry(keyword.keyword, keyword.wholeWord);
}

/**
 * Mastodon keyword filters (/api/v1/filters and /api/v2/filters) on top of Misskey word mutes.
 *
 * Keywords of "warn" and "blur" filters are kept in the soft word mutes and those of "hide" filters in the hard word mutes,
 * so that they apply in Misskey's own clients as well. Titles, contexts and expiry are kept in Redis.
 * Word mutes added outside of the Mastodon API show up as filters of their own.
 */
@Injectable()
export class MastodonFilterService {
	private readonly storedCache = new MemoryKVCache<StoredFilter[]>(1000 * 10);

	constructor(
		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		@Inject(DI.userProfilesRepository)
		private readonly userProfilesRepository: UserProfilesRepository,

		private readonly idService: IdService,
		private readonly clientService: MastodonClientService,
	) {}

	private key(userId: MiUser['id']): string {
		return `mastodonFilters:${userId}`;
	}

	private async loadStored(userId: MiUser['id']): Promise<StoredFilter[]> {
		const cached = this.storedCache.get(userId);
		if (cached) return cached;

		const raw = await this.redisClient.hvals(this.key(userId));
		const filters = raw.map(r => JSON.parse(r) as StoredFilter);
		this.storedCache.set(userId, filters);
		return filters;
	}

	private async saveStored(userId: MiUser['id'], filter: StoredFilter): Promise<void> {
		await this.redisClient.hset(this.key(userId), filter.id, JSON.stringify(filter));
		this.storedCache.delete(userId);
	}

	private async deleteStored(userId: MiUser['id'], filterId: string): Promise<void> {
		await this.redisClient.hdel(this.key(userId), filterId);
		this.storedCache.delete(userId);
	}

	private async getWordMutes(userId: MiUser['id']): Promise<Record<MuteList, MuteEntry[]>> {
		const profile = await this.userProfilesRepository.findOneByOrFail({ userId });
		return { warn: profile.mutedWords, hide: profile.hardMutedWords };
	}

	/**
	 * Replaces word mutes through the Misskey API, so that its limits and change notifications apply.
	 */
	private async updateWordMutes(request: FastifyRequest, changes: { remove: [MuteList, MuteEntry][], add: [MuteList, MuteEntry][] }, userId: MiUser['id']): Promise<void> {
		if (changes.remove.length === 0 && changes.add.length === 0) return;

		const mutes = await this.getWordMutes(userId);
		for (const [list, entry] of changes.remove) {
			const index = mutes[list].findIndex(e => sameEntry(e, entry));
			if (index >= 0) mutes[list].splice(index, 1);
		}
		for (const [list, entry] of changes.add) {
			if (!mutes[list].some(e => sameEntry(e, entry))) mutes[list].push(entry);
		}

		await this.clientService.callApi(request, 'i/update', { mutedWords: mutes.warn, hardMutedWords: mutes.hide });
	}

	private entriesOf(filter: StoredFilter): [MuteList, MuteEntry][] {
		return filter.keywords.map(k => [muteListOf(filter.action), keywordEntry(k)]);
	}

	private syntheticId(list: MuteList, entry: MuteEntry): string {
		return `misskey-${list}-${Buffer.from(JSON.stringify(entry)).toString('base64url')}`;
	}

	private parseSyntheticId(id: string): [MuteList, MuteEntry] | null {
		const match = /^misskey-(warn|hide)-([A-Za-z0-9_-]+)$/.exec(id);
		if (!match) return null;
		try {
			return [match[1] as MuteList, JSON.parse(Buffer.from(match[2], 'base64url').toString()) as MuteEntry];
		} catch {
			return null;
		}
	}

	private toEntity(filter: StoredFilter): MastodonEntity.FilterV2 {
		return {
			id: filter.id,
			title: filter.title,
			context: filter.context,
			expires_at: filter.expiresAt != null ? new Date(filter.expiresAt).toISOString() : null,
			filter_action: filter.action,
			keywords: filter.keywords.map(k => ({ id: k.id, keyword: k.keyword, whole_word: k.wholeWord })),
			statuses: [],
		};
	}

	/**
	 * All filters of a user, as Mastodon filters that still hold only the keywords present in the word mutes.
	 * Expired filters are removed along with their word mutes when a request is given.
	 */
	private async resolve(userId: MiUser['id'], request?: FastifyRequest): Promise<StoredFilter[]> {
		const [stored, mutes] = await Promise.all([this.loadStored(userId), this.getWordMutes(userId)]);

		const expired = stored.filter(f => f.expiresAt != null && f.expiresAt <= Date.now());
		if (expired.length > 0 && request) {
			await this.updateWordMutes(request, { remove: expired.flatMap(f => this.entriesOf(f)), add: [] }, userId);
			await Promise.all(expired.map(f => this.deleteStored(userId, f.id)));
			return await this.resolve(userId);
		}

		const active = stored.filter(f => !expired.includes(f));
		const owned: [MuteList, MuteEntry][] = [];
		const filters = active.map(f => ({
			...f,
			// Keywords whose word mute was removed elsewhere, such as in Misskey's settings, are gone
			keywords: f.keywords.filter(k => {
				const entry = keywordEntry(k);
				const list = muteListOf(f.action);
				const present = mutes[list].some(e => sameEntry(e, entry));
				if (present) owned.push([list, entry]);
				return present;
			}),
		}));

		for (const list of ['warn', 'hide'] as const) {
			for (const entry of mutes[list]) {
				if (owned.some(([l, e]) => l === list && sameEntry(e, entry))) continue;
				const id = this.syntheticId(list, entry);
				const keyword = entryText(entry);
				filters.push({ id, title: keyword, context: ALL_CONTEXTS, expiresAt: null, action: list, keywords: [{ id, keyword, wholeWord: false, entry }] });
			}
		}

		return filters;
	}

	public async list(me: MiLocalUser, request: FastifyRequest): Promise<MastodonEntity.FilterV2[]> {
		return (await this.resolve(me.id, request)).map(f => this.toEntity(f));
	}

	public async get(me: MiLocalUser, request: FastifyRequest, id: string): Promise<MastodonEntity.FilterV2> {
		const filter = (await this.resolve(me.id, request)).find(f => f.id === id);
		if (!filter) throw new FilterNotFoundError();
		return this.toEntity(filter);
	}

	public async create(me: MiLocalUser, request: FastifyRequest, input: FilterInput): Promise<MastodonEntity.FilterV2> {
		const filter: StoredFilter = {
			id: this.idService.gen(),
			title: input.title ?? input.keywords?.[0]?.keyword ?? '',
			context: input.context?.length ? input.context : ALL_CONTEXTS,
			expiresAt: input.expiresIn ? Date.now() + input.expiresIn * 1000 : null,
			action: input.action ?? 'warn',
			keywords: (input.keywords ?? []).filter(k => !k.destroy && k.keyword !== '').map(k => ({ id: this.idService.gen(), keyword: k.keyword, wholeWord: k.wholeWord })),
		};

		await this.updateWordMutes(request, { remove: [], add: this.entriesOf(filter) }, me.id);
		await this.saveStored(me.id, filter);
		return this.toEntity(filter);
	}

	/**
	 * Updates a filter. A filter that only exists as a word mute becomes a stored filter.
	 */
	public async update(me: MiLocalUser, request: FastifyRequest, id: string, input: FilterInput): Promise<MastodonEntity.FilterV2> {
		const current = (await this.resolve(me.id, request)).find(f => f.id === id);
		if (!current) throw new FilterNotFoundError();

		let keywords = current.keywords;
		for (const change of input.keywords ?? []) {
			const existing = change.id ? keywords.find(k => k.id === change.id) : undefined;
			if (existing && change.destroy) {
				keywords = keywords.filter(k => k !== existing);
			} else if (existing) {
				keywords = keywords.map(k => (k === existing ? { id: k.id, keyword: change.keyword || k.keyword, wholeWord: change.wholeWord } : k));
			} else if (!change.destroy && change.keyword !== '') {
				keywords = [...keywords, { id: this.idService.gen(), keyword: change.keyword, wholeWord: change.wholeWord }];
			}
		}

		const updated: StoredFilter = {
			id: this.parseSyntheticId(id) ? this.idService.gen() : current.id,
			title: input.title ?? current.title,
			context: input.context?.length ? input.context : current.context,
			expiresAt: input.expiresIn !== undefined ? (input.expiresIn ? Date.now() + input.expiresIn * 1000 : null) : current.expiresAt,
			action: input.action ?? current.action,
			keywords,
		};

		await this.updateWordMutes(request, { remove: this.entriesOf(current), add: this.entriesOf(updated) }, me.id);
		if (updated.id !== current.id) await this.deleteStored(me.id, current.id);
		await this.saveStored(me.id, updated);
		return this.toEntity(updated);
	}

	public async delete(me: MiLocalUser, request: FastifyRequest, id: string): Promise<void> {
		const current = (await this.resolve(me.id, request)).find(f => f.id === id);
		if (!current) throw new FilterNotFoundError();

		await this.updateWordMutes(request, { remove: this.entriesOf(current), add: [] }, me.id);
		await this.deleteStored(me.id, current.id);
	}

	/**
	 * The filter holding a keyword, for the keyword endpoints.
	 */
	public async findByKeyword(me: MiLocalUser, request: FastifyRequest, keywordId: string): Promise<{ filter: MastodonEntity.FilterV2, keyword: MastodonEntity.FilterKeyword }> {
		for (const filter of await this.list(me, request)) {
			const keyword = filter.keywords.find(k => k.id === keywordId);
			if (keyword) return { filter, keyword };
		}
		throw new FilterNotFoundError();
	}

	/**
	 * Filters matching a note, for the "filtered" property of statuses.
	 */
	public async match(note: Pick<MiNote, 'userId' | 'text' | 'cw'>, me: MiLocalUser): Promise<MastodonEntity.FilterResult[]> {
		if (note.userId === me.id || (!note.text && !note.cw)) return [];

		const results: MastodonEntity.FilterResult[] = [];
		for (const filter of await this.resolve(me.id)) {
			const matches: string[] = [];
			for (const keyword of filter.keywords) {
				if (await checkWordMute(note, me, [keywordEntry(keyword)])) matches.push(keyword.keyword);
			}
			if (matches.length > 0) {
				results.push({ filter: this.toEntity(filter), keyword_matches: matches, status_matches: [] });
			}
		}
		return results;
	}
}
