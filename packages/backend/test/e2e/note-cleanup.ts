/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { api, post, relativeFetch, signup, startJobQueue, uploadFile } from '../utils.js';
import type { UserToken } from '../utils.js';
import type { INestApplicationContext } from '@nestjs/common';

let queue: INestApplicationContext;

async function cleanup(path: string, params: Record<string, unknown>, user?: UserToken) {
	const response = await relativeFetch(`api/i/note-cleanup/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, ...(user ? { i: user.token } : {}) }) });
	return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
}

const keyword = (value: string) => ({ type: 'keyword', mode: 'literal', value, flags: '', targets: ['text', 'cw', 'poll'] });

beforeAll(async () => { queue = await startJobQueue(); }, 120000);
afterAll(async () => { await queue?.close(); });

test('노트 정리 API의 인증 및 다른 사용자 규칙 접근을 거부한다', async () => {
	const alice = await signup({ username: 'cleanupowner' });
	const bob = await signup({ username: 'cleanupother' });
	expect((await cleanup('list', {})).status).toBe(401);
	const rejected = await cleanup('create', { name: '정리', action: 'delete', condition: keyword('정리'), automatic: true }, alice);
	expect(rejected.status).toBe(400);
	expect(rejected.body.error.info.code).toBe('PREVIEW_REQUIRED');
	const created = await cleanup('create', { name: '정리', action: 'delete', condition: keyword('정리'), automatic: false }, alice);
	expect(created.status).toBe(200);
	expect(created.body.rule.automatic).toBe(false);
	for (const path of ['update', 'delete']) {
		const response = await cleanup(path, { ruleId: created.body.rule.id, name: '다른 계정', action: 'delete', condition: keyword('정리') }, bob);
		expect(response.status).toBe(400);
	}
	expect((await cleanup('request', { ruleIds: [created.body.rule.id] }, bob)).status).toBe(400);
});

test('계속 알아서 정리하기는 명시 확인으로만 처음 켤 수 있고 활성 변경도 확인이 필요하다', async () => {
	const alice = await signup({ username: 'cleanupconfirm' });
	const condition = keyword('확인');
	const input = { name: '자동', action: 'delete', condition };
	expect((await cleanup('create', { ...input, automatic: true }, alice)).body.error.info.code).toBe('PREVIEW_REQUIRED');
	const created = await cleanup('create', { ...input, automatic: true, confirmed: true }, alice);
	expect(created.status).toBe(200);
	expect(created.body.rule.automaticConfirmed).toBe(true);
	const ruleId = created.body.rule.id;
	expect((await cleanup('update', { ruleId, ...input, enabled: false }, alice)).body.error.info.code).toBe('CONFIRMATION_REQUIRED');
	const stopped = await cleanup('update', { ruleId, ...input, enabled: false, confirmed: true }, alice);
	expect(stopped.status).toBe(200);
	expect(stopped.body.rule.enabled).toBe(false);
	// 한 번 확인한 규칙은 조건을 바꿔도 자동 실행 확인을 다시 요구하지 않는다.
	const edited = await cleanup('update', { ruleId, ...input, condition: keyword('다른 확인'), automatic: true, enabled: true, confirmed: true }, alice);
	expect(edited.status).toBe(200);
	expect(edited.body.rule.automaticConfirmed).toBe(true);
});

test('CW 미리 보기와 실제 삭제는 공통 보호를 지키며 타인의 노트를 삭제하지 않는다', async () => {
	const alice = await signup({ username: 'cleanupdelete' });
	const bob = await signup({ username: 'cleanupforeign' });
	const deletable = await post(alice, { text: '본문', cw: '정리' });
	const protectedNote = await post(alice, { text: '본문', cw: '정리 보존' });
	const foreign = await post(bob, { text: '본문', cw: '정리' });
	await cleanup('create', { name: '보존', action: 'keep', condition: keyword('보존') }, alice);
	const deletion = await cleanup('create', { name: '정리', action: 'delete', condition: keyword('정리') }, alice);
	const ruleIds = [deletion.body.rule.id];
	const preview = await cleanup('preview', { ruleIds }, alice);
	expect(preview.body.notes.map((note: any) => note.id)).toContain(deletable.id);
	expect(preview.body.notes.some((note: any) => note.id === protectedNote.id)).toBe(false);
	expect(preview.body.notes.some((note: any) => note.id === foreign.id)).toBe(false);
	expect((await cleanup('request', { ruleIds }, alice)).body.queued).toBe(true);
	await expect.poll(async () => (await api('notes/show', { noteId: deletable.id }, alice)).status, { timeout: 20000, interval: 100 }).toBe(400);
	expect((await api('notes/show', { noteId: protectedNote.id }, alice)).status).toBe(200);
	expect((await api('notes/show', { noteId: foreign.id }, bob)).status).toBe(200);
});

test('드라이브 보존 설정은 기본 켜짐이고 끄면 지운 노트의 미사용 첨부만 삭제한다', async () => {
	const alice = await signup({ username: 'cleanupdrive' });
	// secure 엔드포인트라 미인증 호출은 403(ACCESS_DENIED)이다. 다른 정리 쓰기 엔드포인트와 동일하다.
	expect((await cleanup('update-settings', { keepDriveFiles: false })).status).toBe(403);
	expect((await cleanup('update-settings', {}, alice)).status).toBe(400);
	expect((await cleanup('update-settings', { keepDriveFiles: 'no' }, alice)).status).toBe(400);
	expect((await cleanup('list', {}, alice)).body.keepDriveFiles).toBe(true);

	const unusedFile = await uploadFile(alice);
	const sharedFile = await uploadFile(alice);
	const avatarFile = await uploadFile(alice);
	const keptFile = await uploadFile(alice);
	expect((await api('i/update', { avatarId: avatarFile.body!.id }, alice)).status).toBe(200);
	const target = await post(alice, { text: '정리 대상', fileIds: [unusedFile.body!.id, sharedFile.body!.id, avatarFile.body!.id, keptFile.body!.id] });
	const keeper = await post(alice, { text: '유지', fileIds: [sharedFile.body!.id] });
	const deletion = await cleanup('create', { name: '정리', action: 'delete', condition: keyword('정리 대상') }, alice);
	const ruleIds = [deletion.body.rule.id];

	// 기본 켜짐: 노트만 지우고 첨부 파일은 모두 남는다.
	expect((await cleanup('request', { ruleIds }, alice)).body.queued).toBe(true);
	await expect.poll(async () => (await api('notes/show', { noteId: target.id }, alice)).status, { timeout: 20000, interval: 100 }).toBe(400);
	for (const file of [unusedFile, sharedFile, avatarFile, keptFile]) {
		expect((await api('drive/files/show', { fileId: file.body!.id }, alice)).status).toBe(200);
	}

	// 끄면 지운 노트의 첨부 중 미사용 파일만 지운다. 사용 중(다른 노트·아바타) 파일과 이전에 지킨 파일은 남는다.
	expect((await cleanup('update-settings', { keepDriveFiles: false }, alice)).body.keepDriveFiles).toBe(false);
	expect((await cleanup('list', {}, alice)).body.keepDriveFiles).toBe(false);
	const secondFile = await uploadFile(alice);
	const target2 = await post(alice, { text: '정리 대상 2', fileIds: [secondFile.body!.id, unusedFile.body!.id] });
	expect((await cleanup('request', { ruleIds }, alice)).body.queued).toBe(true);
	await expect.poll(async () => (await api('notes/show', { noteId: target2.id }, alice)).status, { timeout: 20000, interval: 100 }).toBe(400);
	await expect.poll(async () => (await api('drive/files/show', { fileId: secondFile.body!.id }, alice)).status, { timeout: 20000, interval: 100 }).toBe(400);
	expect((await api('drive/files/show', { fileId: unusedFile.body!.id }, alice)).status).toBe(400);
	expect((await api('drive/files/show', { fileId: sharedFile.body!.id }, alice)).status).toBe(200);
	expect((await api('drive/files/show', { fileId: avatarFile.body!.id }, alice)).status).toBe(200);
	expect((await api('drive/files/show', { fileId: keptFile.body!.id }, alice)).status).toBe(200);
	expect((await api('notes/show', { noteId: keeper.id }, alice)).status).toBe(200);
});
