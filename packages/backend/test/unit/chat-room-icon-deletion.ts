/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomIconDeletedProcessorService } from '@/queue/processors/ChatRoomIconDeletedProcessorService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';

describe('그룹 아이콘 파일 삭제', () => {
	test('원격 사본의 로컬 파일 삭제는 소유 서버의 revision을 앞당기지 않는다', async () => {
		const revision = new Date('2026-11-01T00:00:00.000Z');
		const room = { id: 'mirror', ownerId: 'remote', iconId: null, iconFileId: 'file', isArchived: false, lastRemoteUpdatedAt: revision };
		const owner = { id: 'remote', host: 'remote.example' };
		const chat = Object.assign(Object.create(ChatService.prototype), {
			db: { transaction: async (run: (manager: unknown) => unknown) => run({ findOne: async (entity: unknown) => entity === MiChatRoom ? { ...room } : owner, update: async (_entity: unknown, _id: string, patch: object) => Object.assign(room, patch) }) },
			usersRepository: { findOneBy: async () => owner },
			chatRoomsRepository: { update: vi.fn() },
			globalEventService: { publishChatRoomStream: vi.fn() },
			chatEntityService: { packRoomIcon: async () => ({ iconId: null, iconUrl: '/identicon/group', iconBlurhash: null, iconDecorations: [] }) },
		}) as ChatService;
		Object.defineProperties(chat, { participantsForRoom: { value: async () => [] }, inviteesForRoom: { value: async () => [] } });

		await chat.updateRoom(room as never, { iconId: null, iconUrl: null, iconBlurhash: null }, { deletedIconId: 'file' });

		expect(room.lastRemoteUpdatedAt).toEqual(revision);
	});
	test('삭제 완료 전에는 재시도하고 완료 뒤 기존 그룹 변경 경로를 호출한다', async () => {
		let present = true;
		const updateRoom = vi.fn();
		const room = { id: 'room', iconId: null };
		const processor = new ChatRoomIconDeletedProcessorService({ findOneBy: async () => room } as never, { existsBy: async () => present } as never, { updateRoom } as never);
		const job = { data: { roomId: 'room', fileId: 'file' } } as never;

		await expect(processor.process(job)).rejects.toThrow('deletion has not completed');
		expect(updateRoom).not.toHaveBeenCalled();
		present = false;
		await processor.process(job);

		expect(updateRoom).toHaveBeenCalledWith(room, { iconId: null, iconUrl: null, iconBlurhash: null }, { deletedIconId: 'file' });
	});

	test('늦게 실행된 삭제 작업은 새로 선택한 아이콘을 지우지 않는다', async () => {
		const room = { id: 'room', iconId: 'replacement' };
		const update = vi.fn();
		const chat = Object.assign(Object.create(ChatService.prototype), {
			db: { transaction: async (action: (manager: unknown) => unknown) => action({ findOne: async () => room, update }) },
		}) as ChatService;
		const processor = new ChatRoomIconDeletedProcessorService({ findOneBy: async () => room } as never, { existsBy: async () => false } as never, chat);

		await processor.process({ data: { roomId: 'room', fileId: 'file' } } as never);

		expect(update).not.toHaveBeenCalled();
		expect(room.iconId).toBe('replacement');
	});
});
