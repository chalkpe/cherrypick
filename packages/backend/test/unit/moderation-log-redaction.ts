/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import UpdateMetaEndpoint from '@/server/api/endpoints/admin/update-meta.js';
import ShowModerationLogsEndpoint from '@/server/api/endpoints/admin/show-moderation-logs.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { ModerationLogEntityService } from '@/core/entities/ModerationLogEntityService.js';

const KEY_ID = 'turn-key-id-0123456789';
const API_TOKEN = 'secret-api-token-0123456789';
const NEW_KEY_ID = 'turn-key-id-abcdefghij';
const NEW_API_TOKEN = 'secret-api-token-abcdefghij';

const SECRETS = [KEY_ID, API_TOKEN, NEW_KEY_ID, NEW_API_TOKEN];

function expectNoSecrets(value: unknown) {
	const json = JSON.stringify(value);
	for (const secret of SECRETS) expect(json).not.toContain(secret);
}

function createFixture(initial: Record<string, unknown> = {}) {
	// MetaService.fetch(true) はメモリ上の meta (キャッシュ) そのものを返す
	let current: Record<string, unknown> = {
		id: 'x',
		name: 'server',
		voiceCallCloudflareTurnKeyId: null,
		voiceCallCloudflareTurnApiToken: null,
		...initial,
	};
	const metaService = {
		fetch: vi.fn(async () => current),
		update: vi.fn(async (set: Record<string, unknown>) => {
			current = { ...current, ...set };
			return current;
		}),
	};

	// DB に入る形 (jsonb) で覚えておく
	const rows: { id: string; userId: string; type: string; info: Record<string, any> }[] = [];
	const moderationLogsRepository = {
		insert: vi.fn(async (row: { id: string; userId: string; type: string; info: Record<string, any> }) => {
			rows.push(JSON.parse(JSON.stringify(row)));
		}),
	};
	const idService = { gen: () => `log${rows.length}`, parse: () => ({ date: new Date(0) }) };
	const moderationLogService = new ModerationLogService(moderationLogsRepository as any, idService as any);
	const endpoint = new (UpdateMetaEndpoint as any)(
		{ resolve: async () => ({ start: vi.fn(), dispose: vi.fn() }) }, {}, metaService, moderationLogService,
	);
	const entityService = new ModerationLogEntityService(
		{} as any,
		{ pack: async () => ({ id: 'admin' }) } as any,
		idService as any,
	);

	async function update(params: Record<string, unknown>) {
		await endpoint.exec(params, { id: 'admin' }, undefined);
		await vi.waitFor(() => expect(moderationLogsRepository.insert).toHaveBeenCalled());
		const stored = rows.at(-1)!;
		const packed = await entityService.pack({ ...stored, user: null } as any);
		return { stored, packed };
	}

	return { update, entityService, getMeta: () => current };
}

function turnFields(side: Record<string, unknown>) {
	return {
		voiceCallCloudflareTurnKeyId: side.voiceCallCloudflareTurnKeyId,
		voiceCallCloudflareTurnApiToken: side.voiceCallCloudflareTurnApiToken,
	};
}

describe('moderation logs of server settings keep the Cloudflare TURN key out', () => {
	test('setting the key for the first time records only that it is set', async () => {
		const f = createFixture();

		const { stored, packed } = await f.update({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });

		expectNoSecrets(stored);
		expectNoSecrets(packed);
		expect(turnFields(stored.info.before)).toEqual({ voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiToken: null });
		expect(turnFields(stored.info.after)).toEqual({ voiceCallCloudflareTurnKeyId: '(set)', voiceCallCloudflareTurnApiToken: '(set)' });
		expect(packed.info).toEqual(stored.info);
		// メモリ上の meta は書き換えない
		expect(turnFields(f.getMeta())).toEqual({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });
	});

	test('changing another setting while the key is set keeps the other change visible', async () => {
		const f = createFixture({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });

		const { stored, packed } = await f.update({ name: 'renamed' });

		expectNoSecrets(stored);
		expectNoSecrets(packed);
		expect(stored.info.before.name).toBe('server');
		expect(stored.info.after.name).toBe('renamed');
		expect(turnFields(stored.info.before)).toEqual({ voiceCallCloudflareTurnKeyId: '(set)', voiceCallCloudflareTurnApiToken: '(set)' });
		expect(turnFields(stored.info.after)).toEqual({ voiceCallCloudflareTurnKeyId: '(set)', voiceCallCloudflareTurnApiToken: '(set)' });
		expect(turnFields(f.getMeta())).toEqual({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });
	});

	test('replacing the key records that it changed', async () => {
		const f = createFixture({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });

		const { stored, packed } = await f.update({ voiceCallCloudflareTurnKeyId: NEW_KEY_ID, voiceCallCloudflareTurnApiToken: NEW_API_TOKEN });

		expectNoSecrets(stored);
		expectNoSecrets(packed);
		expect(turnFields(stored.info.before)).toEqual({ voiceCallCloudflareTurnKeyId: '(set)', voiceCallCloudflareTurnApiToken: '(set)' });
		expect(turnFields(stored.info.after)).toEqual({ voiceCallCloudflareTurnKeyId: '(changed)', voiceCallCloudflareTurnApiToken: '(changed)' });
	});

	test('clearing the key records that it is no longer set', async () => {
		const f = createFixture({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });

		const { stored, packed } = await f.update({ voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiToken: '' });

		expectNoSecrets(stored);
		expectNoSecrets(packed);
		expect(turnFields(stored.info.before)).toEqual({ voiceCallCloudflareTurnKeyId: '(set)', voiceCallCloudflareTurnApiToken: '(set)' });
		expect(turnFields(stored.info.after)).toEqual({ voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiToken: null });
	});

	test('hides the key in logs that were stored before it was redacted', async () => {
		const f = createFixture();
		const log = {
			id: 'old',
			userId: 'admin',
			user: null,
			type: 'updateServerSettings',
			info: {
				before: { name: 'server', voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN },
				after: { name: 'renamed', voiceCallCloudflareTurnKeyId: NEW_KEY_ID, voiceCallCloudflareTurnApiToken: null },
			},
		};

		const packed = await f.entityService.pack(log as any);

		expectNoSecrets(packed);
		expect(packed.info).toEqual({
			before: { name: 'server', voiceCallCloudflareTurnKeyId: '(set)', voiceCallCloudflareTurnApiToken: '(set)' },
			after: { name: 'renamed', voiceCallCloudflareTurnKeyId: '(changed)', voiceCallCloudflareTurnApiToken: null },
		});
		// 保存されているものは書き換えない
		expect(log.info.before.voiceCallCloudflareTurnApiToken).toBe(API_TOKEN);
	});

	test.each([
		['role policy changes', 'updateServerSettings', { before: { canVoiceCall: true }, after: { canVoiceCall: false } }],
		['logs from servers that predate the setting', 'updateServerSettings', { before: { name: 'a' }, after: { name: 'b' } }],
		['logs without before', 'updateServerSettings', { before: null, after: { name: 'b' } }],
		['other kinds of logs', 'updateUserNote', { userId: 'u', before: 'a', after: 'b' }],
	])('leaves %s as they are', async (_label, type, info) => {
		const f = createFixture();

		const packed = await f.entityService.pack({ id: 'old', userId: 'admin', user: null, type, info } as any);

		expect(packed.info).toEqual(info);
	});
});

describe('searching moderation logs', () => {
	test('does not look into the Cloudflare TURN key of stored server settings', async () => {
		const query: Record<string, any> = {
			andWhere: vi.fn((_sql: string, _parameters?: Record<string, string>) => query),
			limit: vi.fn(() => query),
			getMany: vi.fn(async () => []),
		};
		const endpoint = new (ShowModerationLogsEndpoint as any)(
			{ createQueryBuilder: () => query },
			{ packMany: async () => [] },
			{ makePaginationQuery: () => query },
		);

		await endpoint.exec({ search: API_TOKEN.slice(0, 8) }, { id: 'admin' }, undefined);

		const [where, parameters] = (query.andWhere as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) => String(sql).includes('ILIKE')) as [string, Record<string, string>];
		expect(parameters.search).toBe(`%${API_TOKEN.slice(0, 8)}%`);
		for (const side of ['before', 'after']) {
			for (const key of ['voiceCallCloudflareTurnKeyId', 'voiceCallCloudflareTurnApiToken']) {
				expect(where).toContain(`'{${side},${key}}'`);
			}
		}
		expect(where).not.toMatch(/log\.info::text/);
	});
});
