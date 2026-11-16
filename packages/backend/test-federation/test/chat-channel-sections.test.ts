/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { deepStrictEqual, strictEqual } from 'node:assert';
import { test, vi } from 'vitest';
import { createAccount, fetchAdmin, WAIT_FOR_SLOW_FEDERATION } from './utils.js';
import type { LoginUser } from './utils.js';

/**
 * b.test를 섹션을 지원하지 않는 이전 버전으로 띄웠을 때만 평평한 목록 시험이 돈다 (CHERRYPICK_FED_NO_SECTIONS_HOST=b.test).
 * 두 서버가 모두 섹션을 지원하는 평소 구성에서는 건너뛴다.
 */
const noSectionsHost = process.env.CHERRYPICK_FED_NO_SECTIONS_HOST;

async function joinedRoom(owner: LoginUser, member: LoginUser) {
	const room = await owner.client.request('chat/rooms/create', { name: crypto.randomUUID() });
	const { url } = await owner.client.request('chat/rooms/invite-link/create', { roomId: room.id });
	await member.client.request('chat/invite-link/join', { url });
	const joined = await vi.waitFor(async () => {
		const status = await member.client.request('chat/invite-link/join-status', { url });
		if (status.status !== 'joined' || status.roomId == null) throw new Error('join pending');
		return status;
	}, WAIT_FOR_SLOW_FEDERATION);
	await owner.client.request('chat/rooms/convert-to-channels', { roomId: room.id });
	return { roomId: room.id, mirrorId: joined.roomId! };
}

async function channelNames(user: LoginUser, roomId: string): Promise<string[]> {
	return (await user.client.request('chat/rooms/channels/list', { roomId })).map(channel => channel.name);
}

test.runIf(noSectionsHost == null)('section structure and order reach the member server', async () => {
	const owner = await createAccount('a.test');
	const member = await createAccount('b.test');
	const { roomId, mirrorId } = await joinedRoom(owner, member);
	// 전환이 만든 기본 채널도 배치에 정확히 한 번 포함해야 한다.
	const [general] = await owner.client.request('chat/rooms/channels/list', { roomId });
	strictEqual(general.name, 'general');
	const names = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
	const channels = [];
	for (const name of names) channels.push(await owner.client.request('chat/rooms/channels/create', { roomId, name }));
	const sectionA = await owner.client.request('chat/rooms/sections/create', { roomId, name: crypto.randomUUID() });
	const sectionB = await owner.client.request('chat/rooms/sections/create', { roomId, name: crypto.randomUUID() });
	await owner.client.request('chat/rooms/channels/arrange', {
		roomId,
		ungrouped: [general.id],
		sections: [
			{ sectionId: sectionB.id, channelIds: [channels[2].id] },
			{ sectionId: sectionA.id, channelIds: [channels[0].id, channels[1].id] },
		],
	});

	await vi.waitFor(async () => {
		const sections = await member.client.request('chat/rooms/sections/list', { roomId: mirrorId });
		deepStrictEqual(sections.map(section => section.name), [sectionB.name, sectionA.name]);
	}, WAIT_FOR_SLOW_FEDERATION);
	const memberSections = await member.client.request('chat/rooms/sections/list', { roomId: mirrorId });
	const memberChannels = await member.client.request('chat/rooms/channels/list', { roomId: mirrorId });
	deepStrictEqual(memberChannels.map(channel => channel.name), [general.name, names[2], names[0], names[1]]);
	deepStrictEqual(memberChannels.map(channel => channel.sectionId), [null, memberSections[0].id, memberSections[1].id, memberSections[1].id]);

	const renamed = crypto.randomUUID();
	await owner.client.request('chat/rooms/sections/update', { sectionId: sectionA.id, name: renamed });
	await vi.waitFor(async () => {
		const sections = await member.client.request('chat/rooms/sections/list', { roomId: mirrorId });
		strictEqual(sections.find(section => section.id === memberSections[1].id)?.name, renamed);
	}, WAIT_FOR_SLOW_FEDERATION);

	await owner.client.request('chat/rooms/sections/delete', { sectionId: sectionB.id });
	await vi.waitFor(async () => {
		const sections = await member.client.request('chat/rooms/sections/list', { roomId: mirrorId });
		deepStrictEqual(sections.map(section => section.name), [renamed]);
		const list = await member.client.request('chat/rooms/channels/list', { roomId: mirrorId });
		deepStrictEqual(list.map(channel => channel.name), [general.name, names[2], names[0], names[1]]);
		deepStrictEqual(list.map(channel => channel.sectionId), [null, null, sections[0].id, sections[0].id]);
	}, WAIT_FOR_SLOW_FEDERATION);

	await owner.client.request('chat/rooms/channels/delete', { channelId: channels[0].id });
	await vi.waitFor(async () => {
		const sections = await member.client.request('chat/rooms/sections/list', { roomId: mirrorId });
		deepStrictEqual(sections.map(section => section.name), [renamed]);
		const list = await member.client.request('chat/rooms/channels/list', { roomId: mirrorId });
		deepStrictEqual(list.map(channel => channel.name), [general.name, names[2], names[1]]);
		deepStrictEqual(list.map(channel => channel.sectionId), [null, null, sections[0].id]);
	}, WAIT_FOR_SLOW_FEDERATION);
}, 180_000);

test.runIf(noSectionsHost === 'b.test')('a server without section support sees the same flat order', async () => {
	const owner = await createAccount('a.test');
	const member = await createAccount('b.test');
	const { roomId, mirrorId } = await joinedRoom(owner, member);
	// 전환이 만든 기본 채널도 배치에 정확히 한 번 포함해야 한다.
	const [general] = await owner.client.request('chat/rooms/channels/list', { roomId });
	strictEqual(general.name, 'general');
	const names = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
	const channels = [];
	for (const name of names) channels.push(await owner.client.request('chat/rooms/channels/create', { roomId, name }));
	const section = await owner.client.request('chat/rooms/sections/create', { roomId, name: crypto.randomUUID() });
	await owner.client.request('chat/rooms/channels/arrange', {
		roomId,
		ungrouped: [general.id, channels[0].id],
		sections: [{ sectionId: section.id, channelIds: [channels[2].id, channels[1].id] }],
	});
	const ownerOrder = await channelNames(owner, roomId);
	deepStrictEqual(ownerOrder, [general.name, names[0], names[2], names[1]]);

	await vi.waitFor(async () => {
		deepStrictEqual(await channelNames(member, mirrorId), ownerOrder);
	}, WAIT_FOR_SLOW_FEDERATION);

	const admin = await fetchAdmin('a.test');
	const jobs = await admin.client.request('admin/queue/jobs', { queue: 'deliver', state: ['completed'], search: owner.id });
	strictEqual(jobs.some(job => {
		const data = job.data as { to?: string; content?: string };
		const activity = JSON.parse(data.content ?? '{}') as { type?: string; object?: { _misskey_chatChannelSections?: unknown } };
		return data.to?.includes('b.test') === true && activity.type === 'Update' && Array.isArray(activity.object?._misskey_chatChannelSections);
	}), true);
}, 180_000);
