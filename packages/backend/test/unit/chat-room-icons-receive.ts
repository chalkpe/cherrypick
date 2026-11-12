/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApChatRoomStateService } from '@/core/activitypub/ApChatRoomStateService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { ChatService } from '@/core/ChatService.js';

const owner = { id: 'owner', host: 'remote.example', uri: 'https://remote.example/users/owner' };
const uri = 'https://remote.example/chat/rooms/room';
const oldDate = '2026-11-01T00:00:00.000Z';
const newDate = '2026-11-02T00:00:00.000Z';

function fixture() {
	const state = { id: 'mirror', ownerId: owner.id, uri, name: 'group', description: '', isArchived: false, hasChannels: false, iconId: 'initial', iconUrl: 'initial', iconBlurhash: null, iconDecorations: [] as { id: string }[], lastRemoteUpdatedAt: null as Date | null };
	const catalog = new Map<string, Record<string, any>>();
	const findDecoration = async (where: Record<string, unknown>) => [...catalog.values()].find(d => Object.entries(where).every(([key, value]) => d[key] === value)) ?? null;
	const decorations = Object.assign(Object.create(AvatarDecorationService.prototype), {
		config: { mediaProxy: 'https://local.example/proxy' },
		avatarDecorationsRepository: {
			findOneBy: findDecoration,
			findOneByOrFail: async (where: Record<string, unknown>) => { const row = await findDecoration(where); if (row == null) throw new Error('decoration not found'); return row; },
			insertOne: async (data: Record<string, any>) => { catalog.set(data.id, data); return data; },
			update: async (id: string, patch: object) => Object.assign(catalog.get(id)!, patch),
		},
		idService: { gen: () => `local-decoration-${catalog.size}` },
		globalEventService: { publishInternalEvent: vi.fn() },
		cacheWithRemote: { delete: vi.fn() },
	});
	const users = { findOneByOrFail: async () => owner, findOneBy: async () => owner };
	const rooms = { findOneBy: async () => structuredClone(state) };
	const chat = Object.assign(Object.create(ChatService.prototype), {
		db: { transaction: async (run: (manager: unknown) => unknown) => run({ findOne: async () => structuredClone(state), update: async (_entity: unknown, _id: string, patch: object) => Object.assign(state, patch) }) },
		usersRepository: users,
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null },
		globalEventService: { publishChatRoomStream: vi.fn() },
		chatEntityService: { packRoomIcon: async () => ({ iconId: state.iconId, iconUrl: state.iconUrl, iconBlurhash: null, iconDecorations: [] }) },
	}) as ChatService;
	Object.defineProperties(chat, {
		participantsForRoom: { value: async () => [owner] },
		inviteesForRoom: { value: async () => [] },
		notifyRoomListChanged: { value: vi.fn() },
	});
	const resolveImage = vi.fn(async (_actor: unknown, value: { url: string }) => ({ id: value.url, type: 'image/png', url: value.url, blurhash: null }));
	const lock = new Map<string, string>();
	const stateService = Object.assign(Object.create(ApChatRoomStateService.prototype), {
		chatRoomsRepository: rooms, usersRepository: users, chatService: chat,
		userEntityService: { isRemoteUser: () => true },
		roleService: { getUserPolicies: async () => ({ canUpdateBioMedia: true }) },
		apImageService: { findStoredImage: async () => null, resolveImage },
		driveFileEntityService: { getPublicUrl: (file: { url: string }) => `https://local.example/proxy?url=${encodeURIComponent(file.url)}` },
		avatarDecorationService: decorations,
		redisClient: { set: async (key: string, value: string) => { lock.set(key, value); return 'OK'; }, get: async (key: string) => lock.get(key), del: async (key: string) => lock.delete(key) },
	}) as ApChatRoomStateService;
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		chatRoomsRepository: rooms, usersRepository: users, chatService: chat,
		logger: { debug: vi.fn() }, apChatRoomStateService: stateService,
	}) as ApInboxService;

	async function update(object: Record<string, unknown>, actor = owner) {
		return (inbox as any).update(actor, { type: 'Update', actor: actor.uri, object: { type: 'Group', id: uri, ...object } }, { resolve: async (value: unknown) => value });
	}

	return { state, catalog, resolveImage, update };
}

describe('그룹 아이콘 수신', () => {
	test('소유자가 아닌 활동은 이미지 해석과 원격 장식 등록 전에 거부한다', async () => {
		const f = fixture();

		const result = await f.update({ icon: { type: 'Image', url: 'https://evil.example/image.png' }, _misskey_chatIconDecorations: [] }, { id: 'other', host: 'evil.example', uri: 'https://evil.example/users/other' });

		expect(result).toContain('only the room owner');
		expect(f.resolveImage).not.toHaveBeenCalled();
		expect(f.catalog.size).toBe(0);
	});

	test('구버전의 생략은 유지하고 명시적인 null과 빈 배열은 해제한다', async () => {
		const f = fixture();
		f.state.iconDecorations = [{ id: 'decoration' }];

		await f.update({ name: 'renamed', updated: oldDate });
		expect(f.state.iconId).toBe('initial');
		expect(f.state.iconDecorations).toEqual([{ id: 'decoration' }]);
		await f.update({ updated: newDate, icon: null, _misskey_chatIconDecorations: [] });

		expect(f.state.iconId).toBeNull();
		expect(f.state.iconDecorations).toEqual([]);
	});

	test('이미지가 늦게 도착한 옛 상태가 최신 장식 주소를 되돌리지 않는다', async () => {
		const f = fixture();
		let release!: () => void;
		let started!: () => void;
		const waiting = new Promise<void>(resolve => { started = resolve; });
		const barrier = new Promise<void>(resolve => { release = resolve; });
		f.resolveImage.mockImplementation(async (_actor, value) => {
			if (value.url.endsWith('/old-icon.png')) { started(); await barrier; }
			return { id: value.url, type: 'image/png', url: value.url, blurhash: null };
		});
		const payload = (version: string, updated: string) => ({ updated, icon: { type: 'Image', url: `https://remote.example/${version}-icon.png` }, _misskey_chatIconDecorations: [{ id: 'decoration', name: version, url: `https://remote.example/${version}-decoration.png` }] });

		const older = f.update(payload('old', oldDate));
		await waiting;
		await f.update(payload('new', newDate));
		release();
		await older;

		expect(f.state.lastRemoteUpdatedAt?.toISOString()).toBe(newDate);
		expect(f.state.iconId).toBe('https://remote.example/new-icon.png');
		expect([...f.catalog.values()].find(d => d.remoteId === 'decoration')?.rawUrl).toBe('https://remote.example/new-decoration.png');
	});
});
