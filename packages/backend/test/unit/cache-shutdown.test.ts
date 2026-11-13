/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { CacheService } from '../../src/core/CacheService.js';

test('종료 전에 진행 중인 사용자 캐시 갱신을 기다리고 새 이벤트를 받지 않는다', async () => {
	const subscriber = new EventEmitter();
	let finish!: (value: null) => void;
	const query = vi.fn(() => new Promise<null>(resolve => { finish = resolve; }));
	const cache = new CacheService({} as never, subscriber as never, { findOneBy: query } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
	subscriber.emit('message', 'test', JSON.stringify({ channel: 'internal', message: { type: 'localUserUpdated', body: { id: 'user' } } }));
	expect(query).toHaveBeenCalledTimes(1);

	let stopped = false;
	const closing = cache.beforeApplicationShutdown().then(() => { stopped = true; });
	await Promise.resolve();
	expect(stopped).toBe(false);
	subscriber.emit('message', 'test', JSON.stringify({ channel: 'internal', message: { type: 'localUserUpdated', body: { id: 'other' } } }));
	expect(query).toHaveBeenCalledTimes(1);
	finish(null);
	await closing;
	cache.dispose();
});
