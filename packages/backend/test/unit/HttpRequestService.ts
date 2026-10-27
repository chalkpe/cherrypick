/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { StatusError } from '@/misc/status-error.js';
import type { Config } from '@/config.js';
import type { AddressInfo } from 'node:net';

describe('HttpRequestService.send', () => {
	let server: http.Server;
	let origin: string;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			if (req.url === '/start') {
				res.writeHead(302, { location: '/end' });
				res.end();
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"reached":true}');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	});

	test('follows redirects by default', async () => {
		const service = new HttpRequestService({ userAgent: 'test' } as Config);

		const res = await service.send(`${origin}/start`);

		expect(await res.json()).toEqual({ reached: true });
	});

	test('reports a redirect as a status error when asked not to follow it', async () => {
		const service = new HttpRequestService({ userAgent: 'test' } as Config);

		const sent = service.send(`${origin}/start`, { redirect: 'manual' });

		await expect(sent).rejects.toBeInstanceOf(StatusError);
		await expect(sent).rejects.toMatchObject({ statusCode: 302 });
	});
});
