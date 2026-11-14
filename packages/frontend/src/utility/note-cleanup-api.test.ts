/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' } }));
import { cleanupApi } from './note-cleanup-api.js';

afterEach(() => vi.unstubAllGlobals());

test('sends the saved literal AST to authenticated create, never to the legacy settings API', async () => {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(init.body as string) });
		return new Response(JSON.stringify({ rule: { id: 'rule-1' } }), { status: 200 });
	});
	const condition = { type: 'keyword' as const, mode: 'literal' as const, value: '/고양이.*/', flags: '', targets: ['text' as const, 'cw' as const, 'poll' as const] };
	await cleanupApi.save({ name: '기록', action: 'delete', condition });
	expect(calls).toEqual([{ url: 'https://cleanup.invalid/api/i/note-cleanup/create', body: { name: '기록', action: 'delete', condition, i: 'dummy-test-token' } }]);
});

test('keeps server validation errors and condition paths', async () => {
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code: 'INVALID_CONDITION', path: 'condition.children.0' } } }), { status: 400 }));
	await expect(cleanupApi.preview(['rule-1'])).rejects.toEqual({ code: 'INVALID_CLEANUP', info: { code: 'INVALID_CONDITION', path: 'condition.children.0' } });
});

test('enable changes always carry the confirmation the screen already collected', async () => {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(init.body as string) });
		return new Response(JSON.stringify(url.endsWith('/request') ? { queued: true, jobId: 'job-1' } : { rule: { id: 'rule-1', enabled: false } }));
	});
	const rule = { id: 'rule-1', name: '기록', action: 'delete' as const, condition: { type: 'age' as const, operator: 'gte' as const, seconds: 86400 } };
	await cleanupApi.setEnabled(rule, false);
	const result = await cleanupApi.request(['rule-1']);
	expect(calls).toEqual([
		{ url: 'https://cleanup.invalid/api/i/note-cleanup/update', body: { ruleId: 'rule-1', action: 'delete', condition: { type: 'age', operator: 'gte', seconds: 86400 }, enabled: false, confirmed: true, i: 'dummy-test-token' } },
		{ url: 'https://cleanup.invalid/api/i/note-cleanup/request', body: { ruleIds: ['rule-1'], i: 'dummy-test-token' } },
	]);
	expect(result).toEqual({ queued: true, jobId: 'job-1' });
});

test('retains the page cursor and empty candidate pages without inventing totals', async () => {
	const requests: unknown[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		return new Response(JSON.stringify({ notes: [], nextCursor: 'next-note', complete: false, errors: [], rules: [] }));
	});
	const page = await cleanupApi.preview(['rule-1', 'rule-2'], 'previous-note');
	expect(requests).toEqual([{ ruleIds: ['rule-1', 'rule-2'], afterId: 'previous-note', limit: 100, i: 'dummy-test-token' }]);
	expect(page.nextCursor).toBe('next-note');
	expect(page.complete).toBe(false);
	expect(page.notes).toEqual([]);
});

test('paginates owned clips and channel search by IDs, without using offset', async () => {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(init.body as string) });
		return new Response('[]');
	});
	await cleanupApi.clips('clip-cursor');
	await cleanupApi.channels('동명', 'channel-cursor');
	expect(calls).toEqual([
		{ url: 'https://cleanup.invalid/api/clips/list', body: { limit: 100, untilId: 'clip-cursor', i: 'dummy-test-token' } },
		{ url: 'https://cleanup.invalid/api/channels/search', body: { query: '동명', limit: 100, untilId: 'channel-cursor', i: 'dummy-test-token' } },
	]);
});

test('enabling automatic cleanup sends the explicit confirmation instead of a preview token', async () => {
	const calls: unknown[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		calls.push(JSON.parse(init.body as string));
		return new Response(JSON.stringify({ rule: { id: 'rule-1' } }));
	});
	const rule = { id: 'rule-1', name: '기록', action: 'delete' as const, condition: { type: 'age' as const, operator: 'gt' as const, seconds: 2592000 } };
	await cleanupApi.setAutomatic(rule, true, true);
	await cleanupApi.setAutomatic(rule, false);
	expect(calls).toEqual([
		{ ruleId: 'rule-1', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 2592000 }, automatic: true, confirmed: true, i: 'dummy-test-token' },
		{ ruleId: 'rule-1', action: 'delete', condition: { type: 'age', operator: 'gt', seconds: 2592000 }, automatic: false, i: 'dummy-test-token' },
	]);
});

test('creating a new rule leaves the caller draft untouched while sending the credential', async () => {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(init.body as string) });
		return new Response(JSON.stringify({ rule: { id: 'rule-1' } }), { status: 200 });
	});
	const condition = { type: 'keyword' as const, mode: 'regex' as const, value: '^고양이\\s*(?:사진|영상)$', flags: 'i', targets: ['text' as const] };
	const draft = { name: '기록', action: 'delete' as const, condition };
	await cleanupApi.save(draft);
	expect(draft).toEqual({ name: '기록', action: 'delete', condition: { type: 'keyword', mode: 'regex', value: '^고양이\\s*(?:사진|영상)$', flags: 'i', targets: ['text'] } });
	expect(Object.hasOwn(draft, 'i')).toBe(false);
	expect(draft.condition).toBe(condition);
	expect(calls).toEqual([{ url: 'https://cleanup.invalid/api/i/note-cleanup/create', body: { name: '기록', action: 'delete', condition, i: 'dummy-test-token' } }]);
});

test('updating an existing keep rule also leaves the caller draft untouched', async () => {
	const calls: unknown[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		calls.push(JSON.parse(init.body as string));
		return new Response(JSON.stringify({ rule: { id: 'rule-1' } }));
	});
	const draft = { name: '보관', action: 'keep' as const, condition: { type: 'age' as const, operator: 'gte' as const, seconds: 86400 } };
	await cleanupApi.save(draft, 'rule-1');
	expect(Object.hasOwn(draft, 'i')).toBe(false);
	expect(calls).toEqual([{ name: '보관', action: 'keep', condition: { type: 'age', operator: 'gte', seconds: 86400 }, ruleId: 'rule-1', automatic: false, i: 'dummy-test-token' }]);
});

test('조건만 저장하면 제품 이름을 보내지 않고 복제 생성은 명시한 사용자 이름이다', async () => {
	const calls: any[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ rule: { id: 'rule-1' } })); });
	const draft = { name: '고정한 내 글', defaultName: 'pinned' as const, action: 'keep' as const, condition: { type: 'flag' as const, field: 'pinned' as const, value: true } };
	await cleanupApi.save(draft, 'rule-1');
	expect(calls[0]).not.toHaveProperty('name');
	expect(calls[0]).not.toHaveProperty('defaultName');
	await cleanupApi.save(draft);
	expect(calls[1].name).toBe(draft.name);
	expect(calls[1]).not.toHaveProperty('defaultName');
	await cleanupApi.save({ ...draft, name: 'My custom name', defaultName: null }, 'rule-1');
	expect(calls[2].name).toBe('My custom name');
});
