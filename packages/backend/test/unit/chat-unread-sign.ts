/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DeleteAccountProcessorService } from '@/queue/processors/DeleteAccountProcessorService.js';
import type { MiChatMessage } from '@/models/_.js';
import { chatUnreadFixture as fixture } from '../misc/chat-unread-fixture.js';

describe('chat unread sign', () => {
	afterEach(() => vi.useRealTimers());

	describe('reading', () => {
		test('tells the reader once the only unread direct conversation is read', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('keeps quiet while another conversation is still unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

			expect(f.told()).toEqual([]);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.readUserChatMessage(f.reader.id, f.amber.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('tells the reader once the only unread room is read', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('keeps quiet when a room is read while a direct conversation is still unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);

			expect(f.told()).toEqual([]);
		});

		test('does not announce a read that cleared nothing', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

			// An open conversation sends a read for every message it receives.
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('marking everything read clears every conversation and tells the reader', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.readAllChatMessages(f.reader.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.getUserReadStateMap(f.reader.id, [f.violet.id])).toEqual({ violet: true });
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('marking everything read always tells the reader, as they asked for it', async () => {
			const f = fixture();

			await f.chatService.readAllChatMessages(f.reader.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});
	});

	describe('unread marks that go away without a read', () => {
		test('a lost Redis reply and unavailable cleanup never mark read room history unread', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			const evaluate = f.redis.eval;
			let applied = false;
			const fault = vi.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
				if (!applied) {
					applied = true;
					await evaluate(...args);
				}
				throw new Error('lost Redis reply');
			});

			await expect(f.chatService.createMessageToRoom(f.violet, f.room, { text: 'failed send' })).rejects.toThrow('lost Redis reply');
			fault.mockRestore();

			expect(f.stored('failed send')).toBeUndefined();
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('physical deletion of an ordinary member reconciles unread above read history', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'unread' });
			const emptyRepository = { find: async () => [] };
			const processor = Object.assign(Object.create(DeleteAccountProcessorService.prototype), {
				logger: { info: vi.fn(), succ: vi.fn() },
				usersRepository: {
					findOneBy: async () => f.amber,
					delete: async () => {
						// 사용자 FK CASCADE가 작성자의 메시지를 제거하는 저장소 경계이다.
						for (const message of f.messages.filter(row => row.fromUserId === f.amber.id)) f.messages.splice(f.messages.indexOf(message), 1);
					},
				},
				notesRepository: emptyRepository,
				driveFilesRepository: emptyRepository,
				pagesRepository: emptyRepository,
				userProfilesRepository: { findOneByOrFail: async () => ({}) },
				userEntityService: { isRemoteUser: () => false },
				globalEventService: { publishInternalEvent: vi.fn() },
				chatService: f.chatService,
			}) as DeleteAccountProcessorService;

			// 작업은 방을 지우기 전에 표식을 저장한다. 이 시험은 한 번만 처리하므로 저장한 값을 다시 읽지 않는다.
			await processor.process({ data: { user: { id: f.amber.id }, soft: false }, updateData: async () => undefined } as never);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test.each(['direct', 'room'] as const)('a Redis failure never leaves a stored %s message behind a failed send', async kind => {
			vi.useFakeTimers();
			const f = fixture();
			vi.spyOn(f.redis, 'eval').mockRejectedValueOnce(new Error('injected Redis failure'));

			const sending = kind === 'direct'
				? f.chatService.createMessageToUser(f.violet, f.reader, { text: 'retry safely' })
				: f.chatService.createMessageToRoom(f.violet, f.room, { text: 'retry safely' });
			await expect(sending).rejects.toThrow('injected Redis failure');

			expect(f.messages.filter(message => message.text === 'retry safely')).toEqual([]);
		});

		test.each(['withdrawn', 'suspended', 'removed', 'room deleted'] as const)('a delayed mark cannot restore unread for a message that was %s', async change => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			const service = f.chatService as unknown as { chatEntityService: { packMessageLiteForRoom: (message: MiChatMessage) => Promise<MiChatMessage> } };
			let entered!: () => void;
			let release!: () => void;
			const packed = new Promise<void>(resolve => { entered = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			vi.spyOn(service.chatEntityService, 'packMessageLiteForRoom').mockImplementationOnce(async message => {
				entered();
				await gate;
				return message;
			});

			const sending = f.chatService.createMessageToRoom(f.amber, f.room, { text: 'pending' });
			await packed;
			if (change === 'withdrawn') await f.chatService.deleteMessage(f.stored('pending'));
			if (change === 'suspended') {
				f.amber.isSuspended = true;
				await f.chatService.handleUserSuspended(f.amber);
			}
			if (change === 'room deleted') await f.chatService.deleteRoom(f.room);
			if (change === 'removed') {
				f.memberships.splice(0, 1);
				await f.chatService.finishRoomMemberRemoval(f.room, f.reader);
			}
			release();
			await sending;

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('withdrawing the last eligible room message does not promote muted arrivals', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'eligible' });
			f.memberships[0].isMuted = true;
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'muted' });
			f.memberships[0].isMuted = false;

			await f.chatService.deleteMessage(f.stored('eligible'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('unmuting before the notice delay does not notify about muted arrivals', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'eligible' });
			await vi.advanceTimersByTimeAsync(3000);
			f.memberships[0].isMuted = true;
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'muted' });
			f.memberships[0].isMuted = false;

			await vi.advanceTimersByTimeAsync(3000);

			expect(f.push).not.toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.objectContaining({ text: 'muted' }));
		});

		test('suspending the only unread author clears a room with read history', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'unread' });
			f.amber.isSuspended = true;

			await f.chatService.handleUserSuspended(f.amber);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a delayed insert between first and latest survives a withdrawal snapshot after earlier cleanup failed', async () => {
			vi.useFakeTimers();
			const f = fixture();
			const service = f.chatService as unknown as {
				idService: { gen: () => string };
				chatMessagesRepository: { find: (...args: unknown[]) => Promise<MiChatMessage[]> };
			};
			vi.spyOn(service.idService, 'gen')
				.mockReturnValueOnce('message1').mockReturnValueOnce('approval1')
				.mockReturnValueOnce('message3').mockReturnValueOnce('approval2')
				.mockReturnValueOnce('message2').mockReturnValue('approval3');
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'first' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'latest' });
			expect(f.stored('first').id).toBe('message1');
			expect(f.stored('latest').id).toBe('message3');
			// 이전 철회의 Redis 정리가 실패한 잔여 ID가 있어야 마지막 철회도 DB 조회를 거친다.
			const first = f.stored('first');
			const cleanup = vi.spyOn(f.redis, 'eval').mockRejectedValueOnce(new Error('unread cleanup unavailable'));
			await f.chatService.deleteMessage(first);
			cleanup.mockRestore();
			expect(first.deletedAt).not.toBeNull();
			expect(await f.redis.smembers(`newUserChatMessageExists:${f.reader.id}:${f.violet.id}:messages`)).toContain('message1');
			let release!: () => void;
			let queried!: () => void;
			const queryFinished = new Promise<void>(resolve => { queried = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const find = service.chatMessagesRepository.find;
			vi.spyOn(service.chatMessagesRepository, 'find').mockImplementationOnce(async (...args) => {
				const result = await find(...args);
				queried();
				await gate;
				return result;
			});

			const withdrawing = f.chatService.deleteMessage(f.stored('latest'));
			await queryFinished;
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'delayed' });
			expect(f.stored('delayed').id).toBe('message2');
			release();
			await withdrawing;

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		});

		test('tells the reader when the only unread room is one they were removed from', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.finishRoomMemberRemoval(f.room, f.reader);

			expect(f.told()).toContain('readAllChatMessages');
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('tells the reader when the only unread conversation is with an account that got suspended', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.handleUserSuspended(f.violet);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});
	});

	describe('conversations the chat list no longer shows', () => {
		test('a direct conversation whose only message was taken back does not count as unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.deleteMessage(f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('taking back one of several messages keeps the conversation unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'first' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'second' });

			await f.chatService.deleteMessage(f.stored('second'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(f.told()).not.toContain('readAllChatMessages');
			expect(f.told()).toContain('chatUnreadChanged');
		});

		test('taking back the only message of one conversation leaves the sign on while another is unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.chatService.deleteMessage(f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(f.told()).toEqual([]);
		});

		test('a room whose only message was taken back does not count as unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.deleteMessage(f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('a message taken back on another server is treated the same', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.deleteRemoteMessage(f.violet, f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('a mark left behind by a conversation that has no messages any more does not count', async () => {
			const f = fixture();
			await f.redis.sadd(`newChatMessagesExists:${f.reader.id}`, 'user:gone');
			await f.redis.sadd(`newChatMessagesExists:${f.reader.id}`, 'room:gone');

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});

	describe('delayed notice of a new message', () => {
		test('still notifies about a message left unread', async () => {
			vi.useFakeTimers();
			const f = fixture();

			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(f.told()).toEqual(['newChatMessage']);
			expect(f.push).toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.objectContaining({ text: 'hello' }));
		});

		test('does not follow a read with a notice that was already being prepared', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			const release = f.holdNotice();
			await vi.advanceTimersByTimeAsync(3000);

			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
			release();
			await vi.advanceTimersByTimeAsync(0);

			// A notice arriving after the word that everything was read would leave the sign on.
			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(f.push).not.toHaveBeenCalled();
		});

		test('does not follow a room read with a notice that was already being prepared', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });
			const release = f.holdNotice();
			await vi.advanceTimersByTimeAsync(3000);

			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			release();
			await vi.advanceTimersByTimeAsync(0);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(f.push).not.toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.anything());
		});

		test('does not notify about a message that was marked read along with everything else', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.readAllChatMessages(f.reader.id);
			await vi.advanceTimersByTimeAsync(3000);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});
	});

	describe('muted accounts', () => {
		test('withdrawing a muted legacy conversation preserves its unknown read boundary', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'remaining' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'withdrawn' });
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			await f.redis.del(`${key}:first`);
			await f.userMutingService.mute(f.reader, f.violet);

			await f.chatService.deleteMessage(f.stored('withdrawn'));
			await f.userMutingService.unmute([...f.mutings]);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(await f.redis.get(key)).not.toBeNull();
		});

		test('a direct message from a muted account neither counts as unread nor notifies', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.userMutingService.mute(f.reader, f.violet);

			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual([]);
			expect(f.push).not.toHaveBeenCalled();
		});

		test('reading the last conversation the list shows tells the reader, whatever a muted account sent', async () => {
			const f = fixture();
			await f.userMutingService.mute(f.reader, f.violet);
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.readUserChatMessage(f.reader.id, f.amber.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('muting the account behind the only unread conversation turns the sign off', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.userMutingService.mute(f.reader, f.violet);

			expect(f.accountSent()).toEqual([{ id: f.reader.id, hasUnreadChatMessages: false }]);
		});

		test('muting one account leaves the sign on while another conversation is unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.userMutingService.mute(f.reader, f.violet);

			expect(f.accountSent()).toEqual([{ id: f.reader.id, hasUnreadChatMessages: true }]);
		});

		test('unmuting brings back what was unread before and during the mute', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'before' });
			await f.userMutingService.mute(f.reader, f.violet);
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'during' });

			await f.userMutingService.unmute([...f.mutings]);

			expect(f.accountSent().at(-1)).toEqual({ id: f.reader.id, hasUnreadChatMessages: true });
			expect(await f.chatService.getUserReadStateMap(f.reader.id, [f.violet.id])).toEqual({ violet: false });
		});

		test('muting or unmuting an account with nothing unread says nothing', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.userMutingService.mute(f.reader, f.violet);
			await f.userMutingService.unmute([...f.mutings]);

			expect(f.told()).toEqual([]);
		});

		test('a room message from a muted account still counts and notifies', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.userMutingService.mute(f.reader, f.violet);

			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(f.told()).toEqual(['newChatMessage']);
		});
	});
});
