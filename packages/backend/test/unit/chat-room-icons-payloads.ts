/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { buildChatRoomUpdate } from '@/core/activitypub/misc/chat-payloads.js';
import { packedChatRoomSchema } from '@/models/json-schema/chat-room.js';
import { avatarFileError } from '@/core/avatar-file.js';
import { normalizeAvatarDecoration, usableAvatarDecorationIds } from '@/core/avatar-decoration.js';
import { compactChatRoomForPush } from '@/core/push-chat-room.js';

describe('그룹 아이콘 표현', () => {
	test('최대 장식의 주소를 푸시에 싣지 않고 그룹 대표 그림과 식별자를 보존한다', () => {
		const decorations = Array.from({ length: 16 }, (_, i) => ({ id: `${i}`, url: `https://owner.example/${'a'.repeat(1024)}.png` }));
		const room = { id: 'group', name: '그룹', iconUrl: 'https://owner.example/icon.png', iconDecorations: decorations, owner: { host: 'owner.example', avatarDecorations: decorations } };
		const original = structuredClone(room);

		const packed = compactChatRoomForPush(room as never);

		expect(packed).toMatchObject({ id: 'group', name: '그룹', iconUrl: room.iconUrl, owner: { host: 'owner.example' } });
		expect(packed).not.toHaveProperty('iconDecorations');
		expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThan(4096);
		expect(room).toEqual(original);
	});

	test('장식이 없는 그룹은 푸시에 빈 장식을 실어 SW가 그룹을 다시 조회하지 않게 한다', () => {
		const room = { id: 'group', name: '그룹', iconUrl: 'https://owner.example/icon.png', iconDecorations: [], owner: { host: null } };

		const packed = compactChatRoomForPush(room as never);

		expect(packed).toEqual({ id: 'group', name: '그룹', iconUrl: room.iconUrl, iconDecorations: [], owner: { host: null } });
	});

	test('프로필과 그룹의 파일 검증은 소유자·이미지·민감도를 같은 순서로 검사한다', () => {
		const file = { userId: 'owner', type: 'image/png', isSensitive: false };

		expect(avatarFileError(file, 'owner')).toBeNull();
		expect(avatarFileError(null, 'owner')).toBe('noSuchAvatar');
		expect(avatarFileError(file, 'member')).toBe('noSuchAvatar');
		expect(avatarFileError({ ...file, type: 'text/plain' }, 'owner')).toBe('avatarNotAnImage');
		expect(avatarFileError({ ...file, isSensitive: true }, 'owner')).toBe('avatarIsSensitive');
	});

	test('프로필과 그룹은 실제 역할에 제한된 장식과 삭제된 역할을 동일하게 처리한다', () => {
		const decorations = [
			{ id: 'free', roleIdsThatCanBeUsedThisDecoration: [] },
			{ id: 'restricted', roleIdsThatCanBeUsedThisDecoration: ['role'] },
			{ id: 'deleted-role', roleIdsThatCanBeUsedThisDecoration: ['gone'] },
		];

		expect(usableAvatarDecorationIds(decorations, [], [{ id: 'role' }])).toEqual(['free', 'deleted-role']);
		expect(usableAvatarDecorationIds(decorations, [{ id: 'role' }], [{ id: 'role' }])).toEqual(['free', 'restricted', 'deleted-role']);
		expect(normalizeAvatarDecoration({ id: 'free' })).toEqual({ id: 'free', angle: 0, flipH: false, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 });
	});
	test('그룹 변경은 아이콘과 장식을 명시하고 기존 ID와 소유자를 유지한다', () => {
		const updated = '2026-11-13T00:00:00.000Z';
		const iconDecorations = [{ id: 'decoration', url: 'https://owner.example/decoration.png', name: '도형', angle: 0.1 }];
		const activity = buildChatRoomUpdate({ id: 'room', name: '그룹' }, { id: 'owner', host: null }, {
			baseUrl: 'https://owner.example', updated, icon: { type: 'Image', url: 'https://owner.example/icon.png' }, iconDecorations,
		});

		expect(activity).toMatchObject({
			id: `https://owner.example/chat/rooms/room#update/${encodeURIComponent(updated)}`,
			actor: 'https://owner.example/users/owner',
			object: { icon: { type: 'Image', url: 'https://owner.example/icon.png' }, _misskey_chatIconDecorations: iconDecorations },
		});
	});

	test('해제된 아이콘과 장식을 생략하지 않는다', () => {
		const activity = buildChatRoomUpdate({ id: 'room', name: '그룹' }, { id: 'owner', host: null }, { baseUrl: 'https://owner.example', icon: null, iconDecorations: [] });

		expect(activity.object).toMatchObject({ icon: null, _misskey_chatIconDecorations: [] });
	});

	test('API 그룹 입력은 프로필과 같은 아이콘 메타데이터를 제공한다', () => {
		for (const key of ['iconId', 'iconUrl', 'iconBlurhash', 'iconDecorations']) {
			expect(packedChatRoomSchema.properties).toHaveProperty(key);
		}
	});
});
