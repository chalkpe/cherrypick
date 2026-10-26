/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import pg from 'pg';
import { Brackets } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import EventsSearchEndpoint from '@/server/api/endpoints/notes/events/search.js';
import type { Config } from '@/config.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { QueryService } from '@/core/QueryService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { NotesRepository } from '@/models/_.js';

type CapturedWhere = { sql: string; params?: Record<string, unknown> };

function createRecordingQueryBuilder(wheres: CapturedWhere[]) {
	const record = (condition: string | Brackets, params?: Record<string, unknown>) => {
		if (condition instanceof Brackets) {
			const inner = {
				where: (sql: string, p?: Record<string, unknown>) => (wheres.push({ sql, params: p }), inner),
				orWhere: (sql: string, p?: Record<string, unknown>) => (wheres.push({ sql, params: p }), inner),
				andWhere: (sql: string, p?: Record<string, unknown>) => (wheres.push({ sql, params: p }), inner),
			};
			condition.whereFactory(inner as never);
		} else {
			wheres.push({ sql: condition, params });
		}
		return qb;
	};
	const chain = () => qb;
	const qb = {
		andWhere: record,
		innerJoinAndSelect: chain,
		leftJoinAndSelect: chain,
		orderBy: chain,
		skip: chain,
		maxExecutionTime: chain,
		limit: chain,
		getMany: async () => [],
	};
	return qb;
}

describe('notes/events/search endpoint', () => {
	let db: pg.Client;
	let wheres: CapturedWhere[];
	let endpoint: EventsSearchEndpoint;

	beforeAll(async () => {
		const config = loadConfig();
		db = new pg.Client({
			host: config.db.host,
			port: config.db.port,
			user: config.db.user,
			password: config.db.pass,
			database: config.db.db,
		});
		await db.connect();
	});

	afterAll(async () => {
		await db.end();
	});

	beforeEach(() => {
		wheres = [];
		const qb = createRecordingQueryBuilder(wheres);
		const notesRepository = { createQueryBuilder: () => qb } as unknown as NotesRepository;
		const queryService = {
			makePaginationQuery: vi.fn((q: unknown) => q),
			generateVisibilityQuery: vi.fn(),
			generateBaseNoteFilteringQuery: vi.fn(),
		} as unknown as QueryService;
		const roleService = {
			getUserPolicies: vi.fn().mockResolvedValue({ canSearchNotes: true }),
		} as unknown as RoleService;
		const noteEntityService = {
			packMany: vi.fn().mockResolvedValue([]),
		} as unknown as NoteEntityService;
		endpoint = new EventsSearchEndpoint({} as Config, notesRepository, noteEntityService, queryService, roleService);
	});

	async function metadataPattern(values: (string | null)[]): Promise<string> {
		wheres.length = 0;
		await endpoint.exec({ filters: [{ key: ['location'], values }] }, null, null, null);
		const where = wheres.find(w => w.sql.includes('~*'));
		if (where?.params?.values == null) throw new Error('metadata regex filter was not built');
		return where.params.values as string;
	}

	/** Evaluate the pattern with PostgreSQL's own `~*` operator, the same one the endpoint uses. */
	async function pgMatches(text: string, pattern: string): Promise<boolean> {
		const res = await db.query<{ matched: boolean }>('SELECT $1::text ~* $2::text AS matched', [text, pattern]);
		return res.rows[0].matched;
	}

	test('treats regex metacharacters in filter values as literal text', async () => {
		const pattern = await metadataPattern(['(a|b)+']);

		expect(await pgMatches('(a|b)+', pattern)).toBe(true);
		expect(await pgMatches('Venue (A|B)+ Hall', pattern)).toBe(true);
		expect(await pgMatches('a', pattern)).toBe(false);
		expect(await pgMatches('b', pattern)).toBe(false);
	});

	test('keeps case-insensitive substring matching for normal values', async () => {
		const pattern = await metadataPattern(['tokyo']);

		expect(await pgMatches('Tokyo Big Sight', pattern)).toBe(true);
		expect(await pgMatches('Osaka', pattern)).toBe(false);
	});

	test('keeps OR semantics across multiple values', async () => {
		const pattern = await metadataPattern(['osaka', 'tokyo']);

		expect(await pgMatches('Tokyo', pattern)).toBe(true);
		expect(await pgMatches('OSAKA', pattern)).toBe(true);
		expect(await pgMatches('Kyoto', pattern)).toBe(false);
	});

	test('does not let wildcards or nested quantifiers match arbitrary text', async () => {
		const wildcard = await metadataPattern(['.*']);
		expect(await pgMatches('anything', wildcard)).toBe(false);
		expect(await pgMatches('x.*y', wildcard)).toBe(true);

		const nested = await metadataPattern(['(a+)+$']);
		expect(await pgMatches('aaaa', nested)).toBe(false);
		expect(await pgMatches('(a+)+$', nested)).toBe(true);
	});

	test('treats PostgreSQL class escapes as literal backslash sequences', async () => {
		const pattern = await metadataPattern(['\\d']);

		expect(await pgMatches('5', pattern)).toBe(false);
		expect(await pgMatches('path\\dir', pattern)).toBe(true);
	});

	test('accepts a trailing backslash as literal text instead of a broken regex', async () => {
		const pattern = await metadataPattern(['C:\\']);

		expect(await pgMatches('c:\\temp', pattern)).toBe(true);
		expect(await pgMatches('C:', pattern)).toBe(false);
	});

	test('trims values and keeps the missing-metadata clause alongside escaped values', async () => {
		const pattern = await metadataPattern(['  (a|b)+  ', null]);

		expect(await pgMatches('(A|B)+', pattern)).toBe(true);
		expect(await pgMatches('a', pattern)).toBe(false);
		expect(wheres.some(w => w.sql === 'NOT (event.metadata ? :key)')).toBe(true);
	});
});
