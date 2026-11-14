/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { parseChatInvitePreview, renderChatInvitePreview } from '@/core/chat-invite-link.js';
import type { IObject } from '@/core/activitypub/type.js';

const baseUrl = 'https://source.example';
const code = 'Ab3dEf6hIj9lMn0p';
const room = { id: 'room1', name: '모임', description: '설명', isArchived: false, iconId: 'file1', iconUrl: `${baseUrl}/files/icon.png`, iconDecorations: [] };

describe('고정 그룹 아이콘 소스를 사용하는 초대', () => {
	test('비동기 그룹 렌더를 마친 뒤 실제 Group 객체를 초대 배달에 싣는다', async () => {
		const renderer = Object.assign(Object.create(ApRendererService.prototype), {
			config: { url: baseUrl },
			userEntityService: { isLocalUser: () => true, genLocalUserUri: (id: string) => `${baseUrl}/users/${id}` },
		}) as ApRendererService;
		const delivered: IObject[] = [];
		const service = Object.assign(Object.create(ChatService.prototype), {
			apRendererService: renderer,
			idService: { parse: () => ({ date: new Date('2026-11-13T00:00:00.000Z') }) },
			queueService: { deliver: (_actor: unknown, activity: IObject) => { delivered.push(JSON.parse(JSON.stringify(activity))); } },
		}) as ChatService;

		await service.deliverRoomInvite(room as never, { id: 'owner', host: null } as never, { uri: 'https://consumer.example/users/member', inbox: 'https://consumer.example/inbox' } as never, 'invitation1');

		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			type: 'Invite', actor: `${baseUrl}/users/owner`, target: 'https://consumer.example/users/member',
			published: '2026-11-13T00:00:00.000Z',
			object: { type: 'Group', id: `${baseUrl}/chat/rooms/room1`, name: '모임', icon: { type: 'Image', url: room.iconUrl } },
		});
	});

	test('공개 AP 미리보기에 실제 아이콘과 장식을 연결하고 비공개 그룹 정보는 싣지 않는다', () => {
		const decorations = [{ id: 'decoration1', name: '도형', url: `${baseUrl}/frame.png`, angle: 0.1 }];
		const doc = renderChatInvitePreview({
			baseUrl, code, room, membersCount: 2,
			icon: { url: room.iconUrl, decorations },
		});

		expect(doc.object).toMatchObject({ icon: { type: 'Image', url: room.iconUrl }, _misskey_chatIconDecorations: decorations });
		for (const key of ['actor', 'attributedTo', 'owner', 'members', '_misskey_chatRoomMembers', '_misskey_chatChannels']) expect(doc.object).not.toHaveProperty(key);
	});

	test('같은 HTTPS 호스트의 미리보기에서 아이콘과 장식 입력을 보존한다', () => {
		const decorations = [{ id: 'decoration1', name: '도형', url: `${baseUrl}/frame.png` }];
		const doc = {
			...renderChatInvitePreview({ baseUrl, code, room, membersCount: 2 }),
			object: { id: `${baseUrl}/chat/rooms/room1`, type: 'Group', name: '모임', _misskey_chatRoomMembersCount: 2, icon: { type: 'Image', url: room.iconUrl }, _misskey_chatIconDecorations: decorations },
		};

		expect(parseChatInvitePreview(doc, `${baseUrl}/chat/invite/${code}`)).toMatchObject({ iconUrl: room.iconUrl, iconDecorations: decorations });
	});

	test.each(['javascript:alert(1)', 'data:image/png;base64,invalid', 'http://cdn.example/icon.png', 'https://user:pass@cdn.example/icon.png'])('아이콘 주소 %s는 그대로 카드에 노출하지 않는다', iconUrl => {
		const doc = renderChatInvitePreview({ baseUrl, code, room, membersCount: 2, icon: { url: iconUrl, decorations: [] } });

		expect(parseChatInvitePreview(doc, `${baseUrl}/chat/invite/${code}`)?.iconUrl).toBeNull();
	});
});
