/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { ApiCallService } from '@/server/api/ApiCallService.js';
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
				} finally {
					service.dispose();
				}
			});
		}
	}
});
