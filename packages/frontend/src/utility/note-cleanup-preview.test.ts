/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' } }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
 props: ['disabled'], emits: ['click'],
 setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
const confirm = vi.hoisted(() => vi.fn(async () => ({ canceled: true })));
vi.mock('@/os.js', () => ({ confirm, popupMenu: vi.fn() }));
vi.mock('@/components/MkInput.vue', () => ({ default: defineComponent({
 props: ['modelValue'], emits: ['update:modelValue'],
 setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })]),
}) }));
vi.mock('@/components/MkSelect.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/pages/settings/note-cleanup/ConditionEditor.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import RuleEditor from '@/pages/settings/note-cleanup/RuleEditor.vue';
import Preview from '@/pages/settings/note-cleanup/Preview.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); confirm.mockReset(); confirm.mockResolvedValue({ canceled: true }); });

const page = {
 rules: [{ id: 'keep', name: 'Favorites', action: 'keep' }, { id: 'delete', name: 'Old notes', action: 'delete' }],
 items: [
  { noteId: 'conflict', text: 'both rules', cw: null, createdAt: '2026-01-01T00:00:00.000Z', deleteRuleIds: ['delete'], keepRuleIds: ['keep'], decision: 'keep', reason: 'protected' },
  { noteId: 'keep-only', text: 'keep only', cw: null, createdAt: '2026-01-02T00:00:00.000Z', deleteRuleIds: [], keepRuleIds: ['keep'], decision: 'keep', reason: 'protected' },
 ],
 scanned: 2, deleteCount: 0, protectedCount: 2, nextCursor: null, complete: true, errors: [], previewToken: 'first',
};

test('distinguishes conflicting protection from a keep-only match and includes creation time', async () => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify(page)));
 const view = render(Preview, { props: { ruleIds: ['delete'] } });
 await fireEvent.click(view.getByRole('button'));
 await view.findByText('Kept: keep rules take priority over matching delete rules');
 expect(view.getByText('Protected by keep rule')).toBeTruthy();
 expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
});

test('failed refresh removes the old preview and invalidates its automatic confirmation token', async () => {
 let calls = 0;
 vi.stubGlobal('fetch', async () => ++calls === 1 ? new Response(JSON.stringify(page)) : new Response(JSON.stringify({ error: { code: 'CLEANUP_BUSY' } }), { status: 400 }));
 const onInvalidated = vi.fn();
 const view = render(Preview, { props: { ruleIds: ['delete'], onInvalidated } });
 await fireEvent.click(view.getByRole('button'));
 await view.findByText('both rules');
 await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
 await waitFor(() => expect(view.queryByText('both rules')).toBeNull());
 expect(onInvalidated).toHaveBeenCalled();
});

test('last page with a leftover cursor offers no next page and sends no extra preview request', async () => {
 const requests: unknown[] = [];
 vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
  requests.push(JSON.parse(init.body as string));
  return new Response(JSON.stringify({ ...page, nextCursor: 'stale-cursor', complete: true }));
 });
 const view = render(Preview, { props: { ruleIds: ['delete'] } });
 await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
 await view.findByText('both rules');
 expect(view.getByText('End of this pass. Results can change as note state changes.')).toBeTruthy();
 expect(view.queryByRole('button', { name: 'Next inspected page' })).toBeNull();
 expect(requests).toHaveLength(1);
});

test('next page requests the cursor and invalidates the previous page and its confirmation token first', async () => {
 const requests: { afterId?: string }[] = [];
 vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string);
  requests.push(body);
  return new Response(JSON.stringify(body.afterId
   ? { ...page, items: [{ ...page.items[1], noteId: 'second', text: 'second page' }], previewToken: 'second' }
   : { ...page, nextCursor: 'cursor-1', complete: false }));
 });
 const onInvalidated = vi.fn();
 const onLoaded = vi.fn();
 const view = render(Preview, { props: { ruleIds: ['delete'], onInvalidated, onLoaded } });
 await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
 await view.findByText('both rules');
 const invalidatedBefore = onInvalidated.mock.calls.length;
 await fireEvent.click(view.getByRole('button', { name: 'Next inspected page' }));
 await view.findByText('second page');
 expect(view.queryByText('both rules')).toBeNull();
 expect(onInvalidated.mock.calls.length).toBeGreaterThan(invalidatedBefore);
 expect(requests.map(r => r.afterId)).toEqual([undefined, 'cursor-1']);
 expect(onLoaded).toHaveBeenLastCalledWith(expect.objectContaining({ previewToken: 'second' }));
});

test('발동 규칙도 제품 이름을 번역하고 사용자 이름을 그대로 표시한다', async () => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...page, rules: [{ id: 'keep', name: '내가 즐겨찾기한 내 글', defaultName: 'favorite', action: 'keep' }, { id: 'delete', name: '내 사용자 문구', defaultName: null, action: 'delete' }] })));
 const view = render(Preview, { props: { ruleIds: ['delete'] } });
 await fireEvent.click(view.getByRole('button'));
 await waitFor(() => expect(view.container.textContent).toContain('My favorited notes'));
 expect(view.container.textContent).toContain('내 사용자 문구');
});

test.each([{ code: 'CLEANUP_BUSY' }, { code: 'INVALID_CLEANUP', info: { code: 'CLEANUP_BUSY' } }])('503 busy response offers retry guidance', async error => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error }), { status: 503 }));
 const view = render(Preview, { props: { ruleIds: ['delete'] } });
 await fireEvent.click(view.getByRole('button'));
 await view.findByText('Note cleanup is busy. Please wait a moment and try again.');
 expect(view.getByRole('button', { name: 'Preview saved rules' }).hasAttribute('disabled')).toBe(false);
 expect(view.container.textContent).not.toMatch(/CLEANUP_BUSY|INVALID_CLEANUP|invalid input/i);
});
test('preview explains missing references without diagnostic fields', async () => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...page, errors: [{ ruleId: 'keep', code: 'MISSING_CHANNEL', path: 'condition.children.0', referenceId: 'secret-ref' }] })));
 const view = render(Preview, { props: { ruleIds: ['delete'] } });
 await fireEvent.click(view.getByRole('button'));
 await view.findByText('A selected channel is unavailable. Choose another channel or change this condition.');
 expect(view.container.textContent).not.toMatch(/MISSING_CHANNEL|condition.children.0|secret-ref/);
});

test.each(['keep', 'delete'])('미리 보기는 %s 임시 오류의 실제 영향을 안내한다', async action => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...page, errors: [{ ruleId: action, code: 'TEMPORARY_FAILURE', path: 'condition' }] })));
 const view = render(Preview, { props: { ruleIds: ['delete'] } });
 await fireEvent.click(view.getByRole('button'));
 await view.findByText(action === 'keep' ? 'Temporarily unable to check keep rules. New deletions are paused for safety. Try again later.' : 'Temporarily unable to check this delete rule. It is excluded; other delete rules can still apply. Try again later.');
});

// 선택 변경도 이전 결과와 진행 중인 응답을 무효화한다.
test('selection changes discard a pending preview before the next result', async () => {
 let finish!: (response: Response) => void;
 let calls = 0;
 vi.stubGlobal('fetch', async () => ++calls === 1
  ? new Promise<Response>(resolve => { finish = resolve; })
  : new Response(JSON.stringify(page)));
 const onLoaded = vi.fn();
 const view = render(Preview, { props: { ruleIds: ['old'], onLoaded } });
 await fireEvent.click(view.getByRole('button'));
 await view.rerender({ ruleIds: ['delete'] });
 finish(new Response(JSON.stringify(page)));
 await waitFor(() => expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
 expect(view.queryByText('both rules')).toBeNull();
 expect(onLoaded).not.toHaveBeenCalled();
 await fireEvent.click(view.getByRole('button'));
 await view.findByText('both rules');
 expect(onLoaded).toHaveBeenCalledTimes(1);
});

const deleteRule: CleanupRule = {
 id: 'delete', name: 'Old notes', defaultName: null, action: 'delete', enabled: true,
 automatic: false, automaticConfirmed: false, condition: { type: 'age', seconds: 60, operator: 'gte' },
 legacy: null, lastError: null,
};

test('inactive delete editor blocks the real preview transport without enabling or requesting cleanup', async () => {
 const requests: string[] = [];
 vi.stubGlobal('fetch', async (url: string) => {
  requests.push(url);
  return new Response(JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code: 'INVALID_RULE_SELECTION', path: 'ruleIds' } } }), { status: 400 });
 });
 const view = render(RuleEditor, { props: { rule: { ...deleteRule, enabled: false } } });
 const preview = view.getByRole('button', { name: 'Preview saved rules' });

 expect.soft((preview as HTMLButtonElement).disabled).toBe(true);
 await fireEvent.click(preview);

 expect.soft(requests).toEqual([]);
 expect.soft((preview as HTMLButtonElement).disabled).toBe(true);
 expect(view.getByText('Disabled', { exact: true })).toBeTruthy();
});

test('active delete editor previews through the real transport and dirty drafts cannot preview', async () => {
 const requests: { url: string; body: unknown }[] = [];
 vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  requests.push({ url, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify(page));
 });
 const view = render(RuleEditor, { props: { rule: deleteRule } });

 await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
 await view.findByText('both rules');

 expect(requests).toEqual([{ url: 'https://cleanup.invalid/api/i/note-cleanup/preview', body: { ruleIds: ['delete'], limit: 100, i: 'dummy-test-token' } }]);
 await fireEvent.update(view.getByLabelText('Rule name'), 'Changed draft');
 expect(view.queryByRole('button', { name: 'Preview saved rules' })).toBeNull();
 expect(requests).toHaveLength(1);
});

test('first automatic cleanup still previews first and waits for explicit confirmation before updating', async () => {
 const requests: { url: string; body: unknown }[] = [];
 vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  requests.push({ url, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify(url.endsWith('/preview') ? page : { rule: deleteRule }));
 });
 const view = render(RuleEditor, { props: { rule: deleteRule } });

 await fireEvent.click(view.getByRole('checkbox', { name: 'Keep cleaning up automatically' }));
 await view.findByText('both rules');

 expect(requests.map(request => request.url)).toEqual(['https://cleanup.invalid/api/i/note-cleanup/preview']);
 await fireEvent.click(view.getByRole('button', { name: 'Keep cleaning up automatically' }));
 expect(requests).toHaveLength(1);
 confirm.mockResolvedValue({ canceled: false });
 await fireEvent.click(view.getByRole('button', { name: 'Keep cleaning up automatically' }));
 await waitFor(() => expect(requests).toHaveLength(2));
 expect(requests[1]).toEqual({ url: 'https://cleanup.invalid/api/i/note-cleanup/update', body: {
  ruleId: 'delete', action: 'delete', condition: { type: 'age', seconds: 60, operator: 'gte' }, automatic: true, previewToken: 'first', i: 'dummy-test-token',
 } });
 expect(requests.some(request => request.url.endsWith('/request'))).toBe(false);
});
