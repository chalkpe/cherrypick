/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { EntityNotFoundError } from 'typeorm';
import { UserKeypairService } from '../../src/core/UserKeypairService.js';
import { MiUserKeypair } from '../../src/models/UserKeypair.js';

test('키 행 부재는 내부 조회에서만 구분하고 기존 공개 조회 오류를 보존한다', async () => {
	const missing = new EntityNotFoundError(MiUserKeypair, { userId: 'owner' });
	const keys = new UserKeypairService({ get: async () => null } as any, { findOneByOrFail: async () => { throw missing; } } as any);
	try {
		expect(await keys.getUserKeypairAvailability('owner')).toEqual({ available: false });
		await expect(keys.getUserKeypair('owner')).rejects.toBe(missing);
		await expect(keys.fetcher('owner')).rejects.toBe(missing);
	} finally {
		keys.dispose();
	}
});

test.each(['repository', 'redis', 'redisNotFound', 'decode', 'migration'] as const)('%s 오류는 키 부재로 바꾸지 않는다', async phase => {
	const failure = phase === 'redisNotFound' ? new EntityNotFoundError(MiUserKeypair, {}) : new Error('temporary dependency error');
	const keys = new UserKeypairService({ get: async () => {
		if (phase === 'redis' || phase === 'redisNotFound') throw failure;
		return phase === 'decode' ? '{' : null;
	} } as any, { findOneByOrFail: async () => {
		if (phase === 'repository') throw failure;
		return { privateKey: '-----BEGIN RSA PRIVATE KEY-----invalid synthetic key' };
	} } as any);
	try {
		if (phase === 'decode' || phase === 'migration') {
			await expect(keys.getUserKeypairAvailability('owner')).rejects.toBeInstanceOf(Error);
		} else {
			await expect(keys.getUserKeypairAvailability('owner')).rejects.toBe(failure);
			await expect(keys.getUserKeypair('owner')).rejects.toBe(failure);
		}
	} finally {
		keys.dispose();
	}
});
