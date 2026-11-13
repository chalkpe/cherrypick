/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { ActivityPubAccessControlService } from '@/core/ActivityPubAccessControlService.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { renderChatInvitePreview } from '@/core/chat-invite-link.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import type { Config } from '@/config.js';

const baseUrl = 'https://invite.example';
const code = 'Ab3dEf6hIj9lMn0p';
const path = `/chat/invite/${code}`;
const actor = { id: 'instance', host: 'consumer.example', uri: 'https://consumer.example/users/instance', isSuspended: false };
const keyId = `${actor.uri}#main-key`;
const preview = {
	id: `${baseUrl}${path}`, type: 'Invite',
	object: {
		id: `${baseUrl}/chat/rooms/room1`, type: 'Group', name: '모임', summary: '설명',
		_misskey_chatArchived: false, _misskey_chatRoomMembersCount: 2,
		icon: { type: 'Image', url: `${baseUrl}/icon.png` }, _misskey_chatIconDecorations: [],
	},
	endpoints: { sharedInbox: `${baseUrl}/inbox` },
};
const keys = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** 실제 Fastify 경로·HTTP 서명 검증·호스트 정책을 실행하며 저장소 조회만 대역으로 둔다. */
async function fixture(options: { blocked?: boolean; suspended?: boolean; federation?: 'all' | 'none' } = {}) {
	const config = { host: 'invite.example', url: baseUrl } as Config;
	const meta = { federation: options.federation ?? 'all', blockedHosts: options.blocked ? [actor.host] : [], silencedHosts: [] };
	const utility = new UtilityService(config, meta as never);
	const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
	const resolver = {
		getAuthUserFromKeyId: async (id: string) => id === keyId ? { user: { ...actor, isSuspended: options.suspended === true }, key: { keyPem: keys.publicKey } } : null,
	};
	const access = new ActivityPubAccessControlService(
		meta as never, { findOneBy: async () => null } as never, utility,
		{ getLogger: () => logger } as never, resolver as never,
	);
	const service = Object.assign(Object.create(ActivityPubServerService.prototype), {
		config, meta, activityPubAccessControlService: access, apDbResolverService: resolver,
		apRendererService: { addContext: (value: object) => value },
		chatInviteLinkService: {
			renderLocalPreviewDocument: async () => renderChatInvitePreview({
				baseUrl, code, room: { id: 'room1', name: '모임', description: '설명', isArchived: false }, membersCount: 2,
				icon: { url: `${baseUrl}/icon.png`, decorations: [] },
			}),
		},
	}) as ActivityPubServerService;
	const server = Fastify();
	await server.register((instance, _options, done) => service.createServer(instance, {}, done));
	await server.ready();
	return server;
}

async function signedHeaders() {
	const signed = await ApRequestCreator.createSignedGet({
		key: { keyId, privateKeyPem: keys.privateKey }, url: `${baseUrl}${path}`, additionalHeaders: {},
	});
	return { ...signed.request.headers, host: 'invite.example', accept: 'application/activity+json' };
}

describe('서버 간 초대 미리보기의 접근 정책', () => {
	test.each([
		['서명 없는 조회', {}, false],
		['허용된 서버의 유효한 서명', {}, true],
		['정지된 계정의 유효한 서명', { suspended: true }, true],
	])('%s에 공개 정보만 준다', async (_label, options, signed) => {
		const server = await fixture(options);
		try {
			const headers = signed ? await signedHeaders() : { host: 'invite.example', accept: 'application/activity+json' };
			const response = await server.inject({ method: 'GET', url: path, headers });

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(preview);
			expect(response.headers['cache-control']).toBe('private, no-store');
		} finally {
			await server.close();
		}
	});

	test.each([
		['차단한 서버', { blocked: true }],
		['정지된 계정이 서명한 차단 서버', { blocked: true, suspended: true }],
		['연합이 꺼진 발급 서버', { federation: 'none' as const }],
	])('%s는 거부한다', async (_label, options) => {
		const server = await fixture(options);
		try {
			const response = await server.inject({ method: 'GET', url: path, headers: await signedHeaders() });

			expect(response.statusCode).toBe(403);
		} finally {
			await server.close();
		}
	});
});
