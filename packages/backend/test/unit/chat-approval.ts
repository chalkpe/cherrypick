/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { ChatService } from '@/core/ChatService.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

const alice = { id: 'alice', host: null, chatScope: 'everyone', isSuspended: false };
const bob = { id: 'bob', host: null, chatScope: 'everyone', isSuspended: false };

function duplicateKey() {
	return new QueryFailedError('INSERT INTO "chat_approval"', [], Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }));
}

function fixture(options: { insertApproval?: () => Promise<void> } = {}) {
	const approvals: { userId: string; otherId: string }[] = [];
	const messages: { id: string; text: string | null }[] = [];
	const published: unknown[] = [];
	let sequence = 0;
	const chatService = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		chatApprovalsRepository: {
			createQueryBuilder: () => ({
				where() { return this; },
				orWhere() { return this; },
				take() { return this; },
				getMany: async () => [...approvals],
			}),
			// The same as the unique index on (userId, otherId) of the real table.
			insertOne: async (approval: typeof approvals[number]) => {
				await options.insertApproval?.();
				if (approvals.some(a => a.userId === approval.userId && a.otherId === approval.otherId)) throw duplicateKey();
				approvals.push(approval);
				return approval;
			},
		},
		chatMessagesRepository: {
			insertOne: async (message: typeof messages[number]) => { messages.push(message); return message; },
		},
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null, isRemoteUser: (user: { host: string | null }) => user.host != null },
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		idService: { gen: () => `id${++sequence}` },
		chatEntityService: { packMessageLiteFor1on1: async (message: unknown) => message },
		customEmojiService: { populateEmojis: async () => ({}) },
		globalEventService: {
			publishChatUserStream: (...args: unknown[]) => { published.push(args); },
			publishMainStream: () => {},
		},
		redisClient: memoryRedis(),
	});
	const send = (text: string) => chatService.createMessageToUser(alice, bob, { text });
	return { send, approvals, messages, published };
}

describe('the approval that comes with the first message to someone', () => {
	test('two first messages at once both go out, and leave one approval', async () => {
		const f = fixture();

		const sent = await Promise.allSettled([f.send('one'), f.send('two')]);

		expect(sent.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
		expect(f.messages.map(message => message.text).toSorted()).toEqual(['one', 'two']);
		expect(f.approvals).toEqual([expect.objectContaining({ userId: 'alice', otherId: 'bob' })]);
	});

	test('a message is not reported as sent before its approval is in', async () => {
		let release = () => {};
		const held = new Promise<void>(resolve => { release = resolve; });
		const f = fixture({ insertApproval: () => held });
		let done = false;

		const sending = f.send('one').then(() => { done = true; });
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(done).toBe(false);

		release();
		await sending;
		expect(f.approvals).toHaveLength(1);
	});

	test('another failure of the approval is not hidden, and no message stays behind to be sent again', async () => {
		const f = fixture({ insertApproval: async () => { throw new Error('the database is gone'); } });

		await expect(f.send('one')).rejects.toThrow('the database is gone');

		expect(f.messages).toEqual([]);
		expect(f.published).toEqual([]);
	});

	test('a later message adds no approval', async () => {
		const f = fixture();
		await f.send('one');

		await f.send('two');

		expect(f.messages).toHaveLength(2);
		expect(f.approvals).toHaveLength(1);
	});
});
