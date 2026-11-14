/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, beforeAll, vi } from 'vitest';
import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import * as Misskey from 'cherrypick-js';
import { createAccount, fetchAdmin, isFired, type LoginUser, resolveRemoteUser, WAIT_FOR_FEDERATION, WAIT_FOR_SLOW_FEDERATION } from './utils.js';

type JoinStatus = Misskey.Endpoints['chat/invite-link/join-status']['res'];

/** a.test에 그룹을 만들고 초대 링크를 발급한다. b.test 계정은 링크 주소 하나로 참여한다 */
describe('Chat invite link', () => {
	let alice: LoginUser;

	beforeAll(async () => {
		alice = await createAccount('a.test');
	});

	async function createRoomWithLink(options: { description?: string; channels?: boolean } = {}) {
		const name = `초대 ${crypto.randomUUID()}`;
		const room = await alice.client.request('chat/rooms/create', { name, description: options.description ?? '' });
		if (options.channels) await alice.client.request('chat/rooms/convert-to-channels', { roomId: room.id });
		const link = await alice.client.request('chat/rooms/invite-link/create', { roomId: room.id });
		return { room, name, url: link.url, code: link.code };
	}

	async function settled(user: LoginUser, url: string): Promise<JoinStatus> {
		return await vi.waitFor(async () => {
			const status = await user.client.request('chat/invite-link/join-status', { url });
			if (status.status === 'pending' || status.status === 'none') throw new Error(`still ${status.status}`);
			return status;
		}, WAIT_FOR_SLOW_FEDERATION);
	}

	async function membersOnA(roomId: string): Promise<string[]> {
		const members = await alice.client.request('chat/rooms/members', { roomId, limit: 100 });
		return members.map(member => member.userId);
	}

	async function idOnA(user: LoginUser): Promise<string> {
		return (await resolveRemoteUser('b.test', user.id, alice)).id;
	}

	function apiError(code: string) {
		return (err: unknown) => {
			strictEqual((err as { code?: unknown }).code, code);
			return true;
		};
	}

	test('카드·서버 간 미리보기·직접 연 화면은 이름·설명·멤버 수만 보이고 아무도 가입시키지 않는다', async () => {
		const { room, name, url, code } = await createRoomWithLink({ description: '모임 설명' });
		const bob = await createAccount('b.test');

		const card = await (await fetch(`https://b.test/url?url=${encodeURIComponent(url)}&lang=ko-KR`)).json() as Record<string, any>;
		const preview = await (await fetch(url, { headers: { Accept: 'application/activity+json' } })).json() as Record<string, any>;
		const html = await (await fetch(url, { headers: { Accept: 'text/html' } })).text();

		const iconUrl = card.chatInvite.iconUrl;
		deepStrictEqual(card.chatInvite, { url, host: 'a.test', code, name, description: '모임 설명', membersCount: 1, isLocal: false, iconUrl, iconBlurhash: null, iconDecorations: [] });
		strictEqual(new URL(iconUrl).searchParams.get('url'), room.iconUrl);
		strictEqual(card.title, name);
		strictEqual(preview.id, url);
		strictEqual(preview.type, 'Invite');
		deepStrictEqual(Object.keys(preview.object).sort(), ['_misskey_chatArchived', '_misskey_chatIconDecorations', '_misskey_chatRoomMembersCount', 'icon', 'id', 'name', 'summary', 'type']);
		deepStrictEqual(preview.object.icon, { type: 'Image', url: room.iconUrl });
		strictEqual(preview.object.id, `https://a.test/chat/rooms/${room.id}`);
		deepStrictEqual(preview.endpoints, { sharedInbox: 'https://a.test/inbox' });
		strictEqual(JSON.stringify(preview).includes(alice.id), false);
		strictEqual(html.includes(`<meta property="og:title" content="${name}"`), true);
		strictEqual(html.includes('<meta name="robots" content="noindex"'), true);
		deepStrictEqual(await membersOnA(room.id), []);
		deepStrictEqual(await alice.client.request('chat/rooms/invitations/outbox', { roomId: room.id }), []);
		deepStrictEqual(await bob.client.request('chat/invite-link/join-status', { url }), { status: 'none', roomId: null, reason: null });
	});

	test.each([false, true])('실제 그룹 아이콘과 장식은 다른 서버 카드에서도 기존 미디어 경로로 조회한다 (채널: %s)', async channels => {
		const { room, url } = await createRoomWithLink({ channels });
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGN49uHXf0owwzA0QK74Dl48asDIMGDgUyLdDQAAHih2brHx0sgAAAAASUVORK5CYII=', 'base64');
		const upload = new FormData();
		upload.append('i', alice.i);
		upload.append('file', new Blob([Uint8Array.from(png)], { type: 'image/png' }), 'invite-square.png');
		const uploaded = await fetch('https://a.test/api/drive/files/create', { method: 'POST', body: upload });
		strictEqual(uploaded.status, 200);
		const file = await uploaded.json() as Misskey.entities.DriveFile;
		const admin = await fetchAdmin('a.test');
		const decoration = await admin.client.request('admin/avatar-decorations/create', { name: '도형', description: '', url: file.url });
		const updated = await alice.client.request('chat/rooms/update', { roomId: room.id, iconId: file.id, iconDecorations: [{ id: decoration.id, angle: 0.1 }] });

		const response = await fetch(`https://b.test/url?url=${encodeURIComponent(url)}&lang=ko-KR`);
		strictEqual(response.status, 200);
		const card = await response.json() as Record<string, any>;

		strictEqual(new URL(card.chatInvite.iconUrl).searchParams.get('url'), updated.iconUrl);
		strictEqual(card.chatInvite.iconDecorations.length, 1);
		strictEqual(card.chatInvite.iconDecorations[0].angle, 0.1);
		strictEqual(new URL(card.chatInvite.iconDecorations[0].url).searchParams.get('url'), file.url);
		for (const image of [card.chatInvite.iconUrl, card.chatInvite.iconDecorations[0].url]) {
			const media = await fetch(image);
			strictEqual(media.status, 200);
			strictEqual(media.headers.get('content-type')?.startsWith('image/'), true);
		}
		deepStrictEqual(await membersOnA(room.id), []);
		deepStrictEqual(await alice.client.request('chat/rooms/invitations/outbox', { roomId: room.id }), []);
	});

	test('드라이브에서 그룹 아이콘을 지우면 양쪽 그룹에서 아이콘이 사라지고 프로필 장식은 유지된다', async () => {
		const { room, url } = await createRoomWithLink();
		const bob = await createAccount('b.test');
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGN49uHXf0owwzA0QK74Dl48asDIMGDgUyLdDQAAHih2brHx0sgAAAAASUVORK5CYII=', 'base64');

		async function upload(name: string) {
			const form = new FormData();
			form.append('i', alice.i);
			form.append('file', new Blob([Uint8Array.from(Buffer.concat([png, Buffer.from(name)]))], { type: 'image/png' }), name);
			const response = await fetch('https://a.test/api/drive/files/create', { method: 'POST', body: form });
			strictEqual(response.status, 200);
			return await response.json() as Misskey.entities.DriveFile;
		}

		const icon = await upload('room.png');
		const avatar = await upload('profile.png');
		const admin = await fetchAdmin('a.test');
		const decoration = await admin.client.request('admin/avatar-decorations/create', { name: '보존 장식', description: '', url: avatar.url });
		await alice.client.request('i/update', { avatarId: avatar.id, avatarDecorations: [{ id: decoration.id, angle: 0.1 }], name: '프로필 확인' });
		await alice.client.request('chat/rooms/update', { roomId: room.id, iconId: icon.id, iconDecorations: [{ id: decoration.id, angle: 0.1 }] });
		await bob.client.request('chat/invite-link/join', { url });
		const status = await settled(bob, url);
		strictEqual(status.status, 'joined');
		const mirrorId = status.roomId!;
		await vi.waitFor(async () => {
			const mirror = await bob.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(mirror.iconId != null, true);
			strictEqual(mirror.iconDecorations?.length, 1);
		}, WAIT_FOR_SLOW_FEDERATION);

		await alice.client.request('drive/files/delete', { fileId: icon.id });

		await vi.waitFor(async () => {
			const local = await alice.client.request('chat/rooms/show', { roomId: room.id });
			const remote = await bob.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(local.iconId, null);
			strictEqual(remote.iconId, null);
			strictEqual(local.iconDecorations?.length, 1);
			strictEqual(remote.iconDecorations?.length, 1);
		}, WAIT_FOR_SLOW_FEDERATION);
		const profile = await alice.client.request('i', {});
		strictEqual(profile.name, '프로필 확인');
		strictEqual(profile.avatarId, avatar.id);
		strictEqual(profile.avatarDecorations[0].id, decoration.id);
		await rejects(alice.client.request('drive/files/show', { fileId: icon.id }));
	});

	test('다른 서버 계정은 Join → Invite → 자동 Accept로 양쪽에서 멤버가 되고, 다시 눌러도 그대로다', async () => {
		const { room, url } = await createRoomWithLink();
		const bob = await createAccount('b.test');

		let joined: Misskey.Endpoints['chat/invite-link/join']['res'] | undefined;
		const fired = await isFired('b.test', bob, 'main', async () => {
			joined = await bob.client.request('chat/invite-link/join', { url });
		}, 'chatInviteJoinResult', msg => msg.url === url && msg.status === 'joined', undefined, 15000);
		const status = await settled(bob, url);

		deepStrictEqual(joined, { status: 'pending', roomId: null });
		strictEqual(fired, true);
		strictEqual(status.status, 'joined');
		const mirrorId = status.roomId!;
		const bobOnA = await idOnA(bob);
		await vi.waitFor(async () => deepStrictEqual(await membersOnA(room.id), [bobOnA]), WAIT_FOR_FEDERATION);
		deepStrictEqual(await bob.client.request('chat/rooms/invitations/inbox', {}), []);
		const notifications = await bob.client.request('i/notifications', { includeTypes: ['chatRoomInvitationReceived'] });
		strictEqual(notifications.length, 0);

		const again = await bob.client.request('chat/invite-link/join', { url });

		deepStrictEqual(again, { status: 'joined', roomId: mirrorId });
		deepStrictEqual(await membersOnA(room.id), [bobOnA]);
	});

	test('채널형 그룹도 같은 경로로 참여하고 가입 뒤 채널 목록을 받는다', async () => {
		const { room, url } = await createRoomWithLink({ channels: true });
		const carol = await createAccount('b.test');

		await carol.client.request('chat/invite-link/join', { url });
		const status = await settled(carol, url);

		strictEqual(status.status, 'joined');
		deepStrictEqual(await membersOnA(room.id), [await idOnA(carol)]);
		await vi.waitFor(async () => {
			const channels = await carol.client.request('chat/rooms/channels/list', { roomId: status.roomId! });
			deepStrictEqual(channels.map(channel => channel.name), ['general']);
		}, WAIT_FOR_FEDERATION);
	});

	test('같은 계정의 동시 요청은 하나의 Join을 보내고 양쪽에서 한 번 가입한다', async () => {
		const { room, url } = await createRoomWithLink();
		const bob = await createAccount('b.test');
		const admin = await fetchAdmin('b.test');

		const results = await Promise.all([1, 2].map(() => bob.client.request('chat/invite-link/join', { url })));
		for (const result of results) strictEqual(['pending', 'joined'].includes(result.status), true);

		const jobs = await admin.client.request('admin/queue/jobs', { queue: 'deliver', state: ['active', 'wait', 'delayed', 'completed', 'failed'], search: bob.id });
		const joins = jobs.filter(job => {
			const data = job.data as { content?: string };
			if (data.content == null) return false;
			const activity = JSON.parse(data.content);
			return activity.type === 'Join' && activity.object === url;
		});
		strictEqual(joins.length, 1);

		const bobOnA = await idOnA(bob);
		await vi.waitFor(async () => {
			strictEqual((await bob.client.request('chat/invite-link/join-status', { url })).status, 'joined');
			deepStrictEqual(await membersOnA(room.id), [bobOnA]);
		}, WAIT_FOR_FEDERATION);
	});

	test('보관된 그룹은 Join을 받은 그룹 서버가 보관 사유로 거절하고 그 사유가 그대로 전해진다', async () => {
		const { room, url } = await createRoomWithLink();
		await alice.client.request('chat/rooms/update', { roomId: room.id, isArchived: true });
		const dave = await createAccount('b.test');

		deepStrictEqual(await dave.client.request('chat/invite-link/join', { url }), { status: 'pending', roomId: null });

		deepStrictEqual(await settled(dave, url), { status: 'refused', roomId: null, reason: 'archived' });
		deepStrictEqual(await membersOnA(room.id), []);
	});

	test('그룹장이 차단한 계정은 차단 사유로 거절되고, 참여하려는 사람이 그룹장을 차단한 것은 막지 않는다', async () => {
		const { room, url } = await createRoomWithLink();
		const warmup = await createRoomWithLink();
		const previousMember = await createAccount('b.test');
		await previousMember.client.request('chat/invite-link/join', { url: warmup.url });
		await settled(previousMember, warmup.url);
		await vi.waitFor(async () => deepStrictEqual(await membersOnA(warmup.room.id), [await idOnA(previousMember)]), WAIT_FOR_FEDERATION);

		const [blockedByOwner, blocksOwner] = await Promise.all([createAccount('b.test'), createAccount('b.test')]);
		await alice.client.request('blocking/create', { userId: await idOnA(blockedByOwner) });
		const aliceOnB = await resolveRemoteUser('a.test', alice.id, blocksOwner);
		await blocksOwner.client.request('blocking/create', { userId: aliceOnB.id });

		await blockedByOwner.client.request('chat/invite-link/join', { url });
		await blocksOwner.client.request('chat/invite-link/join', { url });

		deepStrictEqual(await settled(blockedByOwner, url), { status: 'refused', roomId: null, reason: 'blocked' });
		strictEqual((await settled(blocksOwner, url)).status, 'joined');
		deepStrictEqual(await membersOnA(room.id), [await idOnA(blocksOwner)]);
	});

	test('캐시된 카드가 남아 있어도 폐기된 링크로는 참여할 수 없다', async () => {
		const { room, url } = await createRoomWithLink();
		const erin = await createAccount('b.test');
		const card = await (await fetch(`https://b.test/url?url=${encodeURIComponent(url)}&lang=ko-KR`)).json() as Record<string, any>;
		strictEqual(card.chatInvite.url, url);

		await alice.client.request('chat/rooms/invite-link/revoke', { roomId: room.id });
		const renewed = await alice.client.request('chat/rooms/invite-link/create', { roomId: room.id });

		await rejects(erin.client.request('chat/invite-link/join', { url }), apiError('NO_SUCH_INVITE_LINK'));
		strictEqual(renewed.url === url, false);
		deepStrictEqual(await membersOnA(room.id), []);
	});

	test('스스로 나간 사람은 같은 링크로 다시 참여한다', async () => {
		const { room, url } = await createRoomWithLink();
		const frank = await createAccount('b.test');
		await frank.client.request('chat/invite-link/join', { url });
		const { roomId: mirrorId } = await settled(frank, url);
		const frankOnA = await idOnA(frank);

		await frank.client.request('chat/rooms/leave', { roomId: mirrorId! });
		await vi.waitFor(async () => deepStrictEqual(await membersOnA(room.id), []), WAIT_FOR_FEDERATION);
		await vi.waitFor(async () => strictEqual((await frank.client.request('chat/invite-link/join', { url })).status, 'pending'), WAIT_FOR_FEDERATION);

		strictEqual((await settled(frank, url)).status, 'joined');
		await vi.waitFor(async () => deepStrictEqual(await membersOnA(room.id), [frankOnA]), WAIT_FOR_FEDERATION);
	});

	test('개별 초대가 와 있던 사람은 링크로 참여할 때 기존 수락 경로로 바로 들어간다', async () => {
		const { room, name, url } = await createRoomWithLink();
		const gina = await createAccount('b.test');
		await alice.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: await idOnA(gina) });
		const mirrorId = await vi.waitFor(async () => {
			const invitation = (await gina.client.request('chat/rooms/invitations/inbox', {})).find(candidate => candidate.room.name === name);
			if (invitation == null) throw new Error('the invitation has not arrived yet');
			return invitation.roomId;
		}, WAIT_FOR_FEDERATION);

		deepStrictEqual(await gina.client.request('chat/invite-link/join', { url }), { status: 'joined', roomId: mirrorId });
		deepStrictEqual(await gina.client.request('chat/invite-link/join-status', { url }), { status: 'joined', roomId: mirrorId, reason: null });

		await vi.waitFor(async () => deepStrictEqual(await membersOnA(room.id), [await idOnA(gina)]), WAIT_FOR_FEDERATION);
	});

	test('정원 직전에 두 서버 계정이 함께 참여하면 한 명만 들어가고 다른 한 명은 정원 사유를 받는다', async () => {
		const { room, url } = await createRoomWithLink();
		for (let i = 0; i < 49; i += 7) {
			const locals = await Promise.all(Array.from({ length: Math.min(7, 49 - i) }, () => createAccount('a.test')));
			for (const local of locals) strictEqual((await local.client.request('chat/invite-link/join', { url })).status, 'joined');
		}
		const [harry, iris] = await Promise.all([createAccount('b.test'), createAccount('b.test')]);

		await Promise.all([harry, iris].map(user => user.client.request('chat/invite-link/join', { url })));
		const results = await vi.waitFor(async () => {
			const statuses = await Promise.all([harry, iris].map(user => user.client.request('chat/invite-link/join-status', { url })));
			deepStrictEqual(statuses.map(result => result.status).sort(), ['joined', 'refused']);
			return statuses;
		}, WAIT_FOR_SLOW_FEDERATION);
		strictEqual(results.find(result => result.status === 'refused')!.reason, 'full');
		await vi.waitFor(async () => strictEqual((await membersOnA(room.id)).length, 50), WAIT_FOR_FEDERATION);
		const loser = results[0].status === 'refused' ? harry : iris;
		strictEqual((await membersOnA(room.id)).includes(await idOnA(loser)), false);
		await vi.waitFor(async () => deepStrictEqual(await loser.client.request('chat/invite-link/join-status', { url }), { status: 'refused', roomId: null, reason: 'full' }), WAIT_FOR_FEDERATION);
	}, 240_000);
});
