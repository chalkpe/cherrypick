/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { MeilisearchApiError } from 'meilisearch';
import { DI } from '@/di-symbols.js';
import { type Config, FulltextSearchProvider } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { MiNote } from '@/models/Note.js';
import type { MiMeta, NotesRepository } from '@/models/_.js';
import { MiUser } from '@/models/_.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { CacheService } from '@/core/CacheService.js';
import { QueryService } from '@/core/QueryService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type { Index, Meilisearch } from 'meilisearch';

const MEILISEARCH_MAX_TOTAL_HITS = 10_000;
const MEILISEARCH_MAX_BATCH_SIZE = 256;

type K = string;
type V = string | number | boolean;
type Q =
	{ op: '=', k: K, v: V } |
	{ op: '!=', k: K, v: V } |
	{ op: '>', k: K, v: string | number } |
	{ op: '<', k: K, v: string | number } |
	{ op: '>=', k: K, v: number } |
	{ op: '<=', k: K, v: number } |
	{ op: 'is null', k: K } |
	{ op: 'is not null', k: K } |
	{ op: 'and', qs: Q[] } |
	{ op: 'or', qs: Q[] } |
	{ op: 'not', q: Q };

export type SearchOpts = {
	userId?: MiNote['userId'] | null;
	channelId?: MiNote['channelId'] | null;
	host?: string | null;
	rangeStartAt?: number | null;
	rangeEndAt?: number | null;
};

export type SearchPagination = {
	untilId?: MiNote['id'];
	sinceId?: MiNote['id'];
	untilDate?: number;
	sinceDate?: number;
	limit: number;
};

function isAscending(pagination: SearchPagination): boolean {
	return (pagination.sinceId != null || pagination.sinceDate != null)
		&& pagination.untilId == null && pagination.untilDate == null;
}

function compileValue(value: V): string {
	if (typeof value === 'string') {
		return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`;
	} else if (typeof value === 'number') {
		return value.toString();
	} else if (typeof value === 'boolean') {
		return value.toString();
	}
	throw new Error('unrecognized value');
}

function compileQuery(q: Q): string {
	switch (q.op) {
		case '=': return `(${q.k} = ${compileValue(q.v)})`;
		case '!=': return `(${q.k} != ${compileValue(q.v)})`;
		case '>': return `(${q.k} > ${compileValue(q.v)})`;
		case '<': return `(${q.k} < ${compileValue(q.v)})`;
		case '>=': return `(${q.k} >= ${compileValue(q.v)})`;
		case '<=': return `(${q.k} <= ${compileValue(q.v)})`;
		case 'and': return q.qs.length === 0 ? '' : `(${ q.qs.map(_q => compileQuery(_q)).join(' AND ') })`;
		case 'or': return q.qs.length === 0 ? '' : `(${ q.qs.map(_q => compileQuery(_q)).join(' OR ') })`;
		case 'is null': return `(${q.k} IS NULL)`;
		case 'is not null': return `(${q.k} IS NOT NULL)`;
		case 'not': return `(NOT ${compileQuery(q.q)})`;
		default: throw new Error('unrecognized query operator');
	}
}

function hasMismatchedSearchSettings(error: unknown): boolean {
	if (!(error instanceof MeilisearchApiError) || error.cause == null) return false;
	const { code, message } = error.cause;
	switch (code) {
		case 'invalid_search_sort': return message.includes('Attribute `id` is not sortable')
			|| message.includes('You must specify where `sort` is listed in the rankingRules setting');
		case 'invalid_search_filter': return /Attribute `(?:createdAt|id|userId|userHost|channelId)` is not filterable/u.test(message);
		default: return false;
	}
}

@Injectable()
export class SearchService {
	private readonly meilisearchIndexScope: 'local' | 'global' | string[] = 'local';
	private readonly meilisearchNoteIndex: Index | null = null;
	private meilisearchSettingsReady: Promise<boolean> | undefined;
	private usesLexicalDatabaseOrder: Promise<boolean> | undefined;
	private readonly provider: FulltextSearchProvider;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meilisearch)
		private meilisearch: Meilisearch | null,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private cacheService: CacheService,
		private queryService: QueryService,
		private idService: IdService,
		private loggerService: LoggerService,

		@Inject(DI.meta)
		private meta: MiMeta,
	) {
		if (meilisearch) {
			this.meilisearchNoteIndex = meilisearch.index(`${config.meilisearch!.index}---notes`);
		}

		if (config.meilisearch?.scope) {
			this.meilisearchIndexScope = config.meilisearch.scope;
		}

		this.provider = config.fulltextSearch?.provider ?? 'sqlLike';
		this.loggerService.getLogger('SearchService').info(`-- Provider: ${this.provider}`);
	}

	private prepareMeilisearchIndex(index: Index): Promise<boolean> {
		// 기존 문서의 id를 사용한다. 설정 적용이 끝난 뒤부터 같은 키로 정렬하고 검색한다.
		return this.meilisearchSettingsReady ??= index.updateSettings({
			searchableAttributes: ['text', 'cw'],
			sortableAttributes: ['createdAt', 'id'],
			filterableAttributes: ['createdAt', 'id', 'userId', 'userHost', 'channelId', 'tags'],
			rankingRules: ['sort'],
			typoTolerance: { enabled: false },
			pagination: { maxTotalHits: MEILISEARCH_MAX_TOTAL_HITS },
		}).waitTask({ timeout: 30_000 }).then(async task => {
			if (task.status !== 'succeeded') {
				throw new Error(`Meilisearch note index settings task ${task.uid} ${task.status}: ${task.error?.message ?? ''}`);
			}
			// Meilisearch 1.3.4 sorts strings but accepts only numbers in range filters.
			try {
				await index.search('', { filter: "id < 'a'", limit: 1, attributesToRetrieve: ['id'] });
				return true;
			} catch (error) {
				if (error instanceof MeilisearchApiError && error.cause?.code === 'invalid_search_filter' && error.cause.message.startsWith('invalid float literal')) {
					return false;
				}
				throw error;
			}
		}).catch(error => {
			this.meilisearchSettingsReady = undefined;
			throw error;
		});
	}

	private canUseAidTimeBounds(): Promise<boolean> {
		// Only use ID bounds with collations that sort the AID/AIDX alphabet lexically.
		return this.usesLexicalDatabaseOrder ??= this.notesRepository.query(`
			SELECT COALESCE(to_jsonb(db)->>'datlocprovider', 'c') = 'c'
				AND datcollate IN ('C', 'POSIX', 'C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8') AS allowed
			FROM pg_database AS db WHERE datname = current_database()
		`).then(([row]: { allowed: boolean }[]) => row?.allowed === true).catch(error => {
			this.usesLexicalDatabaseOrder = undefined;
			throw error;
		});
	}

	@bindThis
	public async indexNote(note: MiNote): Promise<void> {
		if (!this.meilisearch) return;
		if (note.text == null && note.cw == null) return;
		if (!['home', 'public'].includes(note.visibility)) return;

		switch (this.meilisearchIndexScope) {
			case 'global':
				break;

			case 'local':
				if (note.userHost == null) break;
				return;

			default: {
				if (note.userHost == null) break;
				if (this.meilisearchIndexScope.includes(note.userHost)) break;
				return;
			}
		}

		await this.meilisearchNoteIndex?.addDocuments([{
			id: note.id,
			createdAt: this.idService.parse(note.id).date.getTime(),
			userId: note.userId,
			userHost: note.userHost,
			channelId: note.channelId,
			cw: note.cw,
			text: note.text,
			tags: note.tags,
		}], {
			primaryKey: 'id',
		});
	}

	@bindThis
	public async unindexNote(note: MiNote): Promise<void> {
		if (!this.meilisearch) return;
		if (!['home', 'public'].includes(note.visibility)) return;

		await this.meilisearchNoteIndex?.deleteDocument(note.id);
	}

	@bindThis
	public async searchNote(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		switch (this.provider) {
			case 'sqlLike':
			case 'sqlPgroonga': {
				// ほとんど内容に差がないのでsqlLikeとsqlPgroongaを同じ処理にしている.
				// 今後の拡張で差が出る用であれば関数を分ける.
				return this.searchNoteByLike(q, me, opts, pagination);
			}
			case 'meilisearch': {
				return this.searchNoteByMeilisearch(q, me, opts, pagination);
			}
			default: {
				const _: never = this.provider;
				return [];
			}
		}
	}

	@bindThis
	private async searchNoteByLike(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'), pagination.sinceId, pagination.untilId);

		if (opts.userId) {
			query.andWhere('note.userId = :userId', { userId: opts.userId });
		} else if (opts.channelId) {
			query.andWhere('note.channelId = :channelId', { channelId: opts.channelId });
		}

		query
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		if (this.config.fulltextSearch?.provider === 'sqlPgroonga') {
			query.andWhere('note.text &@~ :q', { q });
		} else {
			query.andWhere('LOWER(note.text) LIKE :q', { q: `%${ sqlLikeEscape(q.toLowerCase()) }%` });
		}

		if (opts.host) {
			if (opts.host === '.') {
				query.andWhere('note.userHost IS NULL');
			} else {
				query.andWhere('note.userHost = :host', { host: opts.host });
			}
		}

		if (opts.rangeStartAt != null || opts.rangeEndAt != null || pagination.sinceDate != null || pagination.untilDate != null) {
			const timestamp = this.idService.timestampSql('note.id');
			if (opts.rangeStartAt != null) query.andWhere(`${timestamp} >= CAST(:rangeStartAt AS numeric)`, { rangeStartAt: opts.rangeStartAt });
			if (opts.rangeEndAt != null) query.andWhere(`${timestamp} <= CAST(:rangeEndAt AS numeric)`, { rangeEndAt: opts.rangeEndAt });
			if (pagination.sinceDate != null) query.andWhere(`${timestamp} > CAST(:sinceDate AS numeric)`, { sinceDate: pagination.sinceDate });
			if (pagination.untilDate != null) query.andWhere(`${timestamp} < CAST(:untilDate AS numeric)`, { untilDate: pagination.untilDate });

			const lower = this.idService.aidTimePrefix(Math.max(opts.rangeStartAt ?? -Infinity, (pagination.sinceDate ?? -Infinity) + 1));
			const upper = this.idService.aidTimePrefix(Math.min((opts.rangeEndAt ?? Infinity) + 1, pagination.untilDate ?? Infinity));
			if ((lower != null || upper != null) && await this.canUseAidTimeBounds()) {
				if (lower != null) query.andWhere('note.id >= :lowerTimeId', { lowerTimeId: lower });
				if (upper != null) query.andWhere('note.id < :upperTimeId', { upperTimeId: upper });
			}
		}
		query.orderBy('note.id', isAscending(pagination) ? 'ASC' : 'DESC');

		this.queryService.generateNoteContentVisibilityQuery(query, me);
		this.queryService.generateBaseNoteFilteringQuery(query, me);

		return await query.limit(pagination.limit).getMany();
	}

	@bindThis
	private async searchNoteByMeilisearch(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		const index = this.meilisearchNoteIndex;
		if (!index) {
			throw new Error('Meilisearch is not available');
		}

		const filter: Q = {
			op: 'and',
			qs: [],
		};
		if (pagination.untilDate != null) filter.qs.push({ op: '<', k: 'createdAt', v: pagination.untilDate });
		if (opts.rangeEndAt != null) filter.qs.push({
			op: '<=',
			k: 'createdAt',
			v: opts.rangeEndAt,
		});
		if (pagination.sinceDate != null) filter.qs.push({ op: '>', k: 'createdAt', v: pagination.sinceDate });
		if (opts.rangeStartAt != null) filter.qs.push({
			op: '>=',
			k: 'createdAt',
			v: opts.rangeStartAt,
		});
		if (opts.userId) filter.qs.push({ op: '=', k: 'userId', v: opts.userId });
		if (opts.channelId) filter.qs.push({ op: '=', k: 'channelId', v: opts.channelId });
		if (opts.host) {
			if (opts.host === '.') {
				filter.qs.push({ op: 'is null', k: 'userHost' });
			} else {
				filter.qs.push({ op: '=', k: 'userHost', v: opts.host });
			}
		}
		if (me == null) {
			if (this.meta.ugcVisibilityForVisitor === 'none') return [];
			if (this.meta.ugcVisibilityForVisitor === 'local') filter.qs.push({ op: 'is null', k: 'userHost' });
		}
		let settings = this.prepareMeilisearchIndex(index);
		const supportsIdRange = await settings;
		if (pagination.untilId) {
			if (supportsIdRange) {
				filter.qs.push({ op: '<', k: 'id', v: pagination.untilId });
			} else {
				const time = this.idService.parseCursorTime(pagination.untilId);
				if (time != null) filter.qs.push({ op: '<=', k: 'createdAt', v: time });
			}
		}
		if (pagination.sinceId) {
			if (supportsIdRange) {
				filter.qs.push({ op: '>', k: 'id', v: pagination.sinceId });
			} else {
				const time = this.idService.parseCursorTime(pagination.sinceId);
				if (time != null) filter.qs.push({ op: '>=', k: 'createdAt', v: time });
			}
		}

		const [
			userIdsWhoMeMuting,
			userIdsWhoBlockingMe,
		] = me
			? await Promise.all([
				this.cacheService.userMutingsCache.fetch(me.id),
				this.cacheService.userBlockedCache.fetch(me.id),
			])
			: [new Set<string>(), new Set<string>()];

		const query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		query.where('note.id IN (:...noteIds)').andWhere('note.visibility IN (\'public\', \'home\')');
		this.queryService.generateNoteContentVisibilityQuery(query, me);
		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const notes: MiNote[] = [];
		const ascending = isAscending(pagination);
		let cursor: string | undefined;
		let batchSize = Math.max(pagination.limit, 32);
		let scanned = 0;
		let restoredSettings = false;
		while (notes.length < pagination.limit && scanned < MEILISEARCH_MAX_TOTAL_HITS) {
			const limit = Math.min(batchSize, MEILISEARCH_MAX_TOTAL_HITS - scanned);
			const batchFilter: Q = cursor == null || !supportsIdRange ? filter : {
				op: 'and',
				qs: [...filter.qs, { op: ascending ? '>' : '<', k: 'id', v: cursor }],
			};
			const search = () => index.search<{ id: string }>(q, {
				sort: [ascending ? 'id:asc' : 'id:desc'],
				matchingStrategy: 'all',
				attributesToRetrieve: ['id'],
				filter: compileQuery(batchFilter),
				limit,
				offset: supportsIdRange ? undefined : scanned,
			});
			const { hits } = await search().catch(async (error: unknown) => {
				if (restoredSettings || !hasMismatchedSearchSettings(error)) throw error;
				restoredSettings = true;
				if (this.meilisearchSettingsReady === settings) this.meilisearchSettingsReady = undefined;
				settings = this.prepareMeilisearchIndex(index);
				await settings;
				return search();
			});
			scanned += hits.length;

			const noteIds = [...new Set(hits.map(hit => hit.id).filter(id =>
				(cursor == null || (ascending ? id > cursor : id < cursor))
				&& (pagination.sinceId == null || id > pagination.sinceId)
				&& (pagination.untilId == null || id < pagination.untilId)))];
			if (noteIds.length > 0) {
				cursor = noteIds.at(-1);
				const candidates = (await query.setParameter('noteIds', noteIds).getMany()).filter(note =>
					!isUserRelated(note, userIdsWhoBlockingMe) && !isUserRelated(note, userIdsWhoMeMuting));
				const visibleById = new Map(candidates.map(note => [note.id, note]));
				for (const id of noteIds) {
					const note = visibleById.get(id);
					if (note) notes.push(note);
					if (notes.length === pagination.limit) break;
				}
			} else if (supportsIdRange) {
				break;
			}
			if (hits.length < limit) break;
			batchSize = Math.min(batchSize * 2, MEILISEARCH_MAX_BATCH_SIZE);
		}

		return notes;
	}
}
