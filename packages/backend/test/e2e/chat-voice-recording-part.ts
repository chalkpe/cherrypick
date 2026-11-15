/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, test } from 'vitest';
import { api, castAsError, relativeFetch, role, signup } from '../utils.js';
import type * as misskey from 'cherrypick-js';

let root: misskey.entities.SignupResponse;

// The first account of a server is its administrator.
beforeAll(async () => {
	root = await signup({ username: 'root' });
}, 1000 * 60 * 2);

// 녹화 조각 업로드는 multipart라 api() 헬퍼 대신 실제 HTTP 폼으로 요청한다.
async function uploadPart(user: misskey.entities.SignupResponse | null, roomId: string | null): Promise<{ status: number; body: any }> {
	const form = new FormData();
	const bytes = new Uint8Array(await readFile(new URL('../resources/kick_gaba7.webm', import.meta.url)));
	form.append('file', new Blob([bytes], { type: 'audio/webm' }), 'part.webm');
	if (roomId != null) form.append('roomId', roomId);
	if (user != null) form.append('i', user.token);
	const res = await relativeFetch('api/chat/rooms/voice/recording-part', { method: 'POST', body: form });
	const body = res.status !== 204 ? await res.json() : null;
	return { status: res.status, body };
}

describe('recording part upload room permission', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let carol: misskey.entities.SignupResponse;
	let dave: misskey.entities.SignupResponse;
	let recordingRoom: string;
	let quietRoom: string;
	let archivedRoom: string;
	let withdrawnRoom: string;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		carol = await signup({ username: 'carol' });
		dave = await signup({ username: 'dave' });

		const created = await api('chat/rooms/create', { name: 'recording room' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));
		recordingRoom = created.body.id;
		assert.strictEqual((await api('chat/rooms/update', { roomId: recordingRoom, allowRecording: true }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: recordingRoom, userId: bob.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId: recordingRoom }, bob)).status, 204);

		// 녹화 허용을 켜지 않은 방(기본값)
		const quiet = await api('chat/rooms/create', { name: 'quiet room' }, alice);
		assert.strictEqual(quiet.status, 200, JSON.stringify(quiet.body));
		quietRoom = quiet.body.id;
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: quietRoom, userId: dave.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId: quietRoom }, dave)).status, 204);

		const archived = await api('chat/rooms/create', { name: 'archived recording room' }, alice);
		assert.strictEqual(archived.status, 200, JSON.stringify(archived.body));
		archivedRoom = archived.body.id;
		assert.strictEqual((await api('chat/rooms/update', { roomId: archivedRoom, allowRecording: true }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: archivedRoom, userId: bob.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId: archivedRoom }, bob)).status, 204);
		assert.strictEqual((await api('chat/rooms/update', { roomId: archivedRoom, isArchived: true }, alice)).status, 200);

		// 녹화를 허용했다가 소유자가 도중에 끄는 방
		const withdrawn = await api('chat/rooms/create', { name: 'withdrawn recording room' }, alice);
		assert.strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		withdrawnRoom = withdrawn.body.id;
		assert.strictEqual((await api('chat/rooms/update', { roomId: withdrawnRoom, allowRecording: true }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: withdrawnRoom, userId: bob.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId: withdrawnRoom }, bob)).status, 204);
		assert.strictEqual((await api('chat/rooms/update', { roomId: withdrawnRoom, allowRecording: false }, alice)).status, 200);
	}, 1000 * 60 * 2);

	test('an unauthenticated upload is refused', async () => {
		const res = await uploadPart(null, recordingRoom);

		assert.strictEqual(res.status, 401);
		assert.strictEqual(castAsError(res.body).error.code, 'CREDENTIAL_REQUIRED');
	});

	test('a user who belongs to no room cannot store a part', async () => {
		const res = await uploadPart(carol, recordingRoom);

		assert.strictEqual(res.status, 400, JSON.stringify(res.body));
		assert.strictEqual(castAsError(res.body).error.code, 'ACCESS_DENIED');
	});

	test('a member of a room that does not allow recording can finalize a part', async () => {
		const res = await uploadPart(dave, quietRoom);

		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.strictEqual(typeof res.body.id, 'string');
		assert.strictEqual(res.body.size, 8879);
	});

	test('a member can finalize a part after the owner withdraws recording permission', async () => {
		const res = await uploadPart(bob, withdrawnRoom);

		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.strictEqual(typeof res.body.id, 'string');
		assert.strictEqual(res.body.size, 8879);
	});

	test('a member can store a part without a connected call session', async () => {
		const res = await uploadPart(bob, recordingRoom);

		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.strictEqual(typeof res.body.id, 'string');
		assert.strictEqual(res.body.size, 8879);
	});

	test('the room owner can store a part', async () => {
		const res = await uploadPart(alice, recordingRoom);

		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.strictEqual(typeof res.body.id, 'string');
	});

	test('a member can finalize a part after the room is archived', async () => {
		const res = await uploadPart(bob, archivedRoom);

		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		assert.strictEqual(typeof res.body.id, 'string');
		assert.strictEqual(res.body.size, 8879);
	});

	test('a room that does not exist refuses a part', async () => {
		const res = await uploadPart(bob, '000000000000000000000000');

		assert.strictEqual(res.status, 400, JSON.stringify(res.body));
		assert.strictEqual(castAsError(res.body).error.code, 'ACCESS_DENIED');
	});

	test('a suspended member cannot store a part', async () => {
		const erin = await signup({ username: 'erin' });
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: recordingRoom, userId: erin.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId: recordingRoom }, erin)).status, 204);
		assert.strictEqual((await api('admin/suspend-user', { userId: erin.id }, root)).status, 204);
		// 정지는 내부 이벤트로 인증 캐시에 반영되므로, 반영될 때까지 기다린다
		const deadline = Date.now() + 30_000;
		let suspended = false;
		while (Date.now() < deadline) {
			const me = await api('i', {}, erin);
			if (me.status === 403 && castAsError(me.body as any).error.code === 'YOUR_ACCOUNT_SUSPENDED') { suspended = true; break; }
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		assert.ok(suspended, 'suspension did not reach the authentication path');

		const res = await uploadPart(erin, recordingRoom);

		assert.strictEqual(res.status, 403, JSON.stringify(res.body));
		assert.strictEqual(castAsError(res.body).error.code, 'YOUR_ACCOUNT_SUSPENDED');
		assert.strictEqual((await api('admin/unsuspend-user', { userId: erin.id }, root)).status, 204);
	});

	test('a member whose role cannot write chat cannot store a part', async () => {
		const frank = await signup({ username: 'frank' });
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: recordingRoom, userId: frank.id }, alice)).status, 200);
		assert.strictEqual((await api('chat/rooms/join', { roomId: recordingRoom }, frank)).status, 204);
		const restricted = await role(root, { name: 'no chat write' }, {
			chatAvailability: { useDefault: false, priority: 0, value: 'unavailable' },
		});
		assert.strictEqual((await api('admin/roles/assign', { roleId: restricted.id, userId: frank.id }, root)).status, 204);
		// 역할 배정은 내부 이벤트로 정책 캐시에 반영되므로, 반영될 때까지 기다린다
		const deadline = Date.now() + 30_000;
		let applied = false;
		while (Date.now() < deadline) {
			const me = await api('i', {}, frank);
			if (me.status === 200 && me.body.policies?.chatAvailability === 'unavailable') { applied = true; break; }
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		assert.ok(applied, 'role policy did not reach the authentication path');

		const res = await uploadPart(frank, recordingRoom);

		assert.strictEqual(res.status, 403, JSON.stringify(res.body));
		assert.strictEqual(castAsError(res.body).error.code, 'ROLE_PERMISSION_DENIED');
	});

	test('conversion and discard refuse a part owned by someone else', async () => {
		const stored = await uploadPart(bob, recordingRoom);
		assert.strictEqual(stored.status, 200, JSON.stringify(stored.body));
		const partId = stored.body.id as string;

		const converted = await api('chat/rooms/voice/convert-recording', { fileIds: [partId], requestId: '0b9d2c1e-4f5a-4a6b-8c7d-9e0f1a2b3c4d' }, carol);
		assert.strictEqual(converted.status, 400, JSON.stringify(converted.body));
		assert.strictEqual(castAsError(converted.body as any).error.code, 'NO_SUCH_FILE');

		const discarded = await api('chat/rooms/voice/recording-discard', { partIds: [partId] }, carol);
		assert.strictEqual(discarded.status, 400, JSON.stringify(discarded.body));
		assert.strictEqual(castAsError(discarded.body as any).error.code, 'NO_SUCH_PART');

		// 본인 것은 버릴 수 있고, 버린 조각은 변환에 다시 쓸 수 없다
		const own = await api('chat/rooms/voice/recording-discard', { partIds: [partId] }, bob);
		assert.strictEqual(own.status, 204, JSON.stringify(own.body));
		const after = await api('chat/rooms/voice/convert-recording', { fileIds: [partId], requestId: '1c0e3d2f-5a6b-4c7d-9e8f-0a1b2c3d4e5f' }, bob);
		assert.strictEqual(after.status, 400, JSON.stringify(after.body));
		assert.strictEqual(castAsError(after.body as any).error.code, 'NO_SUCH_FILE');
	});
});
