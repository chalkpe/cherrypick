/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'node-html-parser';
import { api, castAsError, origin, relativeFetch, signup, uploadFile } from '../utils.js';
import type { UserToken } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

// 실패 응답의 오류 코드. 성공 응답 타입으로 추론된 body에서 오류를 꺼낸다
function errorCode(response: { body: unknown }): string {
	return castAsError(response.body as Record<string, unknown>).error.code;
}

describe('그룹 초대 링크', () => {
	let owner: Awaited<ReturnType<typeof signup>>;
	let member: Awaited<ReturnType<typeof signup>>;
	let outsider: Awaited<ReturnType<typeof signup>>;

	beforeAll(async () => {
		// 파일마다 새 DB라 첫 가입자인 그룹장이 관리자다(장식 등록에 쓴다). 연합 기본값은 none이므로 서버 간 미리보기를 보려면 연합을 연다
		owner = await signup({ username: 'inviteowner' });
		expect((await api('admin/update-meta', { federation: 'all' }, owner)).status).toBe(204);
		member = await signup({ username: 'invitemember' });
		outsider = await signup({ username: 'inviteoutsider' });
	}, 60_000);

	afterAll(waitForChatNotificationTurn, 30_000);

	async function createRoom(options: { channels?: boolean; description?: string } = {}) {
		const created = await api('chat/rooms/create', { name: `초대 시험 ${Math.random()}`, description: options.description ?? '' }, owner);
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		if (options.channels) expect((await api('chat/rooms/convert-to-channels', { roomId: created.body.id }, owner)).status).toBe(200);
		return created.body;
	}

	async function createLink(roomId: string) {
		const response = await api('chat/rooms/invite-link/create', { roomId }, owner);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return response.body;
	}

	async function join(url: string, user: UserToken) {
		return await api('chat/invite-link/join', { url }, user);
	}

	async function memberIds(roomId: string): Promise<string[]> {
		const members = await api('chat/rooms/members', { roomId, limit: 100 }, owner);
		expect(members.status, JSON.stringify(members.body)).toBe(200);
		return members.body.map(membership => membership.userId);
	}

	describe('그룹장의 발급·조회·폐기', () => {
		test('그룹장만 활성 링크 하나를 다루고, 있을 때는 새로 발급하지 않는다', async () => {
			const room = await createRoom();
			expect((await api('chat/rooms/invite-link/show', { roomId: room.id }, owner)).body).toBeNull();

			const link = await createLink(room.id);
			const duplicate = await api('chat/rooms/invite-link/create', { roomId: room.id }, owner);
			const shown = await api('chat/rooms/invite-link/show', { roomId: room.id }, owner);

			expect(link.url).toBe(`${origin}/chat/invite/${link.code}`);
			expect(link.code).toMatch(/^[0-9A-Za-z]{16}$/);
			expect(duplicate.status).toBe(400);
			expect(errorCode(duplicate)).toBe('INVITE_LINK_ALREADY_EXISTS');
			expect(shown.body).toEqual(link);
			for (const user of [member, outsider]) {
				expect(errorCode(await api('chat/rooms/invite-link/show', { roomId: room.id }, user))).toBe('NO_SUCH_ROOM');
				expect(errorCode(await api('chat/rooms/invite-link/create', { roomId: room.id }, user))).toBe('NO_SUCH_ROOM');
				expect(errorCode(await api('chat/rooms/invite-link/revoke', { roomId: room.id }, user))).toBe('NO_SUCH_ROOM');
			}
		});

		test('폐기하면 그 코드는 없는 주소가 되고 다시 발급하면 새 코드다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);

			expect((await api('chat/rooms/invite-link/revoke', { roomId: room.id }, owner)).status).toBe(204);
			const missing = await api('chat/rooms/invite-link/revoke', { roomId: room.id }, owner);
			const renewed = await createLink(room.id);

			expect(errorCode(missing)).toBe('NO_SUCH_INVITE_LINK');
			expect(renewed.code).not.toBe(link.code);
			expect(errorCode(await api('chat/invite-link/show', { code: link.code }))).toBe('NO_SUCH_INVITE_LINK');
			expect(errorCode(await join(link.url, member))).toBe('NO_SUCH_INVITE_LINK');
			expect((await join(renewed.url, member)).status).toBe(200);
		});

		test('보관된 그룹은 링크를 바꿀 수 없고 유효한 링크로도 참여할 수 없다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);
			expect((await api('chat/rooms/update', { roomId: room.id, isArchived: true }, owner)).status).toBe(200);

			expect(errorCode(await api('chat/rooms/invite-link/revoke', { roomId: room.id }, owner))).toBe('ROOM_IS_ARCHIVED');
			expect((await api('chat/rooms/invite-link/show', { roomId: room.id }, owner)).body).toEqual(link);
			expect(errorCode(await join(link.url, outsider))).toBe('ROOM_IS_ARCHIVED');
			expect(await memberIds(room.id)).toEqual([]);

			expect((await api('chat/rooms/update', { roomId: room.id, isArchived: false }, owner)).status).toBe(200);
			expect((await api('chat/rooms/invite-link/revoke', { roomId: room.id }, owner)).status).toBe(204);
			expect((await api('chat/rooms/update', { roomId: room.id, isArchived: true }, owner)).status).toBe(200);
			expect(errorCode(await api('chat/rooms/invite-link/create', { roomId: room.id }, owner))).toBe('ROOM_IS_ARCHIVED');
		});
	});

	describe('미리보기는 공개 범위만 보이고 가입시키지 않는다', () => {
		test.each([false, true])('실제 그룹 아이콘과 장식은 공개 API·카드·OG에 같은 데이터로 연결된다 (채널: %s)', async channels => {
			const room = await createRoom({ channels });
			const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGN49uHXf0owwzA0QK74Dl48asDIMGDgUyLdDQAAHih2brHx0sgAAAAASUVORK5CYII=', 'base64');
			const uploaded = await uploadFile(owner, { name: 'invite-square.png', blob: new Blob([Uint8Array.from(png)], { type: 'image/png' }) });
			expect(uploaded.status).toBe(200);
			const decoration = await api('admin/avatar-decorations/create', { name: '도형', description: '', url: uploaded.body!.url }, owner);
			expect(decoration.status).toBe(200);
			const choice = { id: decoration.body.id, angle: 0.1, scale: 1.2 };
			const updated = await api('chat/rooms/update', { roomId: room.id, iconId: uploaded.body!.id, iconDecorations: [choice] }, owner);
			expect(updated.status).toBe(200);
			const link = await createLink(room.id);

			const preview = await api('chat/invite-link/show', { code: link.code });
			const card = await relativeFetch(`url?url=${encodeURIComponent(link.url)}&lang=ko-KR`);
			const summary = await card.json() as Record<string, any>;
			const html = await relativeFetch(`chat/invite/${link.code}`, { headers: { Accept: 'text/html' } });
			const document = parse(await html.text());

			expect(preview.status).toBe(200);
			expect(preview.body).toMatchObject({ iconUrl: updated.body.iconUrl, iconBlurhash: updated.body.iconBlurhash, iconDecorations: updated.body.iconDecorations });
			expect(summary.chatInvite.iconUrl).toBe(updated.body.iconUrl);
			expect(summary.chatInvite.iconDecorations).toEqual(updated.body.iconDecorations);
			expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(updated.body.iconUrl);
			expect(await memberIds(room.id)).toEqual([]);
			expect((await api('chat/rooms/invitations/outbox', { roomId: room.id }, owner)).body).toEqual([]);
		});

		test('로그인 없이 이름·설명·멤버 수만 주고, 멤버에게만 그룹을 알려 준다', async () => {
			const room = await createRoom({ description: '설명' });
			const link = await createLink(room.id);
			expect((await join(link.url, member)).status).toBe(200);

			const anonymous = await api('chat/invite-link/show', { code: link.code });
			const asMember = await api('chat/invite-link/show', { code: link.code }, member);
			const asOutsider = await api('chat/invite-link/show', { code: link.code }, outsider);

			expect(anonymous.body).toEqual({ name: room.name, description: '설명', membersCount: 2, joinedRoomId: null, iconUrl: room.iconUrl, iconBlurhash: room.iconBlurhash, iconDecorations: room.iconDecorations });
			expect(asMember.body.joinedRoomId).toBe(room.id);
			expect(asOutsider.body.joinedRoomId).toBeNull();
			expect(errorCode(await api('chat/invite-link/show', { code: 'nosuchcode0000' }))).toBe('NO_SUCH_INVITE_LINK');
		});

		test('HTML·서버 간 문서·링크 카드·공개 미리보기를 여러 번 열어도 멤버십과 초대장이 생기지 않는다', async () => {
			const room = await createRoom({ description: '설명' });
			const link = await createLink(room.id);

			const html = await relativeFetch(`chat/invite/${link.code}`, { headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR' } });
			const ap = await relativeFetch(`chat/invite/${link.code}`, { headers: { Accept: 'application/activity+json' } });
			const card = await relativeFetch(`url?url=${encodeURIComponent(link.url)}&lang=ko-KR`);
			const missing = await relativeFetch('chat/invite/nosuchcode0000', { headers: { Accept: 'application/activity+json' } });
			await api('chat/invite-link/show', { code: link.code }, outsider);
			const htmlBody = await html.text();
			const doc = await ap.json() as Record<string, any>;
			const summary = await card.json() as Record<string, any>;

			expect(html.status).toBe(200);
			expect(htmlBody).toContain(`<meta property="og:title" content="${room.name}"`);
			expect(htmlBody).toContain('<meta name="robots" content="noindex"');
			expect(htmlBody).toContain('1 사용자');
			expect(parse(htmlBody).querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(room.iconUrl);
			expect(html.headers.get('vary')).toContain('Accept-Language');
			expect(ap.status).toBe(200);
			expect(ap.headers.get('cache-control')).toBe('private, no-store');
			expect(doc).toMatchObject({ id: link.url, type: 'Invite', endpoints: { sharedInbox: `${origin}/inbox` } });
			expect(Object.keys(doc.object).sort()).toEqual(['_misskey_chatArchived', '_misskey_chatIconDecorations', '_misskey_chatRoomMembersCount', 'icon', 'id', 'name', 'summary', 'type']);
			expect(doc.object.icon).toEqual({ type: 'Image', url: room.iconUrl });
			expect(doc.object._misskey_chatIconDecorations).toEqual(room.iconDecorations);
			expect(JSON.stringify(doc)).not.toContain(owner.id);
			expect(missing.status).toBe(404);
			expect(card.status).toBe(200);
			expect(card.headers.get('cache-control')).toBe('max-age=86400, immutable');
			expect(summary.chatInvite).toEqual({ url: link.url, host: new URL(origin).host, code: link.code, name: room.name, description: '설명', membersCount: 1, isLocal: true, iconUrl: room.iconUrl, iconBlurhash: room.iconBlurhash, iconDecorations: room.iconDecorations });
			expect(await memberIds(room.id)).toEqual([]);
			expect((await api('chat/rooms/invitations/outbox', { roomId: room.id }, owner)).body).toEqual([]);
		});
	});

	describe('같은 서버 계정의 참여', () => {
		test.each([
			['일반 그룹', false],
			['채널형 그룹', true],
		])('%s: 추가 승인 없이 바로 멤버가 되고 참여 전 기록을 본다', async (_, channels) => {
			const room = await createRoom({ channels });
			const before = await api('chat/messages/create-to-room', { toRoomId: room.id, text: '참여 전 기록' }, owner);
			const link = await createLink(room.id);

			const joined = await join(link.url, outsider);
			const timeline = await api('chat/messages/room-timeline', { roomId: room.id }, outsider);

			expect(joined.body).toEqual({ status: 'joined', roomId: room.id });
			expect(await memberIds(room.id)).toEqual([outsider.id]);
			expect(timeline.status).toBe(200);
			expect(timeline.body.map(message => message.id)).toContain(before.body.id);
			expect((await api('chat/invite-link/join-status', { url: link.url }, outsider)).body).toEqual({ status: 'joined', roomId: room.id, reason: null });
			expect((await api('chat/rooms/leave', { roomId: room.id }, outsider)).status).toBe(204);
		});

		test('여러 번 눌러도 멤버십은 하나고, 그룹장이 눌러도 그 그룹을 연다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);

			const results = await Promise.all([join(link.url, member), join(link.url, member), join(link.url, owner)]);

			expect(results.map(result => result.body)).toEqual([
				{ status: 'joined', roomId: room.id },
				{ status: 'joined', roomId: room.id },
				{ status: 'joined', roomId: room.id },
			]);
			expect(await memberIds(room.id)).toEqual([member.id]);
		});

		test('스스로 나간 사람은 같은 링크로 다시 참여한다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);
			expect((await join(link.url, member)).status).toBe(200);
			expect((await api('chat/rooms/leave', { roomId: room.id }, member)).status).toBe(204);

			expect((await join(link.url, member)).body).toEqual({ status: 'joined', roomId: room.id });
			expect(await memberIds(room.id)).toEqual([member.id]);
		});

		test('그룹장이 차단한 계정은 차단 사유로 거절하고, 참여하려는 사람이 그룹장을 차단한 것은 막지 않는다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);
			const [blockedByOwner, blocksOwner] = await Promise.all([signup(), signup()]);
			expect((await api('blocking/create', { userId: blockedByOwner.id }, owner)).status).toBe(200);
			expect((await api('blocking/create', { userId: owner.id }, blocksOwner)).status).toBe(200);

			const refused = await join(link.url, blockedByOwner);
			const allowed = await join(link.url, blocksOwner);

			expect(errorCode(refused)).toBe('BLOCKED_BY_ROOM_OWNER');
			expect(allowed.body).toEqual({ status: 'joined', roomId: room.id });
			expect(await memberIds(room.id)).toEqual([blocksOwner.id]);
		});

		test.each([
			['일반 그룹', false],
			['채널형 그룹', true],
		])('%s: 그룹장이 내보낸 계정은 사면 전까지 유효한 링크로도 다시 참여하지 못하고, 사면 뒤에는 참여한다', async (_, channels) => {
			const room = await createRoom({ channels });
			const link = await createLink(room.id);
			const removed = await signup();
			expect((await join(link.url, removed)).body).toEqual({ status: 'joined', roomId: room.id });
			expect((await api('chat/rooms/kick', { roomId: room.id, userId: removed.id }, owner)).status).toBe(204);

			const refused = await join(link.url, removed);

			expect(refused.body).toMatchObject({ error: { code: 'BANNED_FROM_ROOM' } });
			expect(await memberIds(room.id)).toEqual([]);

			expect((await api('chat/rooms/bans/delete', { roomId: room.id, userId: removed.id }, owner)).status).toBe(204);
			expect((await join(link.url, removed)).body).toEqual({ status: 'joined', roomId: room.id });
			expect(await memberIds(room.id)).toEqual([removed.id]);
		});

		test('받아 둔 개별 초대는 링크 참여로 정리된다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);
			const invitee = await signup();
			expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: invitee.id }, owner)).status).toBe(200);

			expect((await join(link.url, invitee)).body).toEqual({ status: 'joined', roomId: room.id });

			expect((await api('chat/rooms/invitations/inbox', {}, invitee)).body).toEqual([]);
			expect((await api('chat/rooms/invitations/outbox', { roomId: room.id }, owner)).body).toEqual([]);
			expect(await memberIds(room.id)).toEqual([invitee.id]);
		});

		test('개별 초대와 수락은 링크가 있어도 그대로 동작한다', async () => {
			const room = await createRoom();
			await createLink(room.id);
			const invitee = await signup();

			expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: invitee.id }, owner)).status).toBe(200);
			expect((await api('chat/rooms/join', { roomId: room.id }, invitee)).status).toBe(204);

			expect(await memberIds(room.id)).toEqual([invitee.id]);
		});

		test.each([
			['초대 주소가 아님', `${origin}/chat/rooms/abc`, 'INVALID_INVITE_LINK'],
			['쿼리가 붙음', `${origin}/chat/invite/Ab3dEf6hIj9lMn0p?x=1`, 'INVALID_INVITE_LINK'],
			['다른 서버의 http 주소', 'http://other.example/chat/invite/Ab3dEf6hIj9lMn0p', 'INVALID_INVITE_LINK'],
			['없는 코드', `${origin}/chat/invite/Ab3dEf6hIj9lMn0p`, 'NO_SUCH_INVITE_LINK'],
		])('%s이면 거절한다', async (_, url, code) => {
			const response = await join(url, member);

			expect(errorCode(response)).toBe(code);
		});
	});

	describe('같은 그룹 잠금 아래의 경쟁', () => {
		test('정원 직전에 동시에 참여해도 정원을 넘지 않고, 늦은 쪽은 정원 사유를 받는다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);
			const users = await Promise.all(Array.from({ length: 51 }, () => signup()));
			for (const user of users.slice(0, 49)) expect((await join(link.url, user)).status).toBe(200);

			const [first, second] = await Promise.all(users.slice(49).map(user => join(link.url, user)));

			expect([first.status, second.status].sort()).toEqual([200, 400]);
			expect(errorCode([first, second].find(result => result.status === 400)!)).toBe('ROOM_IS_FULL');
			expect(await memberIds(room.id)).toHaveLength(50);
			expect((await api('chat/invite-link/show', { code: link.code })).body.membersCount).toBe(51);
		}, 180_000);

		test('폐기와 참여가 겹치면 둘 중 한 순서로만 끝난다', async () => {
			for (let i = 0; i < 5; i++) {
				const room = await createRoom();
				const link = await createLink(room.id);
				const user = await signup();

				const [revoked, joined] = await Promise.all([
					api('chat/rooms/invite-link/revoke', { roomId: room.id }, owner),
					join(link.url, user),
				]);

				expect(revoked.status).toBe(204);
				if (joined.status === 200) {
					expect(await memberIds(room.id)).toEqual([user.id]);
				} else {
					expect(errorCode(joined)).toBe('NO_SUCH_INVITE_LINK');
					expect(await memberIds(room.id)).toEqual([]);
				}
			}
		}, 60_000);

		test('내보내기 뒤 남은 멤버가 같은 링크를 다시 눌러도 그 멤버십은 그대로다', async () => {
			const room = await createRoom();
			const link = await createLink(room.id);
			const [stays, kicked] = await Promise.all([signup(), signup()]);
			expect((await join(link.url, stays)).status).toBe(200);
			expect((await join(link.url, kicked)).status).toBe(200);

			expect((await api('chat/rooms/kick', { roomId: room.id, userId: kicked.id }, owner)).status).toBe(204);

			expect(await memberIds(room.id)).toEqual([stays.id]);
			expect((await join(link.url, stays)).body).toEqual({ status: 'joined', roomId: room.id });
			expect(await memberIds(room.id)).toEqual([stays.id]);
		});
	});
});
