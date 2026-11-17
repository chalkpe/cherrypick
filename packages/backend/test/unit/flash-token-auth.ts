/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { AuthenticateService, AuthenticationError } from '@/server/api/AuthenticateService.js';
import { StreamingApiServerService } from '@/server/api/StreamingApiServerService.js';
import GenTokenEndpoint from '@/server/api/endpoints/flash/gen-token.js';
import UpdateNoteEndpoint from '@/server/api/endpoints/notes/update.js';
import CreateAccountEndpoint from '@/server/api/endpoints/admin/accounts/create.js';
import { MemoryKVCache } from '@/misc/cache.js';

const FLASH = 'a'.repeat(32); // not a native token (native tokens are 16 chars)

function authFixture(stored: unknown, currentUser: Record<string, unknown> | null) {
	const flashCache = new Map<string, unknown>(stored === undefined ? [] : [[FLASH, stored]]);
	const usersRepository = {
		findOneBy: vi.fn().mockResolvedValue(currentUser),
		findOneByOrFail: vi.fn().mockResolvedValue(currentUser),
	};
	const cacheService = {
		flashAccessTokensCache: { get: vi.fn(async (k: string) => flashCache.get(k) ?? null), set: vi.fn(async (k: string, v: unknown) => { flashCache.set(k, v); }) },
		localUserByIdCache: new MemoryKVCache<any>(1000 * 60),
		localUserByNativeTokenCache: new MemoryKVCache<any>(1000 * 60),
	};
	const service = new AuthenticateService(
		usersRepository as any,
		{ findOne: vi.fn().mockResolvedValue(null), update: vi.fn() } as any,
		{} as any,
		cacheService as any,
	);
	return { service, cacheService, usersRepository };
}

describe('Play token authentication', () => {
	test('stores only the user id and the permissions when issued', async () => {
		const { cacheService } = authFixture(undefined, null);
		const endpoint = new GenTokenEndpoint(cacheService as any);
		const res = await endpoint.exec({ permissions: ['write:notes'] }, { id: 'me', isSuspended: false, token: 'native', username: 'me' } as any, null, null) as { token: string };
		const saved = (cacheService.flashAccessTokensCache.set as any).mock.calls[0][1];
		expect(saved).toEqual({ userId: 'me', permissions: ['write:notes'] });
		expect(res.token).toBe((cacheService.flashAccessTokensCache.set as any).mock.calls[0][0]);
	});

	test('uses the current user instead of the stored snapshot', async () => {
		const { service } = authFixture({ userId: 'me', permissions: ['write:notes'] }, { id: 'me', isSuspended: true, isDeleted: false });
		const [user, app, flash] = await service.authenticate(FLASH);
		expect(user).toMatchObject({ id: 'me', isSuspended: true });
		expect(app).toBeNull();
		expect(flash?.permissions).toEqual(['write:notes']);
	});

	test('reads a value stored in the earlier shape without throwing', async () => {
		const { service } = authFixture({ user: { id: 'me', isSuspended: false }, permissions: ['write:notes'] }, { id: 'me', isSuspended: true, isDeleted: false });
		const [user, , flash] = await service.authenticate(FLASH);
		expect(user).toMatchObject({ id: 'me', isSuspended: true });
		expect(flash?.permissions).toEqual(['write:notes']);
	});

	test('rejects the token when the user is deleted or gone', async () => {
		for (const current of [null, { id: 'me', isDeleted: true, isSuspended: false }]) {
			const { service } = authFixture({ userId: 'me', permissions: [] }, current);
			await expect(service.authenticate(FLASH)).rejects.toBeInstanceOf(AuthenticationError);
		}
	});

	test('rejects a stored value that has no user', async () => {
		const { service } = authFixture({ permissions: ['write:notes'] }, { id: 'me', isDeleted: false });
		await expect(service.authenticate(FLASH)).rejects.toBeInstanceOf(AuthenticationError);
	});
});

describe('streaming with a Play token', () => {
	test('rejects the connection', async () => {
		const flash = { permissions: [], user: { id: 'me' } };
		const authenticate = vi.fn().mockResolvedValue([{ id: 'me', isSuspended: false }, null, flash]);
		const create = vi.fn();
		const service = new StreamingApiServerService(
			new EventEmitter() as any,
			{ create, registerRequestByContextId: vi.fn() } as any,
			{ authenticate } as any,
			{} as any,
			{ handles: () => false } as any,
			{ handles: () => false } as any,
		);
		const server = new EventEmitter();
		service.attach(server as any);
		const socket = { write: vi.fn(), destroy: vi.fn() };
		server.emit('upgrade', { url: '/streaming?i=token', headers: { host: 'localhost' } }, socket, Buffer.alloc(0));
		await new Promise(resolve => setImmediate(resolve));
		expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401 Unauthorized'));
		expect(socket.destroy).toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});
});

describe('session-only checks with a Play token', () => {
	test('notes/update refuses visibility changes', async () => {
		const note = { id: 'note', userId: 'author', visibility: 'public', channelId: null };
		const roleService = { isModerator: vi.fn().mockResolvedValue(true), isAdministrator: vi.fn().mockResolvedValue(true), getUserPolicies: vi.fn() };
		const noteUpdateService = { updateVisibility: vi.fn() };
		const endpoint = new UpdateNoteEndpoint(
			{} as any, { getNote: vi.fn().mockResolvedValue(note) } as any,
			roleService as any, { pack: vi.fn() } as any, noteUpdateService as any,
		);
		await expect(endpoint.exec({ noteId: 'note', visibility: 'home' }, { id: 'moderator' } as any, null, { permissions: ['write:notes'] } as any)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(noteUpdateService.updateVisibility).not.toHaveBeenCalled();
	});

	test('admin/accounts/create refuses to create accounts', async () => {
		const signup = vi.fn();
		const endpoint = new CreateAccountEndpoint(
			{} as any, { rootUserId: 'root' } as any,
			{ findOneByOrFail: vi.fn().mockResolvedValue({ id: 'admin' }) } as any,
			{} as any, { signup } as any, { isAdministrator: vi.fn().mockResolvedValue(true) } as any,
		);
		await expect(endpoint.exec({ username: 'newuser', password: 'password' }, { id: 'admin' } as any, null, { permissions: [] } as any)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(signup).not.toHaveBeenCalled();
	});
});
