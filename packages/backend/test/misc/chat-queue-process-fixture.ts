/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { loadConfig } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { createPostgresDataSource } from '@/postgres.js';
import { QueueProcessorModule } from '@/queue/QueueProcessorModule.js';
import { QueueProcessorService } from '@/queue/QueueProcessorService.js';

export type ChatQueueProcessMessage = { type: 'ready' } | { type: 'error'; message: string };

// 별도 작업 처리 프로세스다. 운영 부팅(boot/common.ts)처럼 QueueProcessorModule의 작업 처리기를 띄운다.
// 부모가 만든 일회용 DB를 빌리며 스키마를 초기화하지 않는다.
const config = loadConfig();
if (process.send == null || process.env.CHAT_PROCESS_FIXTURE_DB !== config.db.db) throw new Error('chat queue process fixture requires its parent and explicit test database');

// 읽기 복제본을 쓰는 설정을 재현할 때만 부모가 복제본 주소를 준다.
const replica = process.env.CHAT_PROCESS_FIXTURE_REPLICA?.split(':');
const replication = replica == null ? {} : { dbReplications: true, dbSlaves: [{ ...config.db, host: replica[0], port: Number(replica[1]) }] };

// TypeORM은 생성자에서 cache provider를 만든다. 생성 뒤 cache:false만 설정하면 연결이 남는다.
const db = createPostgresDataSource({ ...config, ...replication, db: { ...config.db, disableCache: true } });
db.setOptions({ synchronize: false, dropSchema: false, cache: false });
if (db.queryResultCache != null) throw new Error('chat queue process fixture must not allocate a database cache');
let app: TestingModule | undefined;

try {
	await db.initialize();
	app = await Test.createTestingModule({ imports: [QueueProcessorModule] })
		.overrideProvider(DI.db).useValue(db)
		.compile();
	await app.init();
	// run()은 처리기가 닫힐 때까지 끝나지 않는다. 운영 부팅과 같이 기다리지 않고, 실패는 부모에게 알린다.
	app.get(QueueProcessorService).start().catch((error: unknown) => {
		process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies ChatQueueProcessMessage);
	});
	process.send({ type: 'ready' } satisfies ChatQueueProcessMessage);
} catch (error) {
	process.send({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies ChatQueueProcessMessage);
	await app?.close();
	if (db.isInitialized) await db.destroy();
	process.exitCode = 1;
	process.disconnect?.();
}
