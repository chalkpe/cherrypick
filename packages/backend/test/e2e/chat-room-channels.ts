/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { api, connectStream, role, signup, uploadFile } from '../utils.js';
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

	test('저장할 수 없는 이름은 만들기와 이름 바꾸기에서 INVALID_CHANNEL_NAME으로 거부한다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		const channel = await createChannel(roomId, '정상');
		const invalid = ['가\u0000나', '\u0000', '가\ud800', '\udc00가'];

		for (const name of invalid) {
			const created = await api('chat/rooms/channels/create', { roomId, name }, owner);
			const renamed = await api('chat/rooms/channels/update', { channelId: channel.id, name }, owner);
			expect([created.status, (created.body as unknown as { error?: { code: string } }).error?.code], JSON.stringify(name)).toEqual([400, 'INVALID_CHANNEL_NAME']);
			expect([renamed.status, (renamed.body as unknown as { error?: { code: string } }).error?.code], JSON.stringify(name)).toEqual([400, 'INVALID_CHANNEL_NAME']);
		}
		expect((await api('chat/rooms/channels/list', { roomId }, owner)).body.map((c: { name: string }) => c.name)).toEqual(['general', '정상']);
		expect((await api('chat/rooms/channels/create', { roomId, name: '😀' }, owner)).status).toBe(200);
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

	test('삭제된 채널의 기존 참조를 유지하며 본문을 수정한다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		const target = await createChannel(roomId, '대상');
		const reference = { channelId: target.id, start: 0, length: 3 };
		const created = await api('chat/messages/create-to-room', {
			toRoomId: roomId, toRoomChannelId: general.id, text: '#대상 원문', channelRefs: [reference],
		}, member);
		expect(created.status).toBe(200);
		expect((await api('chat/rooms/channels/delete', { channelId: target.id }, owner)).status).toBe(204);
		const foreignRoom = await createRoom(false);
		const foreign = await convert(foreignRoom);
		for (const [text, channelRefs] of [
			['#다른 수정', [reference]],
			['#대상 수정', [{ ...reference, start: 50 }]],
			['#대상 수정', [{ ...reference, channelId: foreign.id }]],
			['#대상 #대상', [reference, { ...reference, start: 4 }]],
		] as const) {
			const rejected = await api('chat/messages/update', { messageId: created.body.id, text, channelRefs: [...channelRefs] }, member);
			expect(rejected.status).toBe(400);
		}

		const updated = await api('chat/messages/update', { messageId: created.body.id, text: '새 글 #대상 수정', channelRefs: [{ ...reference, start: 4 }] }, member);
		expect(updated.status, JSON.stringify(updated.body)).toBe(200);
		expect(updated.body.channelRefs).toEqual([{ ...reference, start: 4 }]);
		const stored = await api('chat/messages/show', { messageId: created.body.id }, member);
		expect(stored.body).toMatchObject({ text: '새 글 #대상 수정', channelRefs: [{ ...reference, start: 4 }] });
	});

	test('비멤버 모더레이터는 일반 그룹과 채널형 그룹을 읽되 쓰거나 설정할 수 없다', async () => {
		const moderator = await signup({ username: 'channelmoderator' });
		const modRole = await role(owner, { name: 'Channel moderator', isModerator: true });
		expect((await api('admin/roles/assign', { roleId: modRole.id, userId: moderator.id }, owner)).status).toBe(204);
		const plain = await createRoom(false);
		const plainMessage = await send(plain, undefined, '일반 그룹 내용', owner);
		const channelRoom = await createRoom(false);
		const general = await convert(channelRoom);
		const channelMessage = await send(channelRoom, general.id, '채널 그룹 내용', owner);

		for (const [roomId, messageId, channelId] of [[plain, plainMessage.id, undefined], [channelRoom, channelMessage.id, general.id]] as const) {
			expect((await api('chat/rooms/show', { roomId }, moderator)).status).toBe(200);
			const timeline = await api('chat/messages/room-timeline', { roomId, ...(channelId ? { channelId } : {}) }, moderator);
			expect(timeline.status).toBe(200);
			expect(timeline.body.some(message => message.id === messageId)).toBe(true);
			expect((await api('chat/messages/create-to-room', { toRoomId: roomId, ...(channelId ? { toRoomChannelId: channelId } : {}), text: '거부' }, moderator)).status).toBe(400);
			expect((await api('chat/rooms/update', { roomId, name: '거부' }, moderator)).status).toBe(400);
		}
		expect((await api('chat/rooms/channels/list', { roomId: channelRoom }, moderator)).status).toBe(200);
		expect((await api('chat/rooms/channels/create', { roomId: channelRoom, name: '거부' }, moderator)).status).toBe(400);
		expect((await api('chat/rooms/channels/list', { roomId: channelRoom }, outsider)).status).toBe(400);
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

	async function createSection(roomId: string, name = '묶음') {
		const response = await api('chat/rooms/sections/create', { roomId, name }, owner);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body;
	}

	async function listSections(roomId: string, user: UserToken = owner) {
		const response = await api('chat/rooms/sections/list', { roomId }, user);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body;
	}

	async function listChannels(roomId: string, user: UserToken = owner) {
		const response = await api('chat/rooms/channels/list', { roomId }, user);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body;
	}

	async function arrange(roomId: string, ungrouped: string[], sections: { sectionId: string; channelIds: string[] }[], user: UserToken = owner) {
		return await api('chat/rooms/channels/arrange', { roomId, ungrouped, sections }, user);
	}

	test('섹션 만들기·이름 바꾸기·삭제는 그룹장만 하고 목록은 멤버가 읽는다', async () => {
		const roomId = await createRoom();
		await convert(roomId);
		expect((await api('chat/rooms/sections/create', { roomId, name: '거부' }, member)).status).toBe(400);
		expect((await api('chat/rooms/sections/create', { roomId, name: '거부' }, outsider)).status).toBe(400);

		const section = await createSection(roomId, '운영');
		expect(section).toMatchObject({ roomId, name: '운영' });
		expect((await listSections(roomId, member)).map(item => item.id)).toEqual([section.id]);
		expect((await api('chat/rooms/sections/list', { roomId }, outsider)).status).toBe(400);

		expect((await api('chat/rooms/sections/update', { sectionId: section.id, name: '거부' }, member)).status).toBe(400);
		const renamed = await api('chat/rooms/sections/update', { sectionId: section.id, name: '관리' }, owner);
		expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
		expect(renamed.body.name).toBe('관리');

		expect((await api('chat/rooms/sections/delete', { sectionId: section.id }, member)).status).toBe(400);
		expect((await api('chat/rooms/sections/delete', { sectionId: section.id }, owner)).status).toBe(204);
		expect(await listSections(roomId)).toEqual([]);
	});

	test('전환하지 않은 그룹은 섹션 만들기를 거부하고 섹션 목록은 비어 있다', async () => {
		const roomId = await createRoom(false);
		expect((await api('chat/rooms/sections/create', { roomId, name: '거부' }, owner)).status).toBe(400);
		expect(await listSections(roomId)).toEqual([]);
	});

	test('섹션 이름은 채널과 같은 규칙이고 그룹당 128개까지 둔다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		const first = await createSection(roomId, '  A #한글 / 😀  ');
		const second = await createSection(roomId, 'A #한글 / 😀');
		const max = await createSection(roomId, '😀'.repeat(128));

		expect(first.name).toBe('A #한글 / 😀');
		expect(first.id).not.toBe(second.id);
		expect(Array.from(max.name)).toHaveLength(128);
		expect((await api('chat/rooms/sections/create', { roomId, name: '가'.repeat(129) }, owner)).status).toBe(400);
		expect((await api('chat/rooms/sections/create', { roomId, name: '   ' }, owner)).status).toBe(400);
		expect((await api('chat/rooms/sections/update', { sectionId: first.id, name: '가'.repeat(129) }, owner)).status).toBe(400);

		for (let i = 0; i < 125; i++) await createSection(roomId, `묶음 ${i}`);
		expect((await api('chat/rooms/sections/create', { roomId, name: '한도 초과' }, owner)).status).toBe(400);
		expect(await listSections(roomId)).toHaveLength(128);
	});

	test('섹션 이름에 NUL 문자가 있으면 만들기와 이름 바꾸기를 거부한다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		const section = await createSection(roomId, '묶음');

		for (const name of ['\u0000', '묶\u0000음', '묶음\u0000']) {
			const created = await api('chat/rooms/sections/create', { roomId, name }, owner);
			expect(created.status).toBe(400);
			expect((created.body as unknown as { error: { code: string } }).error.code).toBe('INVALID_SECTION_NAME');
			const updated = await api('chat/rooms/sections/update', { sectionId: section.id, name }, owner);
			expect(updated.status).toBe(400);
			expect((updated.body as unknown as { error: { code: string } }).error.code).toBe('INVALID_SECTION_NAME');
		}

		expect((await listSections(roomId)).map(item => item.name)).toEqual(['묶음']);
	});

	test('섹션 이름에 짝 없는 surrogate가 있으면 만들기와 이름 바꾸기를 거부한다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		const section = await createSection(roomId, '묶음');

		for (const name of ['묶\ud800음', '\udc00', '묶음\ud800']) {
			const created = await api('chat/rooms/sections/create', { roomId, name }, owner);
			expect(created.status).toBe(400);
			expect((created.body as unknown as { error: { code: string } }).error.code).toBe('INVALID_SECTION_NAME');
			const updated = await api('chat/rooms/sections/update', { sectionId: section.id, name }, owner);
			expect(updated.status).toBe(400);
			expect((updated.body as unknown as { error: { code: string } }).error.code).toBe('INVALID_SECTION_NAME');
		}

		expect((await listSections(roomId)).map(item => item.name)).toEqual(['묶음']);
	});

	test('채널 목록은 섹션 소속을 싣고 새 채널은 만드는 곳의 맨 아래에 온다', async () => {
		const roomId = await createRoom(false);
		const general = await convert(roomId);
		const section = await createSection(roomId);
		const loose = await createChannel(roomId, '자유');
		const inside = await api('chat/rooms/channels/create', { roomId, name: '소속', sectionId: section.id }, owner);
		expect(inside.status, JSON.stringify(inside.body)).toBe(200);
		const insideSecond = await api('chat/rooms/channels/create', { roomId, name: '소속 둘째', sectionId: section.id }, owner);
		expect(insideSecond.status).toBe(200);
		const looseSecond = await createChannel(roomId, '자유 둘째');

		const channels = await listChannels(roomId);
		expect(channels.map(channel => channel.id)).toEqual([general.id, loose.id, looseSecond.id, inside.body.id, insideSecond.body.id]);
		expect(channels.map(channel => channel.sectionId)).toEqual([null, null, null, section.id, section.id]);
		expect((await api('chat/rooms/channels/create', { roomId, name: '거부', sectionId: general.id }, owner)).status).toBe(400);
	});

	test('arrange는 섹션 순서와 소속·채널 순서를 한 번에 바꾸고 전체를 정확히 한 번씩 요구한다', async () => {
		const roomId = await createRoom(false);
		const general = await convert(roomId);
		const a = await createChannel(roomId, '가');
		const b = await createChannel(roomId, '나');
		const c = await createChannel(roomId, '다');
		const d = await createChannel(roomId, '라');
		const s1 = await createSection(roomId, '첫째');
		const s2 = await createSection(roomId, '둘째');

		expect((await arrange(roomId, [general.id, a.id], [{ sectionId: s2.id, channelIds: [b.id] }, { sectionId: s1.id, channelIds: [c.id, d.id] }], member)).status).toBe(400);
		for (const [ungrouped, sections] of [
			[[general.id, a.id], [{ sectionId: s2.id, channelIds: [b.id] }, { sectionId: s1.id, channelIds: [c.id] }]],
			[[general.id, a.id, a.id], [{ sectionId: s2.id, channelIds: [b.id] }, { sectionId: s1.id, channelIds: [c.id, d.id] }]],
			[[general.id, a.id], [{ sectionId: s2.id, channelIds: [b.id, b.id] }, { sectionId: s1.id, channelIds: [c.id, d.id] }]],
			[[general.id, a.id], [{ sectionId: s2.id, channelIds: [b.id] }, { sectionId: s1.id, channelIds: [c.id, d.id] }, { sectionId: s1.id, channelIds: [] }]],
			[[general.id, a.id], [{ sectionId: s2.id, channelIds: [b.id] }]],
			[[general.id, a.id, b.id], [{ sectionId: s2.id, channelIds: [b.id] }, { sectionId: s1.id, channelIds: [c.id, d.id] }]],
		] as const) {
			const rejected = await arrange(roomId, [...ungrouped], sections.map(item => ({ ...item, channelIds: [...item.channelIds] })));
			expect(rejected.status).toBe(400);
			expect((rejected.body as unknown as { error: { code: string } }).error.code).toBe('INVALID_CHANNEL_ORDER');
		}

		const arranged = await arrange(roomId, [general.id, a.id], [{ sectionId: s2.id, channelIds: [b.id] }, { sectionId: s1.id, channelIds: [c.id, d.id] }]);
		expect(arranged.status, JSON.stringify(arranged.body)).toBe(200);
		expect(arranged.body.map(channel => channel.id)).toEqual([general.id, a.id, b.id, c.id, d.id]);
		expect(arranged.body.map(channel => channel.sectionId)).toEqual([null, null, s2.id, s1.id, s1.id]);
		expect((await listSections(roomId)).map(section => section.id)).toEqual([s2.id, s1.id]);
		expect((await listChannels(roomId)).map(channel => channel.id)).toEqual([general.id, a.id, b.id, c.id, d.id]);
	});

	test('섹션을 모르는 순서 바꾸기는 소속을 유지한 채 소속별 상대 순서만 적용한다', async () => {
		const roomId = await createRoom(false);
		const general = await convert(roomId);
		const a = await createChannel(roomId, '가');
		const b = await createChannel(roomId, '나');
		const c = await createChannel(roomId, '다');
		const s1 = await createSection(roomId, '첫째');
		const s2 = await createSection(roomId, '둘째');
		const arranged = await arrange(roomId, [general.id, a.id], [{ sectionId: s1.id, channelIds: [b.id] }, { sectionId: s2.id, channelIds: [c.id] }]);
		expect(arranged.status, JSON.stringify(arranged.body)).toBe(200);

		const reordered = await api('chat/rooms/channels/reorder', { roomId, channelIds: [a.id, general.id, c.id, b.id] }, owner);
		expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
		expect(reordered.body.map(channel => channel.id)).toEqual([a.id, general.id, b.id, c.id]);
		expect(reordered.body.map(channel => channel.sectionId)).toEqual([null, null, s1.id, s2.id]);
		expect((await listSections(roomId)).map(section => section.id)).toEqual([s1.id, s2.id]);
	});

	test('섹션을 지우면 안의 채널은 섹션 없는 채널 묶음의 맨 아래로 남는다', async () => {
		const roomId = await createRoom(false);
		const general = await convert(roomId);
		const a = await createChannel(roomId, '가');
		const b = await createChannel(roomId, '나');
		const c = await createChannel(roomId, '다');
		const s1 = await createSection(roomId, '첫째');
		const s2 = await createSection(roomId, '둘째');
		const arranged = await arrange(roomId, [general.id, a.id], [{ sectionId: s1.id, channelIds: [b.id] }, { sectionId: s2.id, channelIds: [c.id] }]);
		expect(arranged.status, JSON.stringify(arranged.body)).toBe(200);

		expect((await api('chat/rooms/sections/delete', { sectionId: s1.id }, owner)).status).toBe(204);

		const channels = await listChannels(roomId);
		expect(channels.map(channel => channel.id)).toEqual([general.id, a.id, b.id, c.id]);
		expect(channels.map(channel => channel.sectionId)).toEqual([null, null, null, s2.id]);
		expect((await listSections(roomId)).map(section => section.id)).toEqual([s2.id]);
	});

	test('채널을 삭제해도 섹션은 남고 빈 섹션을 허용한다', async () => {
		const roomId = await createRoom(false);
		const general = await convert(roomId);
		const target = await createChannel(roomId, '대상');
		const section = await createSection(roomId);
		const arranged = await arrange(roomId, [general.id], [{ sectionId: section.id, channelIds: [target.id] }]);
		expect(arranged.status, JSON.stringify(arranged.body)).toBe(200);
		expect((await listChannels(roomId)).find(channel => channel.id === target.id)?.sectionId).toBe(section.id);
		const empty = await createSection(roomId, '빈 묶음');

		expect((await api('chat/rooms/channels/delete', { channelId: target.id }, owner)).status).toBe(204);

		expect((await listSections(roomId)).map(section => section.id)).toEqual([section.id, empty.id]);
		expect((await listChannels(roomId)).every(channel => channel.sectionId == null)).toBe(true);
	});

	test('보관된 그룹은 섹션 구성과 배치를 변경하지 않는다', async () => {
		const roomId = await createRoom();
		const general = await convert(roomId);
		const section = await createSection(roomId);
		expect((await api('chat/rooms/update', { roomId, isArchived: true }, owner)).status).toBe(200);

		expect((await api('chat/rooms/sections/create', { roomId, name: '거부' }, owner)).status).toBe(400);
		expect((await api('chat/rooms/sections/update', { sectionId: section.id, name: '거부' }, owner)).status).toBe(400);
		expect((await api('chat/rooms/sections/delete', { sectionId: section.id }, owner)).status).toBe(400);
		expect((await arrange(roomId, [general.id], [{ sectionId: section.id, channelIds: [] }])).status).toBe(400);
		expect((await api('chat/rooms/channels/create', { roomId, name: '거부', sectionId: section.id }, owner)).status).toBe(400);
		expect((await listSections(roomId)).map(item => item.id)).toEqual([section.id]);
	});

	test('그룹장이 아니면 섹션을 바꿀 수 없고 다른 그룹의 섹션에는 채널을 넣을 수 없다', async () => {
		const roomId = await createRoom(false);
		await convert(roomId);
		const otherRoom = await createRoom(false);
		await convert(otherRoom);
		const foreign = await createSection(otherRoom);

		expect((await api('chat/rooms/sections/update', { sectionId: foreign.id, name: '거부' }, outsider)).status).toBe(400);
		expect((await api('chat/rooms/sections/delete', { sectionId: foreign.id }, outsider)).status).toBe(400);
		expect((await api('chat/rooms/channels/create', { roomId, name: '거부', sectionId: foreign.id }, owner)).status).toBe(400);
		const general = (await listChannels(roomId))[0];
		expect((await arrange(roomId, [general.id], [{ sectionId: foreign.id, channelIds: [] }])).status).toBe(400);
	});

	test('섹션 변경도 channelsUpdated 이벤트로 알린다', async () => {
		const roomId = await createRoom();
		await convert(roomId);
		let finish!: () => void;
		const barrier = new Promise<void>(resolve => { finish = resolve; });
		const socket = await connectStream(owner, 'chatRoom', event => {
			if (event.type === 'channelsUpdated' && event.body.roomId === roomId) finish();
		}, { roomId });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await createSection(roomId, '알림');
			await Promise.race([barrier, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stream barrier timed out')), 10000); })]);
		} finally {
			if (timer != null) clearTimeout(timer);
			socket.close();
		}
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
