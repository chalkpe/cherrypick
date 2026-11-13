/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { api, post, relativeFetch, signup, startJobQueue } from '../utils.js';
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
	expect(preview.body.items.find((item: any) => item.noteId === deletable.id).decision).toBe('delete');
	expect(preview.body.items.find((item: any) => item.noteId === protectedNote.id).reason).toBe('protected');
	expect(preview.body.items.some((item: any) => item.noteId === foreign.id)).toBe(false);
	expect((await cleanup('request', { ruleIds }, alice)).body.queued).toBe(true);
	await expect.poll(async () => (await api('notes/show', { noteId: deletable.id }, alice)).status, { timeout: 20000, interval: 100 }).toBe(400);
	expect((await api('notes/show', { noteId: protectedNote.id }, alice)).status).toBe(200);
	expect((await api('notes/show', { noteId: foreign.id }, bob)).status).toBe(200);
});
