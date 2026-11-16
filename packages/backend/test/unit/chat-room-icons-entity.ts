/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { ChatRoomIconEntityService } from '@/core/entities/ChatRoomIconEntityService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';

function fixture(baseUrl: string, owner: { id: string; host: string | null; uri?: string } | null, present = true) {
	const config = { url: baseUrl, host: new URL(baseUrl).host };
	const users = { findOneBy: async () => owner };
	const avatar = Object.assign(Object.create(AvatarDecorationService.prototype), {
		avatarDecorationsRepository: { findBy: async () => [{ id: 'decoration', url: `${baseUrl}/proxy/frame.png` }] },
	}) as AvatarDecorationService;
	return new ChatRoomIconEntityService(config as never, users as never, { existsBy: async () => present } as never, avatar);
}

describe('그룹 아이콘 응답', () => {
	test('파일이 없으면 오래된 주소를 버리고 프로필의 도트 이미지 경로를 사용한다', async () => {
		const service = fixture('https://source.example', { id: 'owner', host: null });

		const packed = await service.pack({ id: 'room', ownerId: 'owner', iconId: null, iconUrl: 'https://stale.example/avatar.png', iconBlurhash: 'stale', iconDecorations: [] } as never);

		expect(packed.iconId).toBeNull();
		expect(packed.iconBlurhash).toBeNull();
		expect(packed.iconUrl).toMatch(/^https:\/\/source\.example\/identicon\//);
		expect(packed.iconUrl).not.toContain('stale');
	});

	test('긴 서버 주소에서도 기본 그림이 프로필과 같은 길이의 이름을 쓴다', () => {
		const host = 'a'.repeat(45) + '.example';
		const service = fixture(`https://${host}`, { id: 'owner', host: null });

		const url = new URL(service.getIdenticonUrl(`https://${host}/chat/rooms/room`));
		const parameter = url.pathname.slice('/identicon/'.length);

		expect(parameter.split('@')[0]).toHaveLength(20);
		expect(parameter.length).toBeLessThanOrEqual(100);
	});

	test('사본의 DB ID와 표시 서버가 달라도 같은 그룹 URI는 같은 도트 이미지가 된다', async () => {
		const source = fixture('https://source.example', { id: 'owner', host: null });
		const mirror = fixture('https://mirror.example', { id: 'remote-owner', host: 'source.example', uri: 'https://source.example/users/owner' });

		const local = await source.pack({ id: 'room', ownerId: 'owner', iconId: null, iconDecorations: [] } as never);
		const remote = await mirror.pack({ id: 'different-local-id', ownerId: 'remote-owner', uri: 'https://source.example/chat/rooms/room', iconId: null, iconDecorations: [] } as never);

		expect(new URL(local.iconUrl).pathname).toBe(new URL(remote.iconUrl).pathname);
	});

	test('그룹 목록은 이미 아는 소유자 서버나 그룹 URI로 기본 그림을 만들고 소유자를 다시 조회하지 않는다', async () => {
		const lookups: unknown[] = [];
		const service = fixture('https://mirror.example', null);
		Object.assign(service, { usersRepository: { findOneBy: async (where: unknown) => { lookups.push(where); return null; } } });

		const local = await service.pack({ id: 'room', ownerId: 'owner', iconId: null, iconDecorations: [] } as never, false, { host: null });
		const mirror = await service.pack({ id: 'mirror-id', ownerId: 'remote-owner', uri: 'https://source.example/chat/rooms/room', iconId: null, iconDecorations: [] } as never);

		expect(lookups).toEqual([]);
		expect(new URL(local.iconUrl).pathname).toMatch(/^\/identicon\//);
		expect(new URL(mirror.iconUrl).pathname).toMatch(/@source\.example$/);
	});

	test('삭제 기록도 파일 소멸 뒤 기본 그림을 쓰고 원격 그룹의 출처를 보존한다', async () => {
		const service = fixture('https://mirror.example', null, false);

		const packed = await service.packDeletedRoom({ room: { id: 'mirror-id', ownerId: 'deleted', name: 'group', uri: 'https://source.example/chat/rooms/room', iconId: 'deleted-file', iconUrl: 'https://stale.example/file.png', iconDecorations: [{ id: 'decoration', url: 'https://untrusted.example/frame.png' }] } });

		expect(packed.room.owner.host).toBe('source.example');
		expect(packed.room.iconId).toBeNull();
		expect(packed.room.iconUrl).toContain('/identicon/');
		expect(packed.room.iconDecorations).toMatchObject([{ id: 'decoration', url: 'https://mirror.example/proxy/frame.png' }]);
	});
});
