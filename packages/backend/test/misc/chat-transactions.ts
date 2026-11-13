/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * What a chat send asks of a PostgreSQL transaction: advisory locks that stay held until the transaction ends.
 * `held` lets a test keep a send's lock, as a send still storing its message would.
 */
export function chatTransactions(manager: Record<string, unknown> = {}) {
	const held = new Set<string>();
	const transaction = async <T>(work: (manager: any) => Promise<T>): Promise<T> => {
		const mine: string[] = [];
		const query = async (sql: string, parameters: unknown[] = []) => {
			const key = String(parameters[0]);
			if (sql.includes('pg_try_advisory_xact_lock')) {
				if (held.has(key)) return [{ free: false }];
				held.add(key);
				mine.push(key);
				return [{ free: true }];
			}
			if (sql.includes('pg_advisory_xact_lock')) {
				if (held.has(key)) throw new Error('this test does not wait for a lock');
				held.add(key);
				mine.push(key);
				return [];
			}
			throw new Error(`query not supported in this test: ${sql}`);
		};
		try {
			return await work({ withRepository: (repository: unknown) => repository, ...manager, query });
		} finally {
			for (const key of mine) held.delete(key);
		}
	};
	return { transaction, held };
}
