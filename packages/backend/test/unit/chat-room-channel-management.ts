/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomChannel } from '@/models/ChatRoomChannel.js';
import { MiChatRoomChannelSection } from '@/models/ChatRoomChannelSection.js';
import { MiUser } from '@/models/User.js';
import { meta as arrangeMeta } from '@/server/api/endpoints/chat/rooms/channels/arrange.js';
import { meta as createMeta } from '@/server/api/endpoints/chat/rooms/channels/create.js';
import { meta as deleteMeta } from '@/server/api/endpoints/chat/rooms/channels/delete.js';
import { meta as reorderMeta } from '@/server/api/endpoints/chat/rooms/channels/reorder.js';
import { meta as updateMeta } from '@/server/api/endpoints/chat/rooms/channels/update.js';
import { meta as convertMeta } from '@/server/api/endpoints/chat/rooms/convert-to-channels.js';
import { meta as sectionCreateMeta } from '@/server/api/endpoints/chat/rooms/sections/create.js';
import { meta as sectionDeleteMeta } from '@/server/api/endpoints/chat/rooms/sections/delete.js';
import { meta as sectionUpdateMeta } from '@/server/api/endpoints/chat/rooms/sections/update.js';
import ArrangeEndpoint from '@/server/api/endpoints/chat/rooms/channels/arrange.js';
import ReorderEndpoint from '@/server/api/endpoints/chat/rooms/channels/reorder.js';
import UpdateEndpoint from '@/server/api/endpoints/chat/rooms/channels/update.js';
import SectionUpdateEndpoint from '@/server/api/endpoints/chat/rooms/sections/update.js';

const me = { id: 'owner', host: null } as any;
const room = { id: 'r1', ownerId: 'owner', hasChannels: true, legacyChannelId: 'c1', isArchived: false, lastRemoteUpdatedAt: null };

function fixture() {
	const channels = [
		{ id: 'c1', roomId: 'r1', name: 'general', position: 0, sectionId: null },
		{ id: 'c2', roomId: 'r1', name: 'random', position: 1, sectionId: null },
		{ id: 'c3', roomId: 'r1', name: 'notes', position: 2, sectionId: 's1' },
	];
	const sections = [{ id: 's1', roomId: 'r1', name: 'info', position: 0 }];
	const updates: { entity: unknown; id: unknown; patch: Record<string, unknown> }[] = [];
	const manager = {
		findOne: async () => ({ ...room }),
		existsBy: async () => true,
		findOneBy: async (entity: unknown, where: { id: string }) => {
			if (entity === MiChatRoom) return { ...room };
			const list = entity === MiChatRoomChannel ? channels : sections;
			return list.find(item => item.id === where.id) ?? null;
		},
		findBy: async (entity: unknown) => (entity === MiChatRoomChannel ? channels : sections).map(item => ({ ...item })),
		find: async (entity: unknown) => (entity === MiChatRoomChannel ? channels : sections).map(item => ({ ...item })),
		update: async (entity: unknown, id: unknown, patch: Record<string, unknown>) => { updates.push({ entity, id, patch }); },
	};
	const service = Object.assign(Object.create(ChatRoomChannelService.prototype), {
		db: { transaction: async (run: (m: unknown) => unknown) => run(manager), manager },
		channels: { findOneBy: async ({ id }: { id: string }) => channels.find(item => item.id === id) ?? null },
		sections: { findOneBy: async ({ id }: { id: string }) => sections.find(item => item.id === id) ?? null },
	}) as ChatRoomChannelService;
	const chatService = {
		checkChatAvailability: vi.fn(async () => {}),
		notifyRoomChannelsChanged: vi.fn(async () => {}),
	};
	const written = (entity: unknown) => updates.filter(update => update.entity === entity);
	return { service, chatService, written, updates };
}

describe('채널·섹션 관리 엔드포인트의 사용 한도', () => {
	test('아홉 엔드포인트가 같은 한도를 함께 쓴다', () => {
		const metas = [createMeta, updateMeta, deleteMeta, reorderMeta, arrangeMeta, sectionCreateMeta, sectionUpdateMeta, sectionDeleteMeta, convertMeta];
		expect(metas).toHaveLength(9);
		for (const meta of metas) {
			expect(meta.limit).toEqual({ key: 'chat/rooms/channels', duration: 10 * 60 * 1000, max: 300 });
		}
	});
});

describe('바뀐 것이 없는 채널·섹션 관리 호출', () => {
	test('같은 이름으로 채널 이름을 바꾸면 저장도 알림도 하지 않는다', async () => {
		const f = fixture();
		const endpoint = new (UpdateEndpoint as any)(f.service, f.chatService);

		const result = await endpoint.exec({ channelId: 'c2', name: ' random ' }, me, null, null);

		expect(result).toMatchObject({ id: 'c2', name: 'random' });
		expect(f.written(MiChatRoomChannel)).toEqual([]);
		expect(f.chatService.notifyRoomChannelsChanged).not.toHaveBeenCalled();
	});

	test('다른 이름으로 채널 이름을 바꾸면 저장하고 알린다', async () => {
		const f = fixture();
		const endpoint = new (UpdateEndpoint as any)(f.service, f.chatService);

		const result = await endpoint.exec({ channelId: 'c2', name: 'renamed' }, me, null, null);

		expect(result).toMatchObject({ id: 'c2', name: 'renamed' });
		expect(f.written(MiChatRoomChannel)).toEqual([{ entity: MiChatRoomChannel, id: 'c2', patch: { name: 'renamed' } }]);
		expect(f.chatService.notifyRoomChannelsChanged).toHaveBeenCalledWith('r1');
	});

	test('같은 이름으로 섹션 이름을 바꾸면 저장도 알림도 하지 않는다', async () => {
		const f = fixture();
		const endpoint = new (SectionUpdateEndpoint as any)(f.service, f.chatService);

		const result = await endpoint.exec({ sectionId: 's1', name: 'info' }, me, null, null);

		expect(result).toEqual({ id: 's1', roomId: 'r1', name: 'info' });
		expect(f.written(MiChatRoomChannelSection)).toEqual([]);
		expect(f.chatService.notifyRoomChannelsChanged).not.toHaveBeenCalled();
	});

	test('다른 이름으로 섹션 이름을 바꾸면 저장하고 알린다', async () => {
		const f = fixture();
		const endpoint = new (SectionUpdateEndpoint as any)(f.service, f.chatService);

		await endpoint.exec({ sectionId: 's1', name: 'docs' }, me, null, null);

		expect(f.written(MiChatRoomChannelSection)).toEqual([{ entity: MiChatRoomChannelSection, id: 's1', patch: { name: 'docs' } }]);
		expect(f.chatService.notifyRoomChannelsChanged).toHaveBeenCalledWith('r1');
	});

	test('같은 순서로 채널을 정렬하면 저장도 알림도 하지 않는다', async () => {
		const f = fixture();
		const endpoint = new (ReorderEndpoint as any)(f.service, f.chatService);

		const result = await endpoint.exec({ roomId: 'r1', channelIds: ['c1', 'c2', 'c3'] }, me, null, null);

		expect(result.map((channel: { id: string }) => channel.id)).toEqual(['c1', 'c2', 'c3']);
		expect(f.written(MiChatRoomChannel)).toEqual([]);
		expect(f.chatService.notifyRoomChannelsChanged).not.toHaveBeenCalled();
	});

	test('순서가 바뀌면 채널마다 저장하고 알린다', async () => {
		const f = fixture();
		const endpoint = new (ReorderEndpoint as any)(f.service, f.chatService);

		const result = await endpoint.exec({ roomId: 'r1', channelIds: ['c2', 'c1', 'c3'] }, me, null, null);

		expect(result.map((channel: { id: string }) => channel.id)).toEqual(['c2', 'c1', 'c3']);
		expect(f.written(MiChatRoomChannel).map(update => [update.id, update.patch.position])).toEqual([['c2', 0], ['c1', 1], ['c3', 2]]);
		expect(f.chatService.notifyRoomChannelsChanged).toHaveBeenCalledWith('r1');
	});

	test('같은 배치로 정렬하면 저장도 알림도 하지 않는다', async () => {
		const f = fixture();
		const endpoint = new (ArrangeEndpoint as any)(f.service, f.chatService);

		await endpoint.exec({ roomId: 'r1', ungrouped: ['c1', 'c2'], sections: [{ sectionId: 's1', channelIds: ['c3'] }] }, me, null, null);

		expect(f.updates.filter(update => update.entity !== MiChatRoom)).toEqual([]);
		expect(f.chatService.notifyRoomChannelsChanged).not.toHaveBeenCalled();
	});

	test('채널을 다른 묶음으로 옮기면 저장하고 알린다', async () => {
		const f = fixture();
		const endpoint = new (ArrangeEndpoint as any)(f.service, f.chatService);

		await endpoint.exec({ roomId: 'r1', ungrouped: ['c1', 'c3'], sections: [{ sectionId: 's1', channelIds: ['c2'] }] }, me, null, null);

		expect(f.written(MiChatRoomChannel).some(update => update.id === 'c2' && update.patch.sectionId === 's1')).toBe(true);
		expect(f.chatService.notifyRoomChannelsChanged).toHaveBeenCalledWith('r1');
	});
});
