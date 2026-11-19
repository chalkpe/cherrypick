/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import { NodeinfoServerService } from '@/server/NodeinfoServerService.js';

async function setup() {
	const metaFetch = vi.fn(async () => ({
		name: 'node', description: null, repositoryUrl: 'https://repo.example/r', policies: {}, langs: [],
	}));
	const chart = { getChart: vi.fn(async () => ({ local: { total: [1] } })) };
	const service = new NodeinfoServerService(
		{ url: 'https://node.example', version: '1.0.0', basedMisskeyVersion: '2.0.0' } as never,
		{ fetch: async () => ({ username: 'proxy' }) } as never,
		{ fetch: metaFetch } as never,
		chart as never,
		chart as never,
	);
	const app = Fastify();
	await app.register(service.createServer);
	return { app, metaFetch };
}

const get = (app: Awaited<ReturnType<typeof setup>>['app'], url: string, ua: string) =>
	app.inject({ method: 'GET', url, headers: { 'user-agent': ua } });

test('같은 변형의 연속 요청은 한 번만 계산한다', async () => {
	const { app, metaFetch } = await setup();
	const first = await get(app, '/nodeinfo/2.1', 'curl/8');
	const second = await get(app, '/nodeinfo/2.1', 'curl/8');
	expect(metaFetch).toHaveBeenCalledTimes(1);
	expect(second.json()).toEqual(first.json());
});

test('버전과 User-Agent 별 응답이 서로 섞이지 않는다', async () => {
	const { app, metaFetch } = await setup();
	const urls = ['/nodeinfo/2.1', '/nodeinfo/2.0'];
	const uas = ['curl/8', 'JoinMisskey/1'];
	for (let round = 0; round < 2; round++) {
		for (const url of urls) {
			for (const ua of uas) {
				const body = (await get(app, url, ua)).json();
				expect(body.software.name).toBe(ua.startsWith('JoinMisskey') ? 'misskey' : 'cherrypick');
				expect(body.version).toBe(url.endsWith('2.1') ? '2.1' : '2.0');
				expect('repository' in body.software).toBe(url.endsWith('2.1'));
			}
		}
	}
	expect(metaFetch).toHaveBeenCalledTimes(4);
});

test('응답에 Vary: User-Agent가 붙는다', async () => {
	const { app } = await setup();
	for (const url of ['/nodeinfo/2.1', '/nodeinfo/2.0']) {
		const res = await get(app, url, 'curl/8');
		expect(res.headers.vary).toMatch(/user-agent/i);
	}
});
