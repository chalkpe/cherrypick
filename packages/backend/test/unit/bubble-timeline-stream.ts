/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { BubbleTimelineChannel } from '@/server/api/stream/channels/bubble-timeline.js';
import { NoteStreamingHidingService } from '@/server/api/stream/NoteStreamingHidingService.js';

function fixture(user: { id: string } | null, following: Record<string, unknown>) {
	const subscriber = new EventEmitter();
	const sendMessageToWs = vi.fn();
	const connection = {
		user, following, subscriber, sendMessageToWs,
		userMutedInstances: new Set(), userIdsWhoMeMuting: new Set(), userIdsWhoBlockingMe: new Set(),
		userIdsWhoMeMutingRenotes: new Set(), mutingChannels: new Set(), followingChannels: new Set(),
	};
	const noteEntityService = {
		shouldHideNote: vi.fn(async (n: any) => n.hiddenForViewer === true),
		hideNote: vi.fn((n: any) => { n.text = null; n.cw = null; n.files = []; n.fileIds = []; n.isHidden = true; }),
		withMyRenoteReaction: vi.fn(async (n: any) => n),
	};
	const hiding = new NoteStreamingHidingService({ ugcVisibilityForVisitor: 'all' } as any, noteEntityService as any);
	const channel = new BubbleTimelineChannel(
		{ id: 'ch', connection: connection as any },
		{ fetch: vi.fn().mockResolvedValue({ bubbleInstances: ['bubble.example'] }) } as any,
		{ getUserPolicies: vi.fn().mockResolvedValue({ btlAvailable: true }) } as any,
		noteEntityService as any,
		hiding,
	);
	return { channel, subscriber, sendMessageToWs, noteEntityService };
}

const bubbleNote = (extra: Record<string, unknown> = {}) => ({
	id: 'n1', userId: 'remote', visibility: 'public', channelId: null, text: 'hi', fileIds: [],
	user: { id: 'remote', host: 'bubble.example', isBot: false, isCat: false },
	reply: { id: 'r1', userId: 'third', text: 'secret', hiddenForViewer: true, user: { id: 'third', host: null } },
	...extra,
});

const emit = async (subscriber: EventEmitter, note: unknown) => {
	for (const listener of subscriber.listeners('notesStream')) await (listener as any)(note);
};

describe('bubbleTimeline stream', () => {
	test('hides the reply target for the viewer before sending', async () => {
		const { channel, subscriber, sendMessageToWs } = fixture({ id: 'me' }, { remote: {} });
		await channel.init({});
		await emit(subscriber, bubbleNote());
		expect(sendMessageToWs).toHaveBeenCalledOnce();
		const body = sendMessageToWs.mock.calls[0][1].body;
		expect(body.id).toBe('n1');
		expect(body.reply.text).toBeNull();
		expect(body.reply.isHidden).toBe(true);
	});

	test('still requires following the author', async () => {
		const { channel, subscriber, sendMessageToWs } = fixture({ id: 'me' }, {});
		await channel.init({});
		await emit(subscriber, bubbleNote());
		expect(sendMessageToWs).not.toHaveBeenCalled();
	});

	test('does not throw for a connection without a user', async () => {
		const { channel, subscriber, sendMessageToWs } = fixture(null, {});
		await channel.init({});
		await expect(emit(subscriber, bubbleNote())).resolves.toBeUndefined();
		expect(sendMessageToWs).not.toHaveBeenCalled();
	});
});
