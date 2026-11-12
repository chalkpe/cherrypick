/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { DriveService } from '@/core/DriveService.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomIconDeletedProcessorService } from '@/queue/processors/ChatRoomIconDeletedProcessorService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';

function deletionFixture() {
	const file = { id: 'file', storedInternal: false, isLink: true, userHost: null, userId: 'owner' };
	const events: string[] = [];
	const enqueue = vi.fn(async () => { events.push('enqueue'); });
	let present = true;
	const manager = {
		findOne: async () => present ? file : null,
		find: async () => [{ id: 'room' }],
		delete: async () => { events.push('delete'); present = false; return { affected: 1 }; },
	};
	const stream = { publishDriveStream: vi.fn() };
	const drive = Object.assign(Object.create(DriveService.prototype), {
		driveFilesRepository: { manager: { transaction: async (action: (value: typeof manager) => unknown) => action(manager) } },
		queueService: { createChatRoomIconDeletedJob: enqueue },
		globalEventService: stream,
		driveChart: { update: vi.fn() }, perUserDriveChart: { update: vi.fn() },
	}) as DriveService;
	return { drive, file, events, enqueue, stream, present: () => present };
}

describe('그룹 아이콘 파일 삭제', () => {
	test('원격 사본의 로컬 파일 삭제는 소유 서버의 revision을 앞당기지 않는다', async () => {
		const revision = new Date('2026-11-01T00:00:00.000Z');
		const room = { id: 'mirror', ownerId: 'remote', iconId: null, isArchived: false, lastRemoteUpdatedAt: revision };
		const owner = { id: 'remote', host: 'remote.example' };
		const chat = Object.assign(Object.create(ChatService.prototype), {
			db: { transaction: async (run: (manager: unknown) => unknown) => run({ findOne: async (entity: unknown) => entity === MiChatRoom ? { ...room } : owner, update: async (_entity: unknown, _id: string, patch: object) => Object.assign(room, patch) }) },
			usersRepository: { findOneBy: async () => owner },
			globalEventService: { publishChatRoomStream: vi.fn() },
			chatEntityService: { packRoomIcon: async () => ({ iconId: null, iconUrl: '/identicon/group', iconBlurhash: null, iconDecorations: [] }) },
		}) as ChatService;
		Object.defineProperties(chat, { participantsForRoom: { value: async () => [] }, inviteesForRoom: { value: async () => [] } });

		await chat.updateRoom(room as never, { iconId: null, iconUrl: null, iconBlurhash: null }, { deletedIconId: 'file' });

		expect(room.lastRemoteUpdatedAt).toEqual(revision);
	});
	test('삭제 SQL 연결을 점유한 채 그룹 AP 전달을 기다리지 않고 복구 가능한 작업을 먼저 접수한다', async () => {
		const f = deletionFixture();

		expect(await f.drive.deleteFile(f.file as never)).toBe(true);

		expect(f.events).toEqual(['enqueue', 'delete']);
		expect(f.enqueue).toHaveBeenCalledWith('room', 'file');
		expect(f.present()).toBe(false);
	});

	test('작업 접수 실패 시 파일 행과 그룹 참조를 유지해 다시 삭제할 수 있다', async () => {
		const f = deletionFixture();
		f.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

		await expect(f.drive.deleteFile(f.file as never)).rejects.toThrow('queue unavailable');

		expect(f.present()).toBe(true);
		expect(f.stream.publishDriveStream).not.toHaveBeenCalled();
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
