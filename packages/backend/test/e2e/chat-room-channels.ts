/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { api, connectStream, signup, uploadFile } from '../utils.js';
import type { UserToken } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

describe('그룹 채널 API', () => {
	let owner: Awaited<ReturnType<typeof signup>>;
	let member: Awaited<ReturnType<typeof signup>>;
	let outsider: Awaited<ReturnType<typeof signup>>;

	beforeAll(async () => {
		owner = await signup({ username: 'channelowner' });
		member = await signup({ username: 'channelmember' });
		outsider = await signup({ username: 'channeloutsider' });
	});

	afterAll(waitForChatNotificationTurn, 30_000);

	async function createRoom(joinMember = true) {
		const response = await api('chat/rooms/create', { name: '채널 시험' }, owner);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		if (joinMember) {
			expect((await api('chat/rooms/invitations/create', { roomId: response.body.id, userId: member.id }, owner)).status).toBe(200);
			expect((await api('chat/rooms/join', { roomId: response.body.id }, member)).status).toBe(204);
		}
		return response.body.id;
	}

	async function convert(roomId: string) {
		const response = await api('chat/rooms/convert-to-channels', { roomId }, owner);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		expect(response.body.hasChannels).toBe(true);
		const list = await api('chat/rooms/channels/list', { roomId }, owner);
		expect(list.status, JSON.stringify(list.body)).toBe(200);
		return list.body[0];
	}

	async function createChannel(roomId: string, name = '작업') {
		const response = await api('chat/rooms/channels/create', { roomId, name }, owner);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body;
	}

	async function send(roomId: string, channelId: string | undefined, text: string, user: UserToken = member) {
		const response = await api('chat/messages/create-to-room', { toRoomId: roomId, toRoomChannelId: channelId, text }, user);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body;
	}

	test('그룹장만 원자적으로 전환하고 기존 기록을 general로 귀속한다', async () => {
		const roomId = await createRoom();
		const old = await send(roomId, undefined, '전환 전 기록');
		expect((await api('chat/rooms/convert-to-channels', { roomId }, member)).status).toBe(400);
		expect((await api('chat/rooms/convert-to-channels', { roomId }, outsider)).status).toBe(400);

		const general = await convert(roomId);
		const timeline = await api('chat/messages/room-timeline', { roomId }, member);

		expect(general).toMatchObject({ name: 'general', isLegacy: true });
		expect(timeline.body.find(message => message.id === old.id)).toMatchObject({ toRoomChannelId: general.id });
		expect((await api('chat/rooms/convert-to-channels', { roomId }, owner)).status).toBe(400);
	});

	test('전환과 동시에 저장한 메시지도 기본 채널에 귀속한다', async () => {
		const roomId = await createRoom();

		const [converted, created] = await Promise.all([
			api('chat/rooms/convert-to-channels', { roomId }, owner),
			api('chat/messages/create-to-room', { toRoomId: roomId, text: '동시 저장' }, member),
		]);

		expect(converted.status).toBe(200);
		expect(created.status).toBe(200);
		const stored = await api('chat/messages/show', { messageId: created.body.id }, member);
		expect(stored.body.toRoomChannelId).toBe(converted.body.legacyChannelId);
	});

	test('채널 관리와 목록은 소유자·멤버 권한을 구분한다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		const other = await createChannel(roomId);

		expect((await api('chat/rooms/channels/list', { roomId }, member)).status).toBe(200);
		expect((await api('chat/rooms/channels/list', { roomId }, outsider)).status).toBe(400);
		expect((await api('chat/rooms/channels/create', { roomId, name: '거부' }, member)).status).toBe(400);
		expect((await api('chat/rooms/channels/update', { channelId: general.id, name: '거부' }, member)).status).toBe(400);
		expect((await api('chat/rooms/channels/reorder', { roomId, channelIds: [other.id, general.id] }, member)).status).toBe(400);
		expect((await api('chat/rooms/channels/delete', { channelId: general.id }, member)).status).toBe(400);
		const ordered = await api('chat/rooms/channels/reorder', { roomId, channelIds: [other.id, general.id] }, owner);
		expect(ordered.body.map(channel => channel.id)).toEqual([other.id, general.id]);
		expect((await api('chat/rooms/channels/reorder', { roomId, channelIds: [other.id] }, owner)).status).toBe(400);
	});

	test('이름은 128자까지이며 앞뒤 공백 외 문자와 동명이름을 허용한다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		const first = await createChannel(roomId, '  A #한글 / 😀  ');
		const second = await createChannel(roomId, 'A #한글 / 😀');
		const max = await createChannel(roomId, '😀'.repeat(128));

		expect(first.name).toBe('A #한글 / 😀');
		expect(first.id).not.toBe(second.id);
		expect(Array.from(max.name)).toHaveLength(128);
		expect((await api('chat/rooms/channels/create', { roomId, name: '가'.repeat(129) }, owner)).status).toBe(400);
		expect((await api('chat/rooms/channels/create', { roomId, name: '   ' }, owner)).status).toBe(400);
	});

	test('128개 경계에서 동시에 생성해도 한도를 넘지 않으며 새 채널은 맨 아래에 온다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		for (let i = 0; i < 126; i++) await createChannel(roomId, `채널 ${i}`);

		const responses = await Promise.all([
			api('chat/rooms/channels/create', { roomId, name: '마지막 가' }, owner),
			api('chat/rooms/channels/create', { roomId, name: '마지막 나' }, owner),
		]);

		expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
		const list = await api('chat/rooms/channels/list', { roomId }, owner);
		expect(list.body).toHaveLength(128);
		expect(list.body.at(-1)?.id).toBe(responses.find(response => response.status === 200)?.body.id);
	});

	test('채널별 타임라인과 전체·특정 채널 검색을 제공한다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		const other = await createChannel(roomId);
		const first = await send(roomId, undefined, '공통검색 기본');
		const second = await send(roomId, other.id, '공통검색 별도');

		const legacy = await api('chat/messages/room-timeline', { roomId }, member);
		const selected = await api('chat/messages/room-timeline', { roomId, channelId: other.id }, member);
		const all = await api('chat/messages/search', { roomId, query: '공통검색' }, member);
		const narrow = await api('chat/messages/search', { roomId, channelId: other.id, query: '공통검색' }, member);

		expect(legacy.body.map(message => message.id)).toEqual([first.id]);
		expect(selected.body.map(message => message.id)).toEqual([second.id]);
		expect(all.body.map(message => message.id).sort()).toEqual([first.id, second.id].sort());
		expect(narrow.body.map(message => message.id)).toEqual([second.id]);
		expect(first.toRoomChannelId).toBe(general.id);
		expect((await api('chat/messages/show', { messageId: second.id }, outsider)).status).toBe(400);
		expect((await api('chat/messages/update', { messageId: second.id, text: '가로채기' }, owner)).status).toBe(400);
		expect((await api('chat/messages/react', { messageId: second.id, reaction: '👍' }, owner)).status).toBe(204);
		expect((await api('chat/messages/unreact', { messageId: second.id, reaction: '👍' }, owner)).status).toBe(204);
	});

	test('다른 그룹의 채널과 없는 채널을 읽거나 쓸 수 없다', async () => {
		const roomId = await createRoom();
		await convert(roomId);
		const secondRoom = await createRoom();
		const foreign = await convert(secondRoom);

		expect((await api('chat/messages/create-to-room', { toRoomId: roomId, toRoomChannelId: foreign.id, text: '거부' }, member)).status).toBe(400);
		expect((await api('chat/messages/room-timeline', { roomId, channelId: foreign.id }, member)).status).toBe(400);
		expect((await api('chat/messages/search', { roomId, channelId: foreign.id, query: '거부' }, member)).status).toBe(400);
	});

	test('general을 이름 변경·삭제할 수 있으며 삭제 뒤 채널 미지정 요청을 거부한다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		const other = await createChannel(roomId);
		const renamed = await api('chat/rooms/channels/update', { channelId: general.id, name: '구버전 창구' }, owner);
		expect(renamed.body.isLegacy).toBe(true);

		expect((await api('chat/rooms/channels/delete', { channelId: general.id }, owner)).status).toBe(204);

		expect((await api('chat/messages/create-to-room', { toRoomId: roomId, text: '거부' }, member)).status).toBe(400);
		expect((await api('chat/messages/room-timeline', { roomId }, member)).status).toBe(400);
		expect((await api('chat/rooms/channels/delete', { channelId: other.id }, owner)).status).toBe(400);
		expect((await send(roomId, other.id, '명시한 채널')).toRoomChannelId).toBe(other.id);
	});

	test('선택 ID와 본문 구간을 저장하고 이름 변경·삭제 뒤에도 참조 정보를 보존한다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		const target = await createChannel(roomId, '대상');
		const response = await api('chat/messages/create-to-room', {
			toRoomId: roomId, toRoomChannelId: general.id, text: '  😀 #대상  ',
			channelRefs: [{ channelId: target.id, start: 5, length: 3 }],
		}, member);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		expect(response.body.channelRefs).toEqual([{ channelId: target.id, start: 3, length: 3 }]);
		expect((await api('chat/rooms/channels/update', { channelId: target.id, name: '새 이름' }, owner)).status).toBe(200);
		expect((await api('chat/rooms/channels/delete', { channelId: target.id }, owner)).status).toBe(204);

		const stored = await api('chat/messages/show', { messageId: response.body.id }, member);

		expect(stored.body.channelRefs).toEqual(response.body.channelRefs);
		const edited = await api('chat/messages/update', { messageId: response.body.id, text: '수정된 본문' }, member);
		expect(edited.body.channelRefs).toEqual([]);
	});

	test('채널 삭제로 메시지는 삭제하지만 드라이브 원본은 남긴다', async () => {
		const roomId = await createRoom();
		await convert(roomId);
		const target = await createChannel(roomId);
		const file = await uploadFile(member);
		const fileId = file.body?.id;
		if (fileId == null) throw new Error('file upload failed');
		const message = await api('chat/messages/create-to-room', { toRoomId: roomId, toRoomChannelId: target.id, fileIds: [fileId] }, member);
		expect(message.status).toBe(200);

		expect((await api('chat/rooms/channels/delete', { channelId: target.id }, owner)).status).toBe(204);

		expect((await api('chat/messages/show', { messageId: message.body.id }, member)).status).toBe(400);
		expect((await api('drive/files/show', { fileId }, member)).status).toBe(200);
	});

	test('보관된 그룹의 채널 구성을 변경하지 않는다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		expect((await api('chat/rooms/update', { roomId, isArchived: true }, owner)).status).toBe(200);

		expect((await api('chat/rooms/channels/create', { roomId, name: '거부' }, owner)).status).toBe(400);
		expect((await api('chat/rooms/channels/update', { channelId: general.id, name: '거부' }, owner)).status).toBe(400);
		expect((await api('chat/rooms/channels/delete', { channelId: general.id }, owner)).status).toBe(400);
	});

	test('실제 스트림에서 다른 채널의 본문과 수정 내용을 제외한다', async () => {
		const roomId = await createRoom();
		await convert(roomId);
		const other = await createChannel(roomId);
		const received: unknown[] = [];
		let finish!: () => void;
		const barrier = new Promise<void>(resolve => { finish = resolve; });
		const socket = await connectStream(owner, 'chatRoom', event => {
			received.push(event);
			if (event.type === 'message' && event.body.text === '종료 표식') finish();
		}, { roomId });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const hidden = await send(roomId, other.id, '다른 채널의 본문');
			expect((await api('chat/messages/update', { messageId: hidden.id, text: '다른 채널의 수정 본문' }, member)).status).toBe(200);
			await send(roomId, undefined, '종료 표식');
			await Promise.race([barrier, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stream barrier timed out')), 10000); })]);

			expect(JSON.stringify(received)).not.toContain('다른 채널의');
			expect(received).toContainEqual(expect.objectContaining({ type: 'channelMessage', body: { channelId: other.id, messageId: hidden.id } }));
		} finally {
			if (timer != null) clearTimeout(timer);
			socket.close();
		}
	});
});
