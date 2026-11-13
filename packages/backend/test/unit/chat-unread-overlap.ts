/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { DeleteAccountProcessorService } from '@/queue/processors/DeleteAccountProcessorService.js';
import type { MiChatMessage } from '@/models/_.js';
import type { DbUserDeleteJobData } from '@/queue/types.js';
import { chatUnreadFixture as fixture } from '../misc/chat-unread-fixture.js';

type Fixture = ReturnType<typeof fixture>;
type Insert = (message: Partial<MiChatMessage>) => Promise<Partial<MiChatMessage>>;

/** Runs `afterCommit` the moment the message row is stored, as another request on the server could. */
function onStored(f: Fixture, afterCommit: (stored: Partial<MiChatMessage>) => Promise<void> | void) {
	const repository = (f.chatService as unknown as { chatMessagesRepository: { insertOne: Insert } }).chatMessagesRepository;
	const insert = repository.insertOne;
	vi.spyOn(repository, 'insertOne').mockImplementation(async message => {
		const stored = await insert(message);
		await afterCommit(stored);
		return stored;
	});
}

function send(f: Fixture, kind: 'direct' | 'room', text: string) {
	return kind === 'direct'
		? f.chatService.createMessageToUser(f.violet, f.reader, { text })
		: f.chatService.createMessageToRoom(f.violet, f.room, { text });
}

function read(f: Fixture, kind: 'direct' | 'room', boundary?: { seenIds: string[]; upTo: string | null }) {
	return kind === 'direct'
		? f.chatService.readUserChatMessage(f.reader.id, f.violet.id, boundary)
		: f.chatService.readRoomChatMessage(f.reader.id, f.room.id, boundary);
}

async function readState(f: Fixture, kind: 'direct' | 'room') {
	return kind === 'direct'
		? (await f.chatService.getUserReadStateMap(f.reader.id, [f.violet.id]))[f.violet.id]
		: (await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id]))[f.room.id];
}

/** A Redis that stopped answering after the test set things up. */
function failRedis(f: Fixture) {
	vi.spyOn(f.redis, 'eval').mockRejectedValue(new Error('Redis unavailable'));
}

describe('chat unread marks around other requests', () => {
	afterEach(() => vi.useRealTimers());

	describe('withdrawals and departures still reach other servers when the unread mark cannot be cleaned up', () => {
		test('a withdrawn room message', async () => {
			vi.useFakeTimers();
			const f = fixture({ remoteMembers: true });
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'taken back' });
			f.delivered.length = 0;
			failRedis(f);

			await f.chatService.deleteMessage(f.stored('taken back'));

			expect(f.delivered.map(({ type, inbox }) => [type, inbox])).toEqual([
				['Delete', f.cobalt.inbox],
				['Delete', f.dahlia.inbox],
			]);
		});

		test('a withdrawal from another server that the owner passes on', async () => {
			vi.useFakeTimers();
			const f = fixture({ remoteMembers: true });
			f.messages.push({ id: 'remote1', fromUserId: f.cobalt.id, toRoomId: f.room.id, text: 'from afar', deletedAt: null });
			failRedis(f);

			await f.chatService.deleteRemoteMessage(f.cobalt, f.stored('from afar'), { activity: { id: 'https://remote.test/activities/1', type: 'Delete' } });

			expect(f.delivered.map(({ type, inbox }) => [type, inbox])).toEqual([['Announce', f.dahlia.inbox]]);
		});

		test('a member leaving the room', async () => {
			vi.useFakeTimers();
			const f = fixture({ remoteMembers: true });
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'unread' });
			f.delivered.length = 0;
			failRedis(f);

			await f.chatService.leaveRoom(f.reader.id, f.room.id);

			expect(f.delivered.map(({ type }) => type)).toEqual(['Remove', 'Remove']);
		});

		test('a deleted room is gone here as well as there', async () => {
			vi.useFakeTimers();
			const f = fixture({ remoteMembers: true });
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'unread' });
			f.delivered.length = 0;
			failRedis(f);

			await f.chatService.deleteRoom(f.room);

			expect(f.roomPresent()).toBe(false);
			expect(f.delivered.map(({ type }) => type)).toEqual(['Delete', 'Delete']);
		});
	});

	describe.each(['direct', 'room'] as const)('a %s message and the reader’s timeline', kind => {
		test('a failed send never takes away a message the reader could already fetch', async () => {
			vi.useFakeTimers();
			const f = fixture();
			const fetched: string[] = [];
			onStored(f, stored => { fetched.push(stored.id!); });
			vi.spyOn(f.redis, 'eval').mockRejectedValueOnce(new Error('injected Redis failure'));

			await expect(send(f, kind, 'retry safely')).rejects.toThrow('injected Redis failure');

			const goneWithoutNotice = fetched.filter(id => !f.messages.some(message => message.id === id));
			expect(goneWithoutNotice).toEqual([]);
			expect(f.messages.filter(message => message.text === 'retry safely')).toEqual([]);
		});

		test('a message the reader fetched as soon as it was stored stays read', async () => {
			vi.useFakeTimers();
			const f = fixture();
			onStored(f, stored => read(f, kind, { seenIds: [stored.id!], upTo: null }));

			await send(f, kind, 'fetched at once');

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await readState(f, kind)).toBe(true);
		});

		test('a read keeps a message that arrived after its timeline was selected', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await send(f, kind, 'selected');
			const selected = [f.stored('selected').id];
			await send(f, kind, 'arrived after the select');

			await read(f, kind, { seenIds: selected, upTo: null });

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(await readState(f, kind)).toBe(false);
		});

		test('a read up to a message keeps a newer one the reader has not received', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await send(f, kind, 'received');
			const received = f.stored('received').id;
			await send(f, kind, 'still on its way');

			await read(f, kind, { seenIds: [], upTo: received });

			expect(await readState(f, kind)).toBe(false);
		});

		test('a message read before a newer one arrived is not announced with it', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await send(f, kind, 'already read');
			await read(f, kind);
			await send(f, kind, 'still unread');

			await vi.advanceTimersByTimeAsync(3000);

			expect(f.push).not.toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.objectContaining({ text: 'already read' }));
			expect(f.push).toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.objectContaining({ text: 'still unread' }));
		});
	});

	describe('marks kept from before unread messages had IDs', () => {
		test('a legacy direct mark does not stay on for the reader’s own reply', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'only' });
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			for (const suffix of [':first', ':revision', ':messages', ':pending']) await f.redis.del(`${key}${suffix}`);
			await f.chatService.createMessageToUser(f.reader, f.violet, { text: 'reply' });

			await f.chatService.deleteMessage(f.stored('only'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a legacy room mark does not stay on for the reader’s own message', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'only' });
			const key = `newRoomChatMessageExists:${f.reader.id}:${f.room.id}`;
			for (const suffix of [':first', ':revision', ':messages', ':pending']) await f.redis.del(`${key}${suffix}`);
			await f.chatService.createMessageToRoom(f.reader, f.room, { text: 'mine' });

			await f.chatService.deleteMessage(f.stored('only'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a legacy mark with another visible message still counts', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'older' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'withdrawn' });
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			for (const suffix of [':first', ':revision', ':messages', ':pending']) await f.redis.del(`${key}${suffix}`);

			await f.chatService.deleteMessage(f.stored('withdrawn'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		});
	});

	describe('muting a room while a message is being sent to it', () => {
		test('the owner who muted it does not get the message as unread', async () => {
			vi.useFakeTimers();
			const f = fixture();
			onStored(f, () => { f.room.isMutedByOwner = true; });

			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'crossing' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.violet.id)).toBe(false);
			expect(f.push).not.toHaveBeenCalledWith(f.violet.id, 'newChatMessage', expect.anything());
		});

		test('a member who muted it does not get the message as unread', async () => {
			vi.useFakeTimers();
			const f = fixture();
			onStored(f, () => { f.memberships[0].isMuted = true; });

			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'crossing' });

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('what was unread before the mute stays unread', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'before' });
			onStored(f, () => { f.memberships[0].isMuted = true; });

			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'crossing' });

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.deleteMessage(f.stored('before'));
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});

	describe('deleting an account', () => {
		test('a remote account deleted here keeps the conversations it left on screen unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'still shown' });

			await f.deleteAccountService.deleteAccount(f.violet);

			expect(f.told()).toEqual([]);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		});

		function processorFor(f: Fixture, deliveryStates: Record<string, string>) {
			const notesFind = vi.fn(async () => []);
			const usersDelete = vi.fn(async () => {
				// The user's foreign keys take their messages with them.
				for (const message of f.messages.filter(row => row.fromUserId === f.violet.id)) f.messages.splice(f.messages.indexOf(message), 1);
			});
			const createDeleteAccountJob = vi.fn();
			const sendEmail = vi.fn();
			const processor = Object.assign(Object.create(DeleteAccountProcessorService.prototype), {
				logger: f.logger,
				usersRepository: { findOneBy: async () => f.violet, delete: usersDelete },
				notesRepository: { find: notesFind },
				driveFilesRepository: { find: async () => [] },
				pagesRepository: { find: async () => [] },
				userProfilesRepository: { findOneByOrFail: async () => ({ email: 'violet@local.test', emailVerified: true }) },
				emailService: { sendEmail },
				userEntityService: { isRemoteUser: () => false, isLocalUser: () => true },
				globalEventService: { publishInternalEvent: vi.fn() },
				queueService: {
					createDeleteAccountJob,
					// A queued delivery waits until the test moves it on. One the queue no longer keeps is not found.
					deliverQueue: {
						getJob: async (id: string) => {
							const state = deliveryStates[id] ?? (f.delivered.some(delivery => delivery.jobId === id) ? 'waiting' : undefined);
							return state != null && state !== 'removed' ? { getState: async () => state } : undefined;
						},
						// What the queue holds in the given states, as BullMQ names them ('wait' for a job whose state reads 'waiting').
						getJobs: async (states: string[]) => f.delivered
							.map(delivery => ({ delivery, state: deliveryStates[delivery.jobId] ?? 'waiting' }))
							.filter(({ state }) => state !== 'removed' && states.includes(state === 'waiting' ? 'wait' : state))
							.map(({ delivery, state }) => ({ id: delivery.jobId, data: { user: { id: delivery.actorId } }, getState: async () => state })),
					},
				},
				chatService: f.chatService,
				deleteAccountService: { queueAccountDelete: vi.fn(async () => []) },
			}) as DeleteAccountProcessorService;
			return { processor, notesFind, usersDelete, createDeleteAccountJob, sendEmail };
		}

		/** The queue keeps a job with whatever was written into it, and runs it from the start again once its process is gone. */
		function deletionJob(data: DbUserDeleteJobData) {
			const job = { data, updateData: async (next: DbUserDeleteJobData) => { job.data = next; } };
			return job;
		}

		test('the owner’s keys outlive the room deletions still on the queue', async () => {
			vi.useFakeTimers();
			const f = fixture({ remoteMembers: true });
			const states: Record<string, string> = {};
			const run = processorFor(f, states);

			await run.processor.process(deletionJob({ user: { id: f.violet.id }, soft: false }) as never);

			const deletions = f.delivered.filter(delivery => delivery.actorId === f.violet.id && delivery.type === 'Delete').map(delivery => delivery.jobId);
			expect(deletions).toHaveLength(2);
			expect(run.usersDelete).not.toHaveBeenCalled();
			expect(run.createDeleteAccountJob).toHaveBeenCalledWith({ id: f.violet.id }, expect.objectContaining({ soft: false, deliveries: deletions }));

			states[deletions[0]] = 'completed';
			states[deletions[1]] = 'delayed';
			const waiting = processorFor(f, states);
			await waiting.processor.process({ data: { user: { id: f.violet.id }, soft: false, deliveries: deletions } } as never);
			expect(waiting.usersDelete).not.toHaveBeenCalled();
			expect(waiting.notesFind).not.toHaveBeenCalled();
			expect(waiting.sendEmail).not.toHaveBeenCalled();
			// Only what is still on its way is waited for again.
			expect(waiting.createDeleteAccountJob).toHaveBeenCalledWith({ id: f.violet.id }, expect.objectContaining({ soft: false, deliveries: [deletions[1]] }));

			states[deletions[1]] = 'removed';
			const finishing = processorFor(f, states);
			await finishing.processor.process({ data: { user: { id: f.violet.id }, soft: false, deliveries: [deletions[1]] } } as never);
			expect(finishing.usersDelete).toHaveBeenCalledOnce();
			expect(finishing.notesFind).not.toHaveBeenCalled();
		});

		test('a deletion stopped after the rooms went still waits for their deletions when it runs again', async () => {
			vi.useFakeTimers();
			const f = fixture({ remoteMembers: true });
			const job = deletionJob({ user: { id: f.violet.id }, soft: false });
			const first = processorFor(f, {});
			vi.spyOn(f.chatService, 'deleteMessagesFromUser').mockRejectedValueOnce(new Error('stopped after the rooms went'));

			await expect(first.processor.process(job as never)).rejects.toThrow('stopped after the rooms went');

			const deletions = f.delivered.filter(delivery => delivery.actorId === f.violet.id && delivery.type === 'Delete').map(delivery => delivery.jobId);
			expect(deletions).toHaveLength(2);
			expect(first.createDeleteAccountJob).not.toHaveBeenCalled();

			const again = processorFor(f, {});
			await again.processor.process(job as never);

			expect(again.usersDelete).not.toHaveBeenCalled();
			expect(again.createDeleteAccountJob).toHaveBeenCalledWith({ id: f.violet.id }, expect.objectContaining({ soft: false, deliveries: expect.arrayContaining(deletions) }));
		});

		test('an account without anything on the queue is removed at once, and its direct messages stop counting', async () => {
			vi.useFakeTimers();
			const f = fixture();
			f.room.ownerId = f.amber.id;
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'from the account' });
			const run = processorFor(f, {});

			await run.processor.process(deletionJob({ user: { id: f.violet.id }, soft: false }) as never);

			expect(run.usersDelete).toHaveBeenCalledOnce();
			expect(f.told()).toContain('readAllChatMessages');
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('the deliveries of the account’s own Delete are waited for with those of its rooms', async () => {
			vi.useFakeTimers();
			const f = fixture();
			f.room.ownerId = f.amber.id;
			const run = processorFor(f, { 'account-delete': 'delayed' });

			await run.processor.process(deletionJob({ user: { id: f.violet.id }, soft: false, accountDeliveries: ['account-delete'] }) as never);

			expect(run.usersDelete).not.toHaveBeenCalled();
			expect(run.createDeleteAccountJob).toHaveBeenCalledWith({ id: f.violet.id }, expect.objectContaining({ soft: false, deliveries: ['account-delete'] }));
		});

		test('the deletion job registers each known shared inbox once', async () => {
			const deliver = vi.fn(async (_user: unknown, _content: unknown, inbox: string) => ({ id: `delivery:${inbox}` }));
			const createDeleteAccountJob = vi.fn();
			const service = Object.assign(Object.create(DeleteAccountService.prototype), {
				meta: { rootUserId: 'root' },
				usersRepository: { findOneByOrFail: async () => ({ id: 'leaving', username: 'leaving' }), update: async () => undefined },
				userEntityService: { isLocalUser: () => true, genLocalUserUri: (id: string) => `https://local.test/users/${id}` },
				apRendererService: { renderDelete: () => ({ type: 'Delete' }), addContext: (activity: unknown) => activity },
				// Every shared inbox this server knows of gets the Delete once.
				followingsRepository: {
					find: async () => [
						{ followerSharedInbox: 'https://one.test/inbox', followeeSharedInbox: null },
						{ followerSharedInbox: null, followeeSharedInbox: 'https://two.test/inbox' },
						{ followerSharedInbox: 'https://one.test/inbox', followeeSharedInbox: null },
					],
				},
				queueService: { deliver, createDeleteAccountJob },
				globalEventService: { publishInternalEvent: vi.fn() },
			}) as DeleteAccountService;

			const deliveries = await service.queueAccountDelete({ id: 'leaving', host: null });

			expect(deliveries).toEqual(['delivery:https://one.test/inbox', 'delivery:https://two.test/inbox']);
			expect(deliver).toHaveBeenCalledTimes(2);
			await service.deleteAccount({ id: 'leaving', host: null });
			expect(createDeleteAccountJob).toHaveBeenCalledWith({ id: 'leaving', host: null }, { soft: false });
		});
	});
});

describe('a mark left by a send that never finished', () => {
	afterEach(() => vi.useRealTimers());

	type Insert = (message: Partial<MiChatMessage>) => Promise<Partial<MiChatMessage>>;

	/** The process stopped after the mark and before the INSERT, or the INSERT failed and so did every cleanup. */
	async function abandonedSend(f: Fixture, kind: 'direct' | 'room') {
		const repository = (f.chatService as unknown as { chatMessagesRepository: { insertOne: Insert } }).chatMessagesRepository;
		vi.spyOn(repository, 'insertOne').mockRejectedValueOnce(new Error('process stopped before the INSERT'));
		const evaluate = f.redis.eval;
		// 표식은 남고, 그 뒤의 정리는 하나도 Redis에 닿지 않는다.
		const cleanupFails = vi.spyOn(f.redis, 'eval').mockImplementation(async (script, ...args) => {
			if (script.startsWith('-- mark chat unread')) return await evaluate(script, ...args);
			throw new Error('Redis gone with the process');
		});
		await expect(send(f, kind, 'never stored')).rejects.toThrow('process stopped before the INSERT');
		cleanupFails.mockRestore();
	}

	describe.each(['direct', 'room'] as const)('in a %s conversation', kind => {
		test('the sign does not count it, on screen or at login', async () => {
			vi.useFakeTimers();
			const f = fixture();

			await abandonedSend(f, kind);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await readState(f, kind)).toBe(true);
		});

		test('withdrawing a later message still turns the sign off on open screens', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await abandonedSend(f, kind);
			await send(f, kind, 'later');

			await f.chatService.deleteMessage(f.stored('later'));

			expect(f.told()).toContain('readAllChatMessages');
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a send still holding its lock is waited for, however long it takes', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await abandonedSend(f, kind);
			// 메모리 Redis 대역은 명령마다 같은 응답 타입을 쓴다. SMEMBERS의 응답은 문자열 배열이다.
			const [id] = await f.redis.smembers(`${kind === 'direct' ? `newUserChatMessageExists:${f.reader.id}:${f.violet.id}` : `newRoomChatMessageExists:${f.reader.id}:${f.room.id}`}:pending`) as string[];
			const locks = (f.chatService as unknown as { db: { held: Set<string> } }).db.held;
			locks.add(`chat-message-send:${id}`);

			await read(f, kind);
			expect(await f.redis.smembers(`newChatMessagesExists:${f.reader.id}`)).toHaveLength(1);

			locks.delete(`chat-message-send:${id}`);
			await read(f, kind);
			expect(await f.redis.smembers(`newChatMessagesExists:${f.reader.id}`)).toEqual([]);
		});

		test('a stored message whose send stopped before settling stays unread, and a later withdrawal still works', async () => {
			vi.useFakeTimers();
			const f = fixture();
			const evaluate = f.redis.eval;
			const settleFails = vi.spyOn(f.redis, 'eval').mockImplementation(async (script, ...args) => {
				if (script.startsWith('-- settle chat unread')) throw new Error('process stopped after the INSERT');
				return await evaluate(script, ...args);
			});
			await send(f, kind, 'stored');
			settleFails.mockRestore();
			await send(f, kind, 'withdrawn later');

			await f.chatService.deleteMessage(f.stored('withdrawn later'));
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			await f.chatService.deleteMessage(f.stored('stored'));

			expect(f.told()).toContain('readAllChatMessages');
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a read or read-all leaves no mark for it behind', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await abandonedSend(f, kind);

			await read(f, kind);
			await f.chatService.readAllChatMessages(f.reader.id);

			expect(await f.redis.smembers(`newChatMessagesExists:${f.reader.id}`)).toEqual([]);
		});
	});
});
