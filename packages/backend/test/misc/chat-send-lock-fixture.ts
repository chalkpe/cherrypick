/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import pg from 'pg';

export type SendLockFixtureInput = {
	database: pg.ClientConfig;
	messageId: string;
};

// 실제 프로세스가 끝날 때 PostgreSQL이 전송 잠금을 푸는지 검사하는 전용 연결이다.
process.once('message', async ({ database, messageId }: SendLockFixtureInput) => {
	const client = new pg.Client(database);
	try {
		await client.connect();
		await client.query('BEGIN');
		await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-message-send:${messageId}`]);
		process.send?.({ type: 'locked' });
	} catch (error) {
		process.send?.({ type: 'error', message: String(error) });
		await client.end();
		process.exitCode = 1;
		process.disconnect?.();
	}
});
