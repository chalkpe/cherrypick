/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { Suspense, defineComponent, h, onMounted, watch } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' }, ensureSignin: () => ({ id: 'me' }) }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
const push = vi.hoisted(() => vi.fn());
vi.mock('@/router.js', () => ({ useRouter: () => ({ push }) }));
const confirm = vi.hoisted(() => vi.fn(async () => ({ canceled: true })));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/os.js', () => ({ confirm, popupMenu: vi.fn(), alert: vi.fn(async () => {}), toast }));
vi.mock('@/components/MkInput.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })]),
}) }));
vi.mock('@/components/MkSelect.vue', () => ({ default: defineComponent({
	props: ['modelValue', 'items'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('select', { value: props.modelValue, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value) }, (props.items ?? []).map((item: { value: string; label: string }) => h('option', { value: item.value }, item.label)))]),
}) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: defineComponent({
	props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('button', {
		role: 'switch', 'aria-checked': props.modelValue ? 'true' : 'false', disabled: props.disabled,
		onClick: () => { if (!props.disabled) emit('update:modelValue', !props.modelValue); },
	}, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
// 미리 보기 자체는 별도 시험에서 다루므로 여기서는 버전 전달만 관찰한다. 준비 상태는 항상 성공으로 본다.
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({
	props: ['ruleId', 'version'], emits: ['ready'],
	setup: (props, { emit }) => {
		onMounted(() => emit('ready', true));
		watch(() => props.version, () => emit('ready', true));
		return () => h('div', { 'data-testid': 'preview', 'data-version': props.version, 'data-rule-id': props.ruleId });
	},
}) }));
vi.mock('@/pages/settings/note-cleanup/ConditionEditor.vue', () => ({ default: defineComponent({
	props: ['condition'], emits: ['change'],
	setup: (_, { emit }) => () => h('button', { onClick: () => emit('change', [], { type: 'keyword', mode: 'literal', value: '고양이', flags: '', targets: ['text', 'cw', 'poll'] }) }, 'Enter condition'),
}) }));
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import EditPage from '@/pages/settings/note-cleanup.edit.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); confirm.mockReset(); confirm.mockResolvedValue({ canceled: true }); toast.mockClear(); push.mockClear(); });

const baseRule: CleanupRule = {
	id: 'delete', name: 'Old notes', defaultName: null, action: 'delete', enabled: true,
	automatic: false, automaticConfirmed: false, condition: { type: 'age', seconds: 60, operator: 'gte' },
	legacy: null, lastError: null,
};

// 서버 상태를 모형으로 유지해 저장·켜기·자동 전환 뒤 재조회가 최신 규칙을 돌려주게 한다.
function renderEdit(initial: CleanupRule = baseRule) {
	let serverRule = { ...initial };
	const requests: { url: string; body: any }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const body = init?.body ? JSON.parse(init.body as string) : {};
		requests.push({ url, body });
		if (url.endsWith('/list')) return new Response(JSON.stringify({ rules: [serverRule], blocked: false }));
		if (url.endsWith('/update')) {
			serverRule = { ...serverRule, ...body, id: serverRule.id, automaticConfirmed: serverRule.automaticConfirmed || body.automatic === true };
			delete (serverRule as Record<string, unknown>).ruleId;
			delete (serverRule as Record<string, unknown>).i;
			delete (serverRule as Record<string, unknown>).confirmed;
			return new Response(JSON.stringify({ rule: serverRule }));
		}
		if (url.endsWith('/request')) return new Response(JSON.stringify({ queued: true, jobId: 'job-1' }));
		return new Response(JSON.stringify({}));
	});
	const Host = defineComponent({ setup: () => () => h('div', [h(Suspense, null, { default: () => h(EditPage, { ruleId: initial.id }), fallback: () => h('div', 'loading') })]) });
	const view = render(Host);
	return { view, requests, serverRule: () => serverRule };
}

const version = (view: ReturnType<typeof render>) => Number(view.getByTestId('preview').getAttribute('data-version'));

test('saving refreshes the rule list, bumps the preview once and re-enables the run section', async () => {
	const { view, requests } = renderEdit();
	await view.findByLabelText('Rule name');
	expect(version(view)).toBe(0);
	expect(view.container.querySelector('fieldset')?.disabled).toBe(false);
	await fireEvent.update(view.getByLabelText('Rule name'), 'Renamed rule');
	await waitFor(() => expect(view.container.querySelector('fieldset')?.disabled).toBe(true));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(version(view)).toBe(1));
	expect(view.container.querySelector('fieldset')?.disabled).toBe(false);
	expect((view.getByLabelText('Rule name') as HTMLInputElement).value).toBe('Renamed rule');
	expect(toast).toHaveBeenCalledWith('Saved');
	// 저장 뒤 재조회가 실행 설정 구획을 새 규칙 기준으로 다시 그린다.
	const mutationIndex = requests.findIndex(request => request.url.endsWith('/update'));
	expect(mutationIndex).toBeGreaterThan(-1);
	expect(requests.slice(mutationIndex + 1).some(request => request.url.endsWith('/list'))).toBe(true);
	expect(requests.filter(request => request.url.endsWith('/list'))).toHaveLength(2);
});

test('canceling the enable confirmation keeps the preview; confirming refreshes it', async () => {
	const { view, requests } = renderEdit();
	await view.findByLabelText('Rule name');
	await fireEvent.click(view.getByRole('button', { name: 'Turn off' }));
	await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
	expect(version(view)).toBe(0);
	expect(requests.filter(request => request.url.endsWith('/update'))).toHaveLength(0);
	confirm.mockResolvedValue({ canceled: false });
	await fireEvent.click(view.getByRole('button', { name: 'Turn off' }));
	await waitFor(() => expect(version(view)).toBe(1));
	expect(requests.find(request => request.url.endsWith('/update'))!.body).toMatchObject({ enabled: false, confirmed: true });
	await fireEvent.click(view.getByRole('button', { name: 'Turn on' }));
	await waitFor(() => expect(version(view)).toBe(2));
	expect(requests.filter(request => request.url.endsWith('/update')).at(-1)!.body).toMatchObject({ enabled: true, confirmed: true });
});

test('automatic cleanup refreshes the preview only after the server accepts the change', async () => {
	const { view, requests } = renderEdit();
	await view.findByLabelText('Rule name');
	const toggle = () => view.getByRole('switch', { name: 'Keep cleaning up automatically' });
	await fireEvent.click(toggle());
	await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
	expect(version(view)).toBe(0);
	expect(toggle().getAttribute('aria-checked')).toBe('false');
	confirm.mockResolvedValue({ canceled: false });
	await fireEvent.click(toggle());
	await waitFor(() => expect(version(view)).toBe(1));
	expect(toggle().getAttribute('aria-checked')).toBe('true');
	expect(requests.find(request => request.url.endsWith('/update'))!.body).toMatchObject({ automatic: true, confirmed: true });
	// 끄기는 확인창 없이 바로 반영하고 미리 보기를 다시 읽는다.
	await fireEvent.click(toggle());
	await waitFor(() => expect(version(view)).toBe(2));
	expect(confirm).toHaveBeenCalledTimes(2);
	expect(toggle().getAttribute('aria-checked')).toBe('false');
	expect(requests.filter(request => request.url.endsWith('/update')).at(-1)!.body.automatic).toBe(false);
});

test('a rejected save keeps the preview version and the draft until a later save succeeds', async () => {
	const { view } = renderEdit();
	await view.findByLabelText('Rule name');
	let failUpdate = true;
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const body = init?.body ? JSON.parse(init.body as string) : {};
		if (url.endsWith('/list')) return new Response(JSON.stringify({ rules: [{ ...baseRule, name: failUpdate ? 'Old notes' : body.name ?? 'Old notes' }], blocked: false }));
		if (url.endsWith('/update') && failUpdate) return new Response(JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code: 'INVALID_CONDITION', path: 'condition' } } }), { status: 400 });
		if (url.endsWith('/update')) return new Response(JSON.stringify({ rule: { ...baseRule, name: body.name } }));
		return new Response(JSON.stringify({}));
	});
	await fireEvent.update(view.getByLabelText('Rule name'), 'Rejected draft');
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await view.findByText('Check the highlighted condition and correct its settings.');
	expect(version(view)).toBe(0);
	expect((view.getByLabelText('Rule name') as HTMLInputElement).value).toBe('Rejected draft');
	expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
	failUpdate = false;
	await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(version(view)).toBe(1));
	expect(view.queryByText('Check the highlighted condition and correct its settings.')).toBeNull();
	expect(view.container.querySelector('fieldset')?.disabled).toBe(false);
});

test('manual cleanup reports acceptance without resetting the preview', async () => {
	const { view, requests } = renderEdit();
	await view.findByLabelText('Rule name');
	await fireEvent.click(view.getByRole('button', { name: 'Clean up now' }));
	await waitFor(() => expect(toast).toHaveBeenCalledWith('Cleanup started.'));
	expect(version(view)).toBe(0);
	expect(requests.filter(request => request.url.endsWith('/update'))).toHaveLength(0);
	expect(requests.filter(request => request.url.endsWith('/request'))).toHaveLength(1);
});
