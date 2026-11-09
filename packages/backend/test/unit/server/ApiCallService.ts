/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { ApiCallService } from '@/server/api/ApiCallService.js';
import MembersEndpoint, { meta as membersMeta, paramDef as membersParams } from '@/server/api/endpoints/chat/rooms/members.js';
import Logger from '@/logger.js';
import { envOption } from '@/env.js';
import { logManager } from '@/logging/logging-runtime.js';
import { PrettyConsoleBackend } from '@/logging/PrettyConsoleBackend.js';
import type { LogBackend } from '@/logging/LogBackend.js';
import type { LogRecord } from '@/logging/types.js';

/** API失敗ログを確認するための最小Fastify応答を作成します。 */
function createReply() {
	return {
		code: vi.fn(),
		header: vi.fn(),
		send: vi.fn(),
	};
}

/** APIサービスの依存関係を最小限の仮実装へ差し替えます。 */
function createService() {
	const authenticateService = {
		authenticate: vi.fn().mockResolvedValue([null, null]),
	};
	const telemetryService = {
		startSpan: vi.fn((_name: string, callback: () => unknown) => callback()),
		captureMessage: vi.fn(),
	};
	const apiLoggerService = { logger: new Logger('api') };

	const service = new ApiCallService(
		{} as never,
		{} as never,
		{} as never,
		authenticateService as never,
		{} as never,
		{} as never,
		apiLoggerService as never,
		telemetryService as never,
	);
	return { service, telemetryService, authenticateService };
}

describe('ApiCallService structured error logging', () => {
	test('redacts API credentials and serializes the endpoint error', async () => {
		const write = vi.fn<LogBackend['write']>();
		logManager.setBackend({ write });
		const previousQuiet = envOption.quiet;
		envOption.quiet = false;
		const { service, telemetryService } = createService();
		try {
			const reply = createReply();
			const endpoint = {
				name: 'notes/show',
				meta: {},
				params: {},
				exec: vi.fn().mockRejectedValue(new TypeError('broken endpoint')),
			};
			const request = {
				method: 'POST',
				body: {
					i: 'native-token',
					password: 'password',
					options: { visible: true },
				},
				query: {},
				headers: {},
				ip: '127.0.0.1',
			};

			await service.handleRequest(endpoint as never, request as never, reply as never);

			const record = write.mock.calls[0][0] as LogRecord;
			expect(record).toMatchObject({
				eventName: 'api.endpoint.failed',
				attributes: {
					'api.endpoint': 'notes/show',
					'api.params': {
						i: '[REDACTED]',
						password: '[REDACTED]',
						options: { visible: true },
					},
				},
				error: { type: 'TypeError', message: 'broken endpoint' },
			});
			expect(record.attributes?.['error.id']).toEqual(expect.any(String));
			expect(telemetryService.captureMessage.mock.calls[0][1].extra).not.toHaveProperty('ps');
		} finally {
			service.dispose();
			envOption.quiet = previousQuiet;
			logManager.setBackend(new PrettyConsoleBackend({ output: () => undefined }));
		}
	});
});

describe('Play token authorization', () => {
	for (const multipart of [false, true]) {
		for (const secure of [false, true]) {
			test(`rejects ${secure ? 'secure' : 'ungranted'} endpoints over ${multipart ? 'multipart' : 'JSON'}`, async () => {
				const { service, authenticateService } = createService();
				authenticateService.authenticate.mockResolvedValue([{ id: 'user' }, null, { permissions: [] }]);
				const endpoint = { name: 'test', meta: { secure, kind: 'write:notes', requireCredential: true }, params: {}, exec: vi.fn() };
				const reply = createReply();
				const request = {
					method: 'POST', body: { i: 'flash-token' }, headers: {}, ip: '127.0.0.1',
					file: async () => ({ file: Readable.from(['test']), filename: 'test.txt', fields: { i: { value: 'flash-token' } } }),
				};
				try {
					if (multipart) await service.handleMultipartRequest(endpoint as never, request as never, reply as never);
					else await service.handleRequest(endpoint as never, request as never, reply as never);
					expect(endpoint.exec).not.toHaveBeenCalled();
					expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: secure ? 'ACCESS_DENIED' : 'PERMISSION_DENIED' }) }));
					if (secure) expect(reply.code).toHaveBeenCalledWith(403);
				} finally {
					service.dispose();
				}
			});
		}
	}
});

describe('chat room member listing permissions', () => {
	test.each([
		['write only', ['write:chat'], true, 'PERMISSION_DENIED'],
		['read only', ['read:chat'], true, null],
		['read and write', ['read:chat', 'write:chat'], true, null],
		['nonmember with read', ['read:chat'], false, 'NO_SUCH_ROOM'],
	] as const)('%s', async (_label, permission, member, errorCode) => {
		const { service, authenticateService } = createService();
		authenticateService.authenticate.mockResolvedValue([{ id: 'user' }, { permission }, null]);
		const chat = {
			checkChatAvailability: vi.fn().mockResolvedValue(undefined),
			findRoomById: vi.fn().mockResolvedValue({ id: 'room1' }),
			isRoomMember: vi.fn().mockResolvedValue(member),
			getRoomMembershipsWithPagination: vi.fn().mockResolvedValue([{ id: 'member' }]),
		};
		const entities = { packRoomMemberships: vi.fn().mockResolvedValue([{ id: 'member' }]) };
		const endpoint = new MembersEndpoint(chat as never, entities as never, {} as never);
		const reply = createReply();
		const request = { method: 'POST', body: { i: 'app-token', roomId: 'room1' }, headers: {}, ip: '127.0.0.1' };
		try {
			await service.handleRequest({ name: 'chat/rooms/members', meta: membersMeta, params: membersParams, exec: endpoint.exec } as never, request as never, reply as never);
			if (errorCode == null) {
				expect(reply.send).toHaveBeenCalledWith([{ id: 'member' }]);
			} else {
				expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: errorCode }) }));
				expect(entities.packRoomMemberships).not.toHaveBeenCalled();
			}
		} finally {
			service.dispose();
		}
	});
});
