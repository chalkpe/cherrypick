/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DI } from '@/di-symbols.js';
import { NoteAttachedFileService } from '@/core/NoteAttachedFileService.js';
import { api, galleryPost, page, post, relativeFetch, signup, startJobQueue, uploadFile } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import type { UserToken } from '../utils.js';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'cherrypick-js';

type User = misskey.entities.SignupResponse;

let queue: INestApplicationContext;
let root: User;

beforeAll(async () => {
	queue = await startJobQueue();
	root = await signup({ username: 'root' });
}, 120000);

afterAll(async () => {
	await waitForChatNotificationTurn();
	await queue?.close();
}, 60000);

async function newUser(username: string, enabled: boolean): Promise<User> {
	const user = await signup({ username });
	if (enabled) expect((await api('i/update', { autoDeleteNoteFiles: true }, user)).status).toBe(200);
	return user;
}

async function upload(user: User): Promise<string> {
	const res = await uploadFile(user);
	expect(res.status).toBe(200);
	return res.body!.id;
}

async function fileExists(user: User, fileId: string): Promise<boolean> {
	return (await api('drive/files/show', { fileId }, user)).status === 200;
}

async function noteExists(user: UserToken, noteId: string): Promise<boolean> {
	return (await api('notes/show', { noteId }, user)).status === 200;
}

async function deleteNote(user: User, noteId: string, keepFiles?: boolean) {
	const res = await api('notes/delete', { noteId, ...(keepFiles === undefined ? {} : { keepFiles }) } as never, user);
	expect(res.status).toBe(204);
}

describe('노트를 지울 때 단독 사용 첨부 파일 삭제 설정', () => {
	test('기본값은 꺼짐이고 내 정보에서만 읽고 바꿀 수 있다', async () => {
		const alice = await newUser('deletefilesdefault', false);
		const bob = await signup({ username: 'deletefilesother' });

		expect((await api('i', {}, alice)).body.autoDeleteNoteFiles).toBe(false);
		expect((await api('i/update', { autoDeleteNoteFiles: true }, alice)).body.autoDeleteNoteFiles).toBe(true);
		expect((await api('i', {}, alice)).body.autoDeleteNoteFiles).toBe(true);
		expect((await api('i/update', { autoDeleteNoteFiles: 'yes' } as never, alice)).status).toBe(400);
		expect((await api('users/show', { userId: alice.id }, bob)).body).not.toHaveProperty('autoDeleteNoteFiles');
	});

	test('꺼져 있으면 노트를 지워도 파일이 남는다', async () => {
		const alice = await newUser('deletefilesoff', false);
		const fileId = await upload(alice);
		const note = await post(alice, { text: '꺼짐', fileIds: [fileId] });

		await deleteNote(alice, note.id);

		expect(await noteExists(alice, note.id)).toBe(false);
		expect(await fileExists(alice, fileId)).toBe(true);
	});

	test('켜져 있으면 단독으로 쓰인 파일만 지운다', async () => {
		const alice = await newUser('deletefileson', true);
		const sole = await upload(alice);
		const note = await post(alice, { text: '단독', fileIds: [sole] });

		await deleteNote(alice, note.id);

		expect(await noteExists(alice, note.id)).toBe(false);
		expect(await fileExists(alice, sole)).toBe(false);
	});

	test('다른 곳에서도 쓰이는 파일은 남기고 단독 사용 파일만 지운다', async () => {
		const alice = await newUser('deletefilesshared', true);
		const bob = await signup({ username: 'deletefilesshared2' });
		await api('i/update', { chatScope: 'everyone' }, alice);
		await api('i/update', { chatScope: 'everyone' }, bob);
		const sole = await upload(alice);
		const withNote = await upload(alice);
		const withDraft = await upload(alice);
		const withChat = await upload(alice);
		const withAvatar = await upload(alice);
		const withGallery = await upload(alice);
		const withPage = await upload(alice);

		await post(alice, { text: '다른 노트', fileIds: [withNote] });
		expect((await api('notes/drafts/create', { text: '임시', fileIds: [withDraft] }, alice)).status).toBe(200);
		expect((await api('chat/messages/create-to-user', { toUserId: bob.id, fileId: withChat }, alice)).status).toBe(200);
		expect((await api('i/update', { avatarId: withAvatar }, alice)).status).toBe(200);
		await galleryPost(alice, { fileIds: [withGallery] });
		await page(alice, { name: `deletefiles-${Date.now()}`, eyeCatchingImageId: withPage });
		const target = await post(alice, { text: '대상', fileIds: [sole, withNote, withDraft, withChat, withAvatar, withGallery, withPage] });

		await deleteNote(alice, target.id);

		expect(await noteExists(alice, target.id)).toBe(false);
		expect(await fileExists(alice, sole)).toBe(false);
		for (const kept of [withNote, withDraft, withChat, withAvatar, withGallery, withPage]) {
			expect(await fileExists(alice, kept)).toBe(true);
		}
	});

	test('다른 노트의 예전 편집 이력에만 남아 있는 파일을 붙인 노트를 지워도 그 파일은 남긴다', async () => {
		const alice = await newUser('dfedithistory', true);
		const sole = await upload(alice);
		const onlyInHistory = await upload(alice);
		const replacement = await upload(alice);
		const edited = await post(alice, { text: '편집 전', fileIds: [onlyInHistory] });
		expect((await api('notes/update', { noteId: edited.id, text: '편집 후', cw: null, fileIds: [replacement] }, alice)).status).toBe(200);
		const target = await post(alice, { text: '대상', fileIds: [sole, onlyInHistory] });

		await deleteNote(alice, target.id);

		expect(await noteExists(alice, target.id)).toBe(false);
		expect(await fileExists(alice, sole)).toBe(false);
		expect(await fileExists(alice, onlyInHistory)).toBe(true);
		expect(await fileExists(alice, replacement)).toBe(true);
	});

	test('페이지 본문 블록이 가리키는 파일도 남긴다', async () => {
		const alice = await newUser('dfpageblock', true);
		const inPageBody = await upload(alice);
		const sole = await upload(alice);
		const target = await post(alice, { text: '대상', fileIds: [sole, inPageBody] });
		await page(alice, {
			name: `deletefiles-body-${Date.now()}`,
			content: [{ id: '8a3d3f0e-5d6b-4c61-9d2a-0e7c2e6d1b11', type: 'section', title: '구역', children: [{ id: '0f1d3a52-6c0b-4b7e-8d54-6d6f1f1a2c22', type: 'image', fileId: inPageBody }] }] as never,
		});

		await deleteNote(alice, target.id);

		expect(await fileExists(alice, sole)).toBe(false);
		expect(await fileExists(alice, inPageBody)).toBe(true);
	});

	test('삭제 후 편집처럼 keepFiles를 넘기면 파일을 남긴다', async () => {
		const alice = await newUser('deletefileskeep', true);
		const fileId = await upload(alice);
		const note = await post(alice, { text: '삭제 후 편집', fileIds: [fileId] });

		await deleteNote(alice, note.id, true);

		expect(await noteExists(alice, note.id)).toBe(false);
		expect(await fileExists(alice, fileId)).toBe(true);
	});

	test('모더레이터가 남의 노트를 지워도 파일을 남긴다', async () => {
		const alice = await newUser('deletefilesvictim', true);
		const moderator = await signup({ username: 'deletefilesmod' });
		const role = await api('admin/roles/create', {
			name: 'moderator', description: '', color: null, iconUrl: null, displayOrder: 0, target: 'manual', condFormula: {},
			isAdministrator: false, isModerator: true, isPublic: false, isExplorable: false, asBadge: false, canEditMembersByModerator: false, policies: {},
		}, root);
		const assigned = await api('admin/roles/assign', { userId: moderator.id, roleId: role.body.id }, root);
		expect(assigned.status, JSON.stringify([role.status, role.body, assigned.body])).toBe(204);
		const fileId = await upload(alice);
		const note = await post(alice, { text: '모더레이션', fileIds: [fileId] });

		await deleteNote(moderator, note.id);

		expect(await noteExists(alice, note.id)).toBe(false);
		expect(await fileExists(alice, fileId)).toBe(true);
	});

	test('예약 삭제로 지워질 때도 단독 사용 파일을 지운다', async () => {
		const alice = await newUser('deletefilesscheduled', true);
		const fileId = await upload(alice);
		const note = await post(alice, { text: '예약', fileIds: [fileId], scheduledDelete: { deleteAfter: 1500 } });

		await expect.poll(async () => await noteExists(alice, note.id), { timeout: 30000, interval: 200 }).toBe(false);
		await expect.poll(async () => await fileExists(alice, fileId), { timeout: 30000, interval: 200 }).toBe(false);
	});

	describe('노트 정리 규칙', () => {
		async function cleanupApi(path: string, params: Record<string, unknown>, user: User) {
			const res = await relativeFetch(`api/i/note-cleanup/${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...params, i: user.token }),
			});
			return { status: res.status, body: res.status === 204 ? null : await res.json() as any };
		}

		async function runCleanup(user: User, keyword: string) {
			const rule = await cleanupApi('create', { name: '정리', action: 'delete', condition: { type: 'keyword', mode: 'literal', value: keyword, flags: '', targets: ['text'] } }, user);
			expect((await cleanupApi('request', { ruleIds: [rule.body.rule.id] }, user)).status).toBe(200);
		}

		test('계정 설정이 켜져 있으면 노트 정리의 첨부 보존 설정이 남기기여도 단독 사용 파일을 지운다', async () => {
			const alice = await newUser('dfcleanupon', true);
			const sole = await upload(alice);
			const shared = await upload(alice);
			await post(alice, { text: '정리 유지', fileIds: [shared] });
			const note = await post(alice, { text: '정리 켜짐 대상', fileIds: [sole, shared] });
			expect((await cleanupApi('list', {}, alice)).body.keepDriveFiles).toBe(true);

			await runCleanup(alice, '정리 켜짐 대상');

			await expect.poll(async () => await noteExists(alice, note.id), { timeout: 30000, interval: 200 }).toBe(false);
			await expect.poll(async () => await fileExists(alice, sole), { timeout: 30000, interval: 200 }).toBe(false);
			expect(await fileExists(alice, shared)).toBe(true);
		});

		test('계정 설정이 꺼져 있고 첨부 보존 설정이 남기기면 파일을 남긴다', async () => {
			const alice = await newUser('dfcleanupoff', false);
			const sole = await upload(alice);
			const note = await post(alice, { text: '정리 꺼짐 대상', fileIds: [sole] });

			await runCleanup(alice, '정리 꺼짐 대상');

			await expect.poll(async () => await noteExists(alice, note.id), { timeout: 30000, interval: 200 }).toBe(false);
			expect(await fileExists(alice, sole)).toBe(true);
		});
	});

	test('원문을 지워도 남는 내 답글이 쓰는 파일은 지우지 않는다', async () => {
		const alice = await newUser('dfreplykeep', true);
		const parentOnly = await upload(alice);
		const sharedWithReply = await upload(alice);
		const parent = await post(alice, { text: '원문', fileIds: [parentOnly, sharedWithReply] });
		const reply = await post(alice, { text: '내 답글', replyId: parent.id, fileIds: [sharedWithReply] });
		const quote = await post(alice, { text: '내 인용', renoteId: parent.id });

		await deleteNote(alice, parent.id);

		expect(await noteExists(alice, parent.id)).toBe(false);
		expect(await noteExists(alice, reply.id)).toBe(true);
		expect(await noteExists(alice, quote.id)).toBe(true);
		expect(await fileExists(alice, parentOnly)).toBe(false);
		expect(await fileExists(alice, sharedWithReply)).toBe(true);
	});

	test('답글 자신을 지우면 그 답글에서만 쓰던 파일을 지우고 원문의 파일은 남긴다', async () => {
		const alice = await newUser('dfreplydelete', true);
		const parentFile = await upload(alice);
		const replyFile = await upload(alice);
		const parent = await post(alice, { text: '원문', fileIds: [parentFile] });
		const reply = await post(alice, { text: '내 답글', replyId: parent.id, fileIds: [replyFile] });

		await deleteNote(alice, reply.id);

		expect(await noteExists(alice, parent.id)).toBe(true);
		expect(await fileExists(alice, replyFile)).toBe(false);
		expect(await fileExists(alice, parentFile)).toBe(true);
	});

	test('다른 사람이 자기 노트를 지워도 내 답글과 그 첨부는 그대로 남는다', async () => {
		const alice = await newUser('dfforeign', true);
		const bob = await newUser('dfforeignbob', true);
		const bobSole = await upload(bob);
		const bobNote = await post(bob, { text: '남의 노트', fileIds: [bobSole] });
		const fileId = await upload(alice);
		const reply = await post(alice, { text: '내 답글', replyId: bobNote.id, fileIds: [fileId] });

		await deleteNote(bob, bobNote.id);

		expect(await fileExists(bob, bobSole)).toBe(false);
		expect(await noteExists(alice, reply.id)).toBe(true);
		expect(await fileExists(alice, fileId)).toBe(true);
	});

	test('서비스에 다른 사람의 파일을 넘겨도 지우지 않고 내 파일만 지운다', async () => {
		const alice = await newUser('dfownerA', true);
		const bob = await newUser('dfownerB', true);
		const bobFile = await upload(bob);
		const aliceFile = await upload(alice);
		const service = queue.get(NoteAttachedFileService);
		const aliceUser = await queue.get(DI.usersRepository).findOneByOrFail({ id: alice.id });

		await service.deleteUnreferenced(aliceUser, [aliceFile, bobFile]);

		expect(await fileExists(alice, aliceFile)).toBe(false);
		expect(await fileExists(bob, bobFile)).toBe(true);
	});
});
