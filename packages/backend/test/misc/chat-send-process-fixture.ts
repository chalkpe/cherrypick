/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { MainModule } from '@/MainModule.js';
import { loadConfig } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { createPostgresDataSource } from '@/postgres.js';
import { ServerService } from '@/server/ServerService.js';

export type ChatSendProcessMessage = { type: 'ready'; port: number } | { type: 'error'; message: string };

// 별도 HTTP 전송 프로세스다. 부모가 만든 일회용 DB를 빌리며 스키마를 초기화하지 않는다.
const config = loadConfig();
if (process.send == null || process.env.CHAT_PROCESS_FIXTURE_DB !== config.db.db) throw new Error('chat send process fixture requires its parent and explicit test database');

// 읽기 복제본을 쓰는 설정(dbReplications)을 재현할 때만 부모가 복제본 주소를 준다.
const replica = process.env.CHAT_PROCESS_FIXTURE_REPLICA?.split(':');
const replication = replica == null ? {} : { dbReplications: true, dbSlaves: [{ ...config.db, host: replica[0], port: Number(replica[1]) }] };
const redisPort = process.env.CHAT_PROCESS_FIXTURE_REDIS_PORT;
const serverConfig = redisPort == null ? config : { ...config, redis: { ...config.redis, host: '127.0.0.1', port: Number(redisPort) } };

// TypeORM은 생성자에서 cache provider를 만든다. 생성 뒤 cache:false만 설정하면 연결이 남는다.
const db = createPostgresDataSource({ ...config, ...replication, db: { ...config.db, disableCache: true } });
db.setOptions({ synchronize: false, dropSchema: false, cache: false });
if (db.queryResultCache != null) throw new Error('chat send process fixture must not allocate a database cache');
let app: TestingModule | undefined;

try {
	await db.initialize();
	app = await Test.createTestingModule({ imports: [MainModule] })
		.overrideProvider(DI.config).useValue({ ...serverConfig, port: 0 })
		.overrideProvider(DI.db).useValue(db)
		.compile();
	await app.init();
	const server = app.get(ServerService);
	await server.launch();
	const address = server.fastify.server.address();
	if (address == null || typeof address === 'string') throw new Error('chat send process fixture did not bind a TCP port');
	process.send({ type: 'ready', port: address.port } satisfies ChatSendProcessMessage);
} catch (error) {
	process.send({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies ChatSendProcessMessage);
	await app?.close();
	if (db.isInitialized) await db.destroy();
	process.exitCode = 1;
	process.disconnect?.();
}
