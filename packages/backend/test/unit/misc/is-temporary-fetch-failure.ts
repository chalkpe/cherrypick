/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DownloadService } from '@/core/DownloadService.js';
import { isTemporaryFetchFailure } from '@/misc/is-temporary-fetch-failure.js';
import { StatusError } from '@/misc/status-error.js';

// 本物の DownloadService で本物のソケットから失敗させる。モックした例外では、実際に飛んでくる例外の形を確かめられない
describe('what a real download failure looks like', () => {
	let server: http.Server;
	let base: string;
	let dir: string;
	const logger = { info: () => {}, warn: () => {}, succ: () => {}, error: () => {} };

	function downloader(maxFileSize = 1024 * 1024) {
		return new DownloadService(
			{ maxFileSize, userAgent: 'test' } as never,
			{ getAgentForHttp: () => undefined, getAgentForHttps: () => undefined } as never,
			{ getLogger: () => logger } as never,
		);
	}

	async function failureOf(url: string, service = downloader()) {
		return await service.downloadUrl(url, path.join(dir, 'file')).then(() => null, err => err);
	}

	function expectTemporary(err: unknown, temporary: boolean) {
		const error = err as { name?: string; code?: string; message?: string } | null;
		expect(isTemporaryFetchFailure(err), `${error?.name} ${error?.code} ${error?.message}`).toBe(temporary);
	}

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporary-fetch-failure-'));
		server = http.createServer((req, res) => {
			const status = /^\/status\/(\d+)$/.exec(req.url ?? '');
			if (status) {
				res.statusCode = Number(status[1]);
				res.end('nope');
			} else if (req.url === '/reset') {
				req.socket.destroy();
			} else if (req.url === '/cut') {
				res.writeHead(200, { 'content-length': '1000' });
				res.write('only a part');
				setTimeout(() => req.socket.destroy(), 20);
			} else if (req.url === '/cut-without-length') {
				res.write('only a part');
				setTimeout(() => req.socket.destroy(), 20);
			} else {
				res.end('x'.repeat(4096));
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test.each([429, 500, 502, 503, 504])('a %i is worth trying again', async (code) => {
		expectTemporary(await failureOf(`${base}/status/${code}`), true);
	});

	test.each([400, 401, 403, 404, 410])('a %i is not', async (code) => {
		const err = await failureOf(`${base}/status/${code}`);

		expect(err).toBeInstanceOf(StatusError);
		expectTemporary(err, false);
	});

	test('a connection that breaks is worth trying again', async () => {
		expectTemporary(await failureOf(`${base}/reset`), true);
	});

	test('a download cut off halfway is worth trying again', async () => {
		expectTemporary(await failureOf(`${base}/cut`), true);
	});

	test('a download without a length cut off halfway is worth trying again', async () => {
		expectTemporary(await failureOf(`${base}/cut-without-length`), true);
	});

	test('a server that does not answer is worth trying again', async () => {
		const closed = http.createServer();
		await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
		const { port } = closed.address() as AddressInfo;
		await new Promise(resolve => closed.close(resolve));

		expectTemporary(await failureOf(`http://127.0.0.1:${port}/`), true);
	});

	test('a file over the size limit will stay over it', async () => {
		const err = await failureOf(`${base}/large`, downloader(16));

		expect(err).not.toBeNull();
		expectTemporary(err, false);
	});
});

describe('failures that are not about the network', () => {
	test.each([
		['the drive being full', new Error('No free space.')],
		['a plain error', new Error('boom')],
		['a redirect loop', Object.assign(new Error('too many'), { code: 'ERR_TOO_MANY_REDIRECTS' })],
		['nothing at all', null],
	])('%s is not worth trying again', (_name, err) => {
		expect(isTemporaryFetchFailure(err)).toBe(false);
	});

	test('a cause deeper down counts', () => {
		expect(isTemporaryFetchFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }))).toBe(true);
	});

	test('a status error decides by its status', () => {
		expect(isTemporaryFetchFailure(new StatusError('Too Many Requests', 429))).toBe(true);
		expect(isTemporaryFetchFailure(new StatusError('Not Found', 404))).toBe(false);
	});
});
