/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { api, castAsError, connectStream, role, signup, startJobQueue, uploadFile } from '../utils.js';
import type { UserToken } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

describe('그룹 아이콘 API', () => {
	let admin: Awaited<ReturnType<typeof signup>>;
	let owner: Awaited<ReturnType<typeof signup>>;
	let member: Awaited<ReturnType<typeof signup>>;
	let queue: Awaited<ReturnType<typeof startJobQueue>>;

	beforeAll(async () => {
		// 시험 모드의 새 Nest DB 연결은 스키마를 다시 만든다. 계정과 방을 만든 뒤 시작하지 않는다.
		queue = await startJobQueue();
		admin = await signup({ username: 'iconsadmin' });
		owner = await signup({ username: 'iconsowner' });
		member = await signup({ username: 'iconsmember' });
	}, 120_000);

	afterAll(async () => {
		try {
			if (admin != null) await waitForChatNotificationTurn();
		} finally {
			await queue?.close();
		}
	}, 30_000);

	async function image(user: UserToken) {
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGN49uHXf0owwzA0QK74Dl48asDIMGDgUyLdDQAAHih2brHx0sgAAAAASUVORK5CYII=', 'base64');
		const response = await uploadFile(user, { name: 'square.png', blob: new Blob([Uint8Array.from(png)], { type: 'image/png' }) });
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body!;
	}

	async function createRoom(channels: boolean) {
		const created = await api('chat/rooms/create', { name: '아이콘 시험' }, owner);
		expect(created.status).toBe(200);
		const roomId = created.body.id;
		if (channels) expect((await api('chat/rooms/convert-to-channels', { roomId }, owner)).status).toBe(200);
		expect((await api('chat/rooms/invitations/create', { roomId, userId: member.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, member)).status).toBe(204);
		return roomId;
	}

	test.each([false, true])('일반·채널형 그룹의 아이콘 설정·변경·해제는 그룹장만 한다 (채널: %s)', async channels => {
		const roomId = await createRoom(channels);
		const first = await image(owner);
		const second = await image(owner);

		expect(castAsError((await api('chat/rooms/update', { roomId, iconId: first.id }, member)).body).error.code).toBe('NO_SUCH_ROOM');
		const set = await api('chat/rooms/update', { roomId, iconId: first.id }, owner);
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body).toMatchObject({ iconId: first.id, iconDecorations: [] });
		expect(set.body.iconUrl).not.toContain('/identicon/');
		const changed = await api('chat/rooms/update', { roomId, iconId: second.id }, owner);
		expect(changed.body.iconId).toBe(second.id);
		const shown = await api('chat/rooms/show', { roomId }, member);
		expect(shown.body.iconUrl).toBe(changed.body.iconUrl);
		const detached = await api('chat/rooms/update', { roomId, iconId: null }, owner);
		expect(detached.body.iconId).toBeNull();
		expect(detached.body.iconUrl).toContain('/identicon/');
	});

	test('그룹장은 본인의 민감하지 않은 이미지 파일만 선택한다', async () => {
		const roomId = await createRoom(false);
		const foreign = await image(member);
		const sensitive = await image(owner);
		expect((await api('drive/files/update', { fileId: sensitive.id, isSensitive: true }, owner)).status).toBe(200);
		const text = await uploadFile(owner, { name: 'text.txt', blob: new Blob(['square'], { type: 'text/plain' }) });

		expect(castAsError((await api('chat/rooms/update', { roomId, iconId: foreign.id }, owner)).body).error.code).toBe('NO_SUCH_AVATAR');
		expect(castAsError((await api('chat/rooms/update', { roomId, iconId: sensitive.id }, owner)).body).error.code).toBe('AVATAR_IS_SENSITIVE');
		expect(castAsError((await api('chat/rooms/update', { roomId, iconId: text.body!.id }, owner)).body).error.code).toBe('AVATAR_NOT_AN_IMAGE');
	});

	test.each([false, true])('보관 중 설정·해제·장식 변경과 같은 요청의 보관 해제를 거부한다 (채널: %s)', async channels => {
		const roomId = await createRoom(channels);
		expect((await api('chat/rooms/update', { roomId, isArchived: true }, owner)).status).toBe(200);

		for (const update of [{ iconId: null }, { iconDecorations: [] }, { isArchived: false, iconId: null }]) {
			const response = await api('chat/rooms/update', { roomId, ...update }, owner);
			expect(castAsError(response.body).error.code).toBe('ROOM_IS_ARCHIVED');
		}
	});

	test('사용 중인 그룹 아이콘은 미사용 정리에서 보호되고 파일 삭제 뒤 기본 그림을 제공한다', async () => {
		const roomId = await createRoom(false);
		const file = await image(owner);
		expect((await api('chat/rooms/update', { roomId, iconId: file.id }, owner)).status).toBe(200);

		const unused = await api('drive/files/unused', { limit: 100 }, owner);
		expect(unused.body.some(item => item.id === file.id)).toBe(false);
		let observed!: (body: Record<string, unknown>) => void;
		const changed = new Promise<Record<string, unknown>>(resolve => { observed = resolve; });
		const socket = await connectStream(member, 'chatRoom', event => {
			if (event.type === 'roomUpdated' && event.body.iconId === null) observed(event.body);
		}, { roomId });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			expect((await api('drive/files/delete', { fileId: file.id }, owner)).status).toBe(204);
			const event = await Promise.race([changed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('icon reset stream timed out')), 15000); })]);
			expect(event.iconUrl).toContain('/identicon/');
			const shown = await api('chat/rooms/show', { roomId }, member);
			expect(shown.body).toMatchObject({ iconId: null, iconBlurhash: null });
			expect(shown.body.iconUrl).toBe(event.iconUrl);
		} finally {
			if (timer != null) clearTimeout(timer);
			socket.close();
		}
	});

	test('장식의 역할 자격과 개수는 그룹장 기준이며 프로필 장식은 바뀌지 않는다', async () => {
		const roomId = await createRoom(false);
		const restricted = await role(admin, { name: '장식 사용' }, { avatarDecorationLimit: { useDefault: false, priority: 10, value: 1 } });
		expect((await api('admin/roles/assign', { roleId: restricted.id, userId: owner.id }, admin)).status).toBe(204);
		const artwork = await image(admin);
		const decoration = await api('admin/avatar-decorations/create', { name: '도형', description: '', url: artwork.url, roleIdsThatCanBeUsedThisDecoration: [restricted.id] }, admin);
		expect(decoration.status, JSON.stringify(decoration.body)).toBe(200);
		const choice = { id: decoration.body.id, angle: 0.2, flipH: true, offsetX: 0.1, scale: 1.2, opacity: 0.5 };

		const updated = await api('chat/rooms/update', { roomId, iconDecorations: [choice] }, owner);
		expect(updated.body.iconDecorations).toMatchObject([choice]);
		const self = await api('i', {}, owner);
		expect(self.body.avatarDecorations).toEqual([]);
		expect(castAsError((await api('chat/rooms/update', { roomId, iconDecorations: [choice, choice] }, owner)).body).error.code).toBe('RESTRICTED_BY_ROLE');
		expect(castAsError((await api('chat/rooms/update', { roomId, iconDecorations: [] }, member)).body).error.code).toBe('NO_SUCH_ROOM');
		expect((await api('chat/rooms/update', { roomId, iconDecorations: [] }, owner)).body.iconDecorations).toEqual([]);
	});
});
