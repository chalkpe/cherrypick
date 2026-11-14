/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';

const LOCAL = 'https://local.test';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const owner = { id: 'owner', host: null, uri: null, isSuspended: false };
const member = { id: 'member', host: 'remote.test', uri: 'https://remote.test/users/member', isSuspended: false };
const invitee = { id: 'invitee', host: 'remote.test', uri: 'https://remote.test/users/invitee', isSuspended: false };
const mirrorOwner = { id: 'mirror-owner', host: 'other.test', uri: 'https://other.test/users/o', isSuspended: false };
const ownedRoom = { id: 'room', uri: null, ownerId: owner.id, owner, name: 'room', description: '', hasChannels: false, legacyChannelId: null };
const mirrorRoom = { ...ownedRoom, id: 'mirror', uri: 'https://other.test/chat/rooms/mirror', ownerId: mirrorOwner.id, owner: mirrorOwner };

type Options = {
	signer?: typeof member | null;
	room?: typeof ownedRoom;
	members?: string[];
	limited?: boolean;
	federation?: string;
};

async function fetchHistory(path: string, options: Options = {}) {
	const signer = options.signer === undefined ? member : options.signer;
	const members = options.members ?? [member.id];
	const room = options.room ?? ownedRoom;
	const renderPage = vi.fn(async (_room: unknown, _actor: unknown, until: string | null) => ({ id: `${LOCAL}/chat/rooms/${room.id}/history${until != null ? `?until=${until}` : ''}`, type: 'OrderedCollectionPage', orderedItems: [] }));
	const limit = vi.fn(async () => options.limited ? { code: 'RATE_LIMIT_EXCEEDED', info: { resetMs: Date.now() + 30_000 } } : null);
	const service = Object.assign(Object.create(ActivityPubServerService.prototype), {
		config: { host: new URL(LOCAL).host, url: LOCAL },
		meta: { federation: options.federation ?? 'all' },
		chatRoomsRepository: { findOne: async ({ where }: { where: { id: string } }) => where.id === room.id ? room : null },
		chatRoomMembershipsRepository: {
			existsBy: async ({ userId }: { userId: string }) => members.includes(userId),
		},
		activityPubAccessControlService: {
			checkAccess: async () => null,
			extractHostFromKeyId: (value: string) => new URL(value).hostname,
			checkHostAccess: async () => null,
		},
		apDbResolverService: { getAuthUserFromKeyId: async () => signer != null ? { user: signer, key: { keyPem: publicKey } } : null },
		apRendererService: { addContext: (object: object) => ({ '@context': 'https://www.w3.org/ns/activitystreams', ...object }) },
		chatRoomHistoryService: { renderPage },
		rateLimiterService: { limit },
		queueService: { inbox: () => {} },
	}) as ActivityPubServerService;

	const app = Fastify();
	await app.register((instance, _options, done) => {
		service.createServer(instance, {}, done);
	});
	await app.ready();

	const url = `${LOCAL}${path}`;
	const headers: Record<string, string> = { host: new URL(url).host, accept: 'application/activity+json' };
	if (signer != null) {
		const signed = await ApRequestCreator.createSignedGet({ key: { keyId: `${signer.uri}#main-key`, privateKeyPem: privateKey }, url, additionalHeaders: {} });
		Object.assign(headers, signed.request.headers, { host: new URL(url).host });
	}
	const response = await app.inject({ method: 'GET', url: path, headers });
	await app.close();
	return { response, renderPage, limit };
}

describe('그룹 소유 서버의 과거 기록 조회', () => {
	test('지금 멤버인 계정의 서명이면 첫 페이지를 준다', async () => {
		const { response, renderPage } = await fetchHistory('/chat/rooms/room/history');

		expect(response.statusCode).toBe(200);
		expect(response.headers['cache-control']).toBe('private, no-store');
		expect(response.json()).toMatchObject({ type: 'OrderedCollectionPage', id: `${LOCAL}/chat/rooms/room/history` });
		expect(renderPage).toHaveBeenCalledWith(ownedRoom, member, null);
	});

	test('커서가 있으면 그 앞의 페이지를 준다', async () => {
		const { response, renderPage } = await fetchHistory('/chat/rooms/room/history?until=abc123');

		expect(response.statusCode).toBe(200);
		expect(renderPage).toHaveBeenCalledWith(ownedRoom, member, 'abc123');
	});

	test.each([
		['초대만 받은 사람', { signer: invitee }],
		['나갔거나 내보낸 사람', { members: [] }],
		['서명 없는 요청', { signer: null }],
		['다른 서버가 소유한 그룹의 사본', { room: mirrorRoom, members: [member.id] }],
	])('%s에게는 주지 않는다', async (_, options) => {
		const { response, renderPage } = await fetchHistory(`/chat/rooms/${(options as Options).room?.id ?? 'room'}/history`, options as Options);

		expect(response.statusCode).toBe(404);
		expect(renderPage).not.toHaveBeenCalled();
	});

	test('페이지마다 멤버인지 다시 확인한다', async () => {
		const members = [member.id];
		const first = await fetchHistory('/chat/rooms/room/history', { members });
		members.length = 0;
		const second = await fetchHistory('/chat/rooms/room/history?until=abc', { members });

		expect(first.response.statusCode).toBe(200);
		expect(second.response.statusCode).toBe(404);
	});

	test.each([
		['다른 경로', 'a/b'],
		['쿼리 주입', 'a&until=b'],
		['너무 긴 값', 'a'.repeat(33)],
	])('형식이 틀린 커서(%s)는 거부한다', async (_, cursor) => {
		const { response, renderPage } = await fetchHistory(`/chat/rooms/room/history?until=${encodeURIComponent(cursor)}`);

		expect(response.statusCode).toBe(400);
		expect(renderPage).not.toHaveBeenCalled();
	});

	test('빈도 제한에 걸리면 다시 시도할 시점을 알려 준다', async () => {
		const { response, renderPage, limit } = await fetchHistory('/chat/rooms/room/history', { limited: true });

		expect(response.statusCode).toBe(429);
		expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
		expect(limit).toHaveBeenCalledWith(expect.objectContaining({ key: 'chatRoomHistory:room' }), member.host);
		expect(renderPage).not.toHaveBeenCalled();
	});

	test('연합을 끈 서버는 주지 않는다', async () => {
		const { response } = await fetchHistory('/chat/rooms/room/history', { federation: 'none' });

		expect(response.statusCode).toBe(403);
	});
});
