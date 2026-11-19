/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll, describe, expect, test, vi } from 'vitest';
import { UrlPreviewService } from '@/server/web/UrlPreviewService.js';
import { ChatInviteLinkService } from '@/core/ChatInviteLinkService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import type { MiMeta } from '@/models/Meta.js';

const inviteUrl = 'https://a.example/chat/invite/Ab3dEf6hIj9lMn0p';
const proxySummary = { url: inviteUrl, title: 'proxied', icon: null, thumbnail: null, description: null, sitename: null, sensitive: false, player: { url: null, width: null, height: null, allow: [] }, activityPub: null, fediverseCreator: null };

function createFixture(meta: Partial<MiMeta>) {
	const config = { url: 'https://b.example', host: 'b.example', mediaProxy: 'https://b.example/proxy' };
	const signedGetJson = vi.fn(async () => ({}));
	const getJson = vi.fn(async () => proxySummary);
	const avatar = Object.assign(Object.create(AvatarDecorationService.prototype), { config }) as AvatarDecorationService;
	const invites = Object.assign(Object.create(ChatInviteLinkService.prototype), {
		config,
		apRequestService: { signedGetJson },
		systemAccountService: { fetch: async () => ({ id: 'instance', host: null }) },
		hostPolicyService: { isRefusedRemoteHost: async () => false },
		avatarDecorationService: avatar,
		logger: { info: vi.fn(), warn: vi.fn() },
	}) as ChatInviteLinkService;
	const logger = { info: vi.fn(), succ: vi.fn(), warn: vi.fn() };
	const service = new UrlPreviewService(
		config as never,
		{ urlPreviewEnabled: true, urlPreviewSensitiveList: [], ...meta } as MiMeta,
		{ getJson } as never,
		{ isKeyWordIncluded: () => false } as never,
		{ getLogger: () => logger } as never,
		invites,
	);
	const reply = { code: vi.fn(), header: vi.fn() };
	const handle = async () => service.handle({ query: { url: inviteUrl } } as never, reply as never);
	return { service, signedGetJson, getJson, handle };
}

describe('UrlPreviewService', () => {
	beforeAll(() => {
		vi.stubGlobal('_SUMMALY_VERSION_', 'test');
	});

	test('요약 프록시가 있으면 다른 서버의 초대 링크도 그 서버로 직접 요청하지 않고 프록시에 맡긴다', async () => {
		const { service, signedGetJson, getJson, handle } = createFixture({ urlPreviewSummaryProxyUrl: 'https://proxy.example/summary' });

		const result = await handle() as { title: string; chatInvite?: unknown };

		expect(signedGetJson).not.toHaveBeenCalled();
		expect(getJson).toHaveBeenCalledTimes(1);
		expect((getJson.mock.calls[0] as unknown[])[0]).toMatch(/^https:\/\/proxy\.example\/summary\?/);
		expect(result.title).toBe('proxied');
		expect(result.chatInvite).toBeUndefined();
		service.dispose();
	});

	test('요약 프록시가 없으면 다른 서버의 초대 링크 미리보기를 가져온다', async () => {
		const { service, signedGetJson, handle } = createFixture({});

		await handle();

		expect(signedGetJson).toHaveBeenCalledTimes(1);
		service.dispose();
	});
});
