/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';

const LOCAL = 'https://local.test';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const author = { id: 'author', host: null, uri: null, isSuspended: false };
const member = { id: 'member', host: 'remote.test', uri: 'https://remote.test/users/member', isSuspended: false };
const keyId = `${member.uri}#main-key`;

const direct = { id: 'direct', fromUserId: author.id, toUserId: member.id, toRoomId: null, fileIds: [], uri: null, emojis: [], deletedAt: null };
const inRoom = { ...direct, id: 'in-room', toUserId: null, toRoomId: 'room' };
const deleted = { ...direct, id: 'deleted', deletedAt: new Date('2026-11-02T00:00:00Z') };
const remoteAuthored = { ...direct, id: 'remote-authored', fromUserId: member.id, toUserId: author.id };
const messages = new Map([direct, inRoom, deleted, remoteAuthored].map(message => [message.id, message]));

async function fetchMessage(messageId: string, authorIsSuspended: boolean) {
	const users = new Map<string, object>([[author.id, { ...author, isSuspended: authorIsSuspended }], [member.id, member]]);
	const service = Object.assign(Object.create(ActivityPubServerService.prototype), {
		config: { host: new URL(LOCAL).host, url: LOCAL },
		meta: { federation: 'all' },
		chatMessagesRepository: { findOneBy: async ({ id }: { id: string }) => messages.get(id) ?? null },
		usersRepository: {
			findOneBy: async ({ id }: { id: string }) => users.get(id) ?? null,
			findBy: async () => [...users.values()],
		},
		chatRoomsRepository: { findOne: async () => ({ id: 'room', ownerId: author.id, owner: { ...author, isSuspended: authorIsSuspended }, name: 'room', description: '' }) },
		chatRoomMembershipsRepository: {
			findOneBy: async () => ({ roomId: 'room', userId: member.id }),
			findBy: async () => [{ roomId: 'room', userId: member.id }],
		},
		chatRoomInvitationsRepository: { findOneBy: async () => null },
		activityPubAccessControlService: {
			checkAccess: async () => null,
			extractHostFromKeyId: (value: string) => new URL(value).hostname,
			checkHostAccess: async () => null,
		},
		apDbResolverService: { getAuthUserFromKeyId: async () => ({ user: member, key: { keyPem: publicKey } }) },
		apRendererService: {
			addContext: (object: unknown) => object,
			renderChatMessage: async () => ({ type: 'Note', content: 'secret' }),
			renderTombstone: (id: string) => ({ id, type: 'Tombstone' }),
			genLocalChatRoomUri: (id: string) => `${LOCAL}/chat/rooms/${id}`,
		},
		queueService: { inbox: () => {} },
	}) as ActivityPubServerService;

	const app = Fastify();
	await app.register((instance, _options, done) => {
		service.createServer(instance, {}, done);
	});
	await app.ready();

	const url = `${LOCAL}/chat/messages/${messageId}`;
	const signed = await ApRequestCreator.createSignedGet({ key: { keyId, privateKeyPem: privateKey }, url, additionalHeaders: {} });
	const response = await app.inject({
		method: 'GET',
		url: `/chat/messages/${messageId}`,
		headers: { ...signed.request.headers, host: new URL(url).host, accept: 'application/activity+json' },
	});
	await app.close();
	return response;
}

describe('a signed fetch of a message from a local author suspended here', () => {
	test.each([
		['a direct message', direct.id],
		['a room message', inRoom.id],
		['a deleted message', deleted.id],
	])('finds nothing for %s', async (_name, messageId) => {
		expect((await fetchMessage(messageId, true)).statusCode).toBe(404);
	});

	test.each([
		['a direct message', direct.id, 'Note'],
		['a room message', inRoom.id, 'Note'],
		['a deleted message', deleted.id, 'Tombstone'],
	])('answers again for %s when the suspension ends', async (_name, messageId, type) => {
		const response = await fetchMessage(messageId, false);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ type });
	});
});
