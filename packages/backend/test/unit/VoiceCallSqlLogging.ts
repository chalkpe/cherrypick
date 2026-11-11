/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { createPostgresDataSource } from '@/postgres.js';
import { logManager } from '@/logging/logging-runtime.js';
import type { Config } from '@/config.js';

test('SQL query, error and slow-query logs do not expose voice credentials', () => {
	const written = vi.spyOn(logManager, 'write').mockImplementation(() => {});
	const config = { db: { host: 'localhost', port: 5432, user: 'test', pass: '', db: 'test' }, redis: {}, logging: { sql: { enableQueryParamLogging: true } } } as Config;
	const logger = createPostgresDataSource(config).logger;
	const secret = 'voice-secret-should-not-appear-in-logs';
	try {
		for (const field of ['voiceCallLivekitApiSecret', 'voiceCallCloudflareTurnApiToken']) {
			const query = `UPDATE "meta" SET "${field}" = $1`;
			logger.logQuery(query, [secret]);
			logger.logQueryError('error', query, [secret]);
			logger.logQuerySlow(500, query, [secret]);
		}
		expect(written).toHaveBeenCalledTimes(6);
		expect(JSON.stringify(written.mock.calls)).not.toContain(secret);

		logger.logQuery('UPDATE "meta" SET "name" = $1', ['ordinary-value']);
		expect(JSON.stringify(written.mock.calls)).toContain('ordinary-value');
	} finally {
		written.mockRestore();
	}
});
