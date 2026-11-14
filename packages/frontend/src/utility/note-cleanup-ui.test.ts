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
// 언어별 문구를 확인하도록 호출 시점의 locale을 바꿀 수 있게 한다.
const activeLocale = vi.hoisted(() => ({ current: 'en-US' as 'en-US' | 'ko-KR' | 'ja-JP' }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	const instances = { 'en-US': new I18n(locales['en-US'], false), 'ko-KR': new I18n(locales['ko-KR'], false), 'ja-JP': new I18n(locales['ja-JP'], false) };
	return { i18n: { get ts() { return instances[activeLocale.current].ts; }, get tsx() { return instances[activeLocale.current].tsx; } } };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
const push = vi.hoisted(() => vi.fn());
vi.mock('@/router.js', () => ({ useRouter: () => ({ push }) }));
const popupMenu = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => {}));
const confirm = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => ({ canceled: true })));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/os.js', () => ({ alert, confirm, popupMenu, toast }));
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
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.()),
}) }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: defineComponent({
	props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('button', {
		role: 'switch', 'aria-checked': props.modelValue ? 'true' : 'false', disabled: props.disabled,
		onClick: () => { if (!props.disabled) emit('update:modelValue', !props.modelValue); },
	}, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
// 미리 보기 준비 상태는 시험에서 제어한다. 실제 준비 판정은 미리 보기 전용 시험에서 다룬다.
const previewControl = vi.hoisted(() => ({ ready: true, emit: null as null | ((value: boolean) => void) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({
	props: ['ruleId', 'version'], emits: ['ready'],
	setup: (props, { emit }) => {
		previewControl.emit = (value: boolean) => emit('ready', value);
		onMounted(() => emit('ready', previewControl.ready));
		watch(() => props.version, () => emit('ready', previewControl.ready));
		return () => h('div', { 'data-testid': 'preview', 'data-version': props.version });
	},
}) }));
vi.mock('@/pages/settings/note-cleanup/ConditionEditor.vue', () => ({ default: defineComponent({
	props: ['condition'], emits: ['change'],
	setup: (props, { emit }) => () => h('div', [
		h('button', { onClick: () => emit('change', [], { type: 'keyword', mode: 'literal', value: '고양이\n강아지', flags: '', targets: ['text', 'cw', 'poll'] }) }, 'Enter condition'),
		h('button', { onClick: () => emit('change', [], { type: 'all', children: [{ type: 'keyword', mode: 'regex', value: '[', flags: '', targets: ['text'] }] }) }, 'Enter bad regex'),
		h('pre', { 'data-testid': 'condition' }, JSON.stringify(props.condition)),
	]),
}) }));
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import EditPage from '@/pages/settings/note-cleanup.edit.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); popupMenu.mockReset(); confirm.mockReset(); confirm.mockResolvedValue({ canceled: true }); alert.mockClear(); toast.mockClear(); push.mockClear(); activeLocale.current = 'en-US'; previewControl.ready = true; previewControl.emit = null; });

const deleteRule: CleanupRule = {
	id: 'delete', name: 'Old notes', defaultName: null, action: 'delete', enabled: true,
	automatic: false, automaticConfirmed: false, condition: { type: 'age', seconds: 60, operator: 'gte' },
	legacy: null, lastError: null,
};

function renderEdit(props: { ruleId?: string; action?: string } = {}, rules: CleanupRule[] = [deleteRule]) {
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const body = init?.body ? JSON.parse(init.body as string) : {};
		if (url.endsWith('/list')) return new Response(JSON.stringify({ rules, blocked: false }));
		if (url.endsWith('/create')) return new Response(JSON.stringify({ rule: { ...deleteRule, id: 'created', name: body.name } }));
		if (url.endsWith('/update')) return new Response(JSON.stringify({ rule: { ...deleteRule, ...body, id: body.ruleId } }));
		if (url.endsWith('/request')) return new Response(JSON.stringify({ queued: true, jobId: 'job-1' }));
		if (url.endsWith('/delete')) return new Response(JSON.stringify({}));
		return new Response(JSON.stringify({}));
	});
	const Host = defineComponent({ setup: () => () => h('div', [h(Suspense, null, { default: () => h(EditPage, props), fallback: () => h('div', 'loading') })]) });
	return render(Host);
}

test('saving an incomplete draft sends no request; a complete draft reaches create and opens the new rule', async () => {
	const view = renderEdit({ action: 'delete' });
	await view.findByLabelText('Rule name');
	const requests: string[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		requests.push(url);
		const body = init?.body ? JSON.parse(init.body as string) : {};
		if (url.endsWith('/create')) return new Response(JSON.stringify({ rule: { ...deleteRule, id: 'created', name: body.name } }));
		return new Response(JSON.stringify({ rules: [], blocked: false }));
	});
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	expect(requests).toHaveLength(0);
	await fireEvent.update(view.getByLabelText('Rule name'), '기록');
	await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(push).toHaveBeenCalledWith('/settings/note-cleanup/:ruleId', { params: { ruleId: 'created' } }));
	expect(requests.filter(url => url.endsWith('/create'))).toHaveLength(1);
});

test('create screen starts with the action from the query and no run section', async () => {
	const view = renderEdit({ action: 'keep' });
	await view.findByLabelText('Rule name');
	expect((view.getByLabelText('Rule action') as HTMLSelectElement).value).toBe('keep');
	expect(view.queryByTestId('preview')).toBeNull();
	expect(view.queryByRole('button', { name: 'Turn on' })).toBeNull();
	expect(view.queryByRole('button', { name: 'Delete' })).toBeNull();
});

test('server rejection retains the draft and explains the invalid condition without diagnostic paths', async () => {
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	vi.stubGlobal('fetch', async (url: string) => url.endsWith('/list')
		? new Response(JSON.stringify({ rules: [deleteRule], blocked: false }))
		: new Response(JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code: 'INVALID_CONDITION', path: 'condition.children.0' } } }), { status: 400 }));
	await fireEvent.update(view.getByLabelText('Rule name'), '실패해도 보존');
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await view.findByText('Check the highlighted condition and correct its settings.');
	expect((view.getByLabelText('Rule name') as HTMLInputElement).value).toBe('실패해도 보존');
	expect(view.container.textContent).not.toMatch(/INVALID_CONDITION|condition.children.0/);
});

test('잘못된 정규식은 중첩 조건에서도 대화상자를 띄우고 저장하지 않는다', async () => {
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/list') ? { rules: [deleteRule], blocked: false } : { rule: deleteRule })));
	vi.stubGlobal('fetch', fetchMock);
	await fireEvent.click(view.getByRole('button', { name: 'Enter bad regex' }));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	expect(alert.mock.calls[0][0]).toMatchObject({ type: 'error', title: 'Regular Expression error' });
	expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/update'))).toHaveLength(0);
});

test.each([
	{ action: 'delete', enabled: true, button: 'Turn off', title: 'Turn off the rule "Old notes"?', body: 'This rule will no longer delete notes.', ok: 'Turn off' },
	{ action: 'delete', enabled: false, button: 'Turn on', title: 'Turn on the rule "Old notes"?', body: 'Notes matching this rule can be deleted again.', ok: 'Turn on' },
	{ action: 'keep', enabled: true, button: 'Turn off', title: 'Turn off the rule "Old notes"?', body: 'Notes protected by this rule may be deleted.', ok: 'Turn off' },
	{ action: 'keep', enabled: false, button: 'Turn on', title: 'Turn on the rule "Old notes"?', body: 'Notes matching this rule will not be deleted.', ok: 'Turn on' },
] as const)('$action $enabled confirmation uses the right title, body and ok label', async ({ action, enabled, button, title, body, ok }) => {
	const rule = { ...deleteRule, action, enabled } as CleanupRule;
	const view = renderEdit({ ruleId: 'delete' }, [rule]);
	await view.findByLabelText('Rule name');
	const requests: { url: string; body: any }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : {} });
		return new Response(JSON.stringify(url.endsWith('/list') ? { rules: [rule], blocked: false } : { rule: { ...rule, enabled: !enabled } }));
	});
	await fireEvent.click(view.getByRole('button', { name: button }));
	expect(confirm).toHaveBeenCalledTimes(1);
	expect(confirm.mock.calls[0][0]).toMatchObject({ title, text: body, okText: ok });
	// 취소하면 아무 요청도 보내지 않는다.
	await waitFor(() => expect(requests.filter(request => request.url.endsWith('/update'))).toHaveLength(0));
	confirm.mockResolvedValue({ canceled: false });
	await fireEvent.click(view.getByRole('button', { name: button }));
	await waitFor(() => expect(requests.filter(request => request.url.endsWith('/update'))).toHaveLength(1));
	expect(requests.find(request => request.url.endsWith('/update'))!.body).toMatchObject({ ruleId: 'delete', enabled: !enabled, confirmed: true });
});

test('first automatic cleanup waits for explicit confirmation and sends confirmed instead of a preview token', async () => {
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	const requests: { url: string; body: any }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : {} });
		return new Response(JSON.stringify(url.endsWith('/list') ? { rules: [deleteRule], blocked: false } : { rule: { ...deleteRule, automatic: true, automaticConfirmed: true } }));
	});
	const toggle = view.getByRole('switch', { name: 'Keep cleaning up automatically' });
	await fireEvent.click(toggle);
	expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Keep cleaning up?', text: 'Existing notes will be deleted too, and matching notes will keep being deleted.' });
	await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
	expect(requests.filter(request => request.url.endsWith('/update'))).toHaveLength(0);
	confirm.mockResolvedValue({ canceled: false });
	await fireEvent.click(toggle);
	await waitFor(() => expect(requests.filter(request => request.url.endsWith('/update'))).toHaveLength(1));
	expect(requests.find(request => request.url.endsWith('/update'))!.body).toEqual({
		ruleId: 'delete', action: 'delete', condition: deleteRule.condition, automatic: true, confirmed: true, i: 'dummy-test-token',
	});
	expect(requests.some(request => request.url.endsWith('/request'))).toBe(false);
	await waitFor(() => expect(view.getByRole('switch', { name: 'Keep cleaning up automatically' }).getAttribute('aria-checked')).toBe('true'));
});

test('first automatic cleanup stays blocked until the current preview succeeds', async () => {
	previewControl.ready = false;
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	const toggle = () => view.getByRole('switch', { name: 'Keep cleaning up automatically' });
	// 미리 보기가 로딩 중이거나 실패한 상태에서는 최초 자동 켜기가 불가능하다.
	expect((toggle() as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.click(toggle());
	expect(confirm).not.toHaveBeenCalled();
	// 현재 미리 보기가 성공하면 기존 확인창 하나로 켤 수 있다.
	previewControl.emit!(true);
	await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
	confirm.mockResolvedValue({ canceled: false });
	await fireEvent.click(toggle());
	await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
});

test('a new save blocks first automatic cleanup again until the preview reloads successfully', async () => {
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	const toggle = () => view.getByRole('switch', { name: 'Keep cleaning up automatically' });
	await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
	// 저장으로 미리 보기가 무효화되면 준비 상태가 사라지고 다시 막힌다.
	previewControl.ready = false;
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	// 저장이 끝나 미리 보기 버전이 오른 뒤 준비 상태를 다시 보낸다.
	await waitFor(() => expect(view.getByTestId('preview').getAttribute('data-version')).toBe('1'));
	await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(true));
	previewControl.emit!(true);
	await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
});

test('already confirmed rules toggle automatic without waiting for the preview', async () => {
	previewControl.ready = false;
	const confirmed = { ...deleteRule, automatic: true, automaticConfirmed: true };
	const view = renderEdit({ ruleId: 'delete' }, [confirmed]);
	await view.findByLabelText('Rule name');
	const toggle = () => view.getByRole('switch', { name: 'Keep cleaning up automatically' });
	expect((toggle() as HTMLButtonElement).disabled).toBe(false);
	await fireEvent.click(toggle());
	await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
	expect(confirm).not.toHaveBeenCalled();
});

test('manual cleanup reports queued and duplicate requests through toasts', async () => {
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	let queued = true;
	vi.stubGlobal('fetch', async (url: string) => {
		if (url.endsWith('/list')) return new Response(JSON.stringify({ rules: [deleteRule], blocked: false }));
		if (url.endsWith('/request')) return new Response(JSON.stringify({ queued, jobId: 'job-1' }));
		return new Response(JSON.stringify({ rule: deleteRule }));
	});
	await fireEvent.click(view.getByRole('button', { name: 'Clean up now' }));
	await waitFor(() => expect(toast).toHaveBeenCalledWith('Cleanup started.'));
	queued = false;
	await fireEvent.click(view.getByRole('button', { name: 'Clean up now' }));
	await waitFor(() => expect(toast).toHaveBeenCalledWith('No new work was queued this time.'));
});

test('disabled rules cannot request cleanup and dirty drafts disable the whole run section', async () => {
	const rule = { ...deleteRule, enabled: false };
	const view = renderEdit({ ruleId: 'delete' }, [rule]);
	await view.findByLabelText('Rule name');
	expect((view.getByRole('button', { name: 'Clean up now' }) as HTMLButtonElement).disabled).toBe(true);
	expect((view.getByRole('switch', { name: 'Keep cleaning up automatically' }) as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.update(view.getByLabelText('Rule name'), 'Changed draft');
	await waitFor(() => expect(view.container.querySelector('fieldset')?.disabled).toBe(true));
	// 더러운 초안에서는 켜기끄기도 막지만 삭제는 확인창으로 가능하다.
	expect((view.getByRole('button', { name: 'Turn on' }) as HTMLButtonElement).disabled).toBe(true);
	expect((view.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
});

test('deleting a rule confirms once and returns to the list', async () => {
	const view = renderEdit({ ruleId: 'delete' });
	await view.findByLabelText('Rule name');
	const requests: string[] = [];
	vi.stubGlobal('fetch', async (url: string) => {
		requests.push(url);
		return new Response(JSON.stringify(url.endsWith('/list') ? { rules: [deleteRule], blocked: false } : {}));
	});
	await fireEvent.click(view.getByRole('button', { name: 'Delete' }));
	expect(confirm.mock.calls[0][0]).toMatchObject({ text: 'Delete this rule?' });
	await waitFor(() => expect(requests.filter(url => url.endsWith('/i/note-cleanup/delete'))).toHaveLength(0));
	confirm.mockResolvedValue({ canceled: false });
	await fireEvent.click(view.getByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(push).toHaveBeenCalledWith('/settings/note-cleanup'));
	expect(requests.filter(url => url.endsWith('/i/note-cleanup/delete'))).toHaveLength(1);
});

test('기본 이름은 세 언어를 따르고 조건만 저장할 때 이름을 명시하지 않는다', async () => {
	const rule = { ...deleteRule, id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep' } as CleanupRule;
	for (const [language, label] of [['en-US', 'My pinned notes'], ['ko-KR', '고정한 내 글'], ['ja-JP', 'ピン留めした自分のノート']] as const) {
		activeLocale.current = language;
		const view = renderEdit({ ruleId: 'default' }, [rule]);
		await waitFor(() => expect(view.container.querySelector('input')).toBeTruthy());
		expect((view.container.querySelector('input') as HTMLInputElement).value).toBe(label);
		const calls: any[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : {} });
			return new Response(JSON.stringify(url.endsWith('/list') ? { rules: [rule], blocked: false } : { rule }));
		});
		await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
		await fireEvent.click(view.getByRole('button', { name: language === 'en-US' ? 'Save' : language === 'ko-KR' ? '저장' : '保存' }));
		await waitFor(() => expect(calls.some(call => call.url.endsWith('/update'))).toBe(true));
		expect(calls.find(call => call.url.endsWith('/update'))!.body).not.toHaveProperty('name');
		cleanup();
	}
});

test('기본 문구와 같은 사용자 입력도 명시 이름으로 저장한다', async () => {
	const rule = { ...deleteRule, id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep' } as CleanupRule;
	const view = renderEdit({ ruleId: 'default' }, [rule]);
	await view.findByLabelText('Rule name');
	const calls: any[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : {} });
		return new Response(JSON.stringify(url.endsWith('/list') ? { rules: [rule], blocked: false } : { rule }));
	});
	await fireEvent.update(view.getByLabelText('Rule name'), '고정한 내 글');
	await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(calls.some(call => call.url.endsWith('/update'))).toBe(true));
	expect(calls.find(call => call.url.endsWith('/update'))!.body.name).toBe('고정한 내 글');
});

test('keep rules hide the run section even when saved', async () => {
	const rule = { ...deleteRule, action: 'keep' } as CleanupRule;
	const view = renderEdit({ ruleId: 'delete' }, [rule]);
	await view.findByLabelText('Rule name');
	expect(view.queryByTestId('preview')).toBeNull();
	expect(view.queryByRole('switch', { name: 'Keep cleaning up automatically' })).toBeNull();
	expect(view.queryByRole('button', { name: 'Clean up now' })).toBeNull();
});

test('stored rule errors show one result sentence with a reveal button only for condition paths', async () => {
	const rule = { ...deleteRule, lastError: { ruleId: 'delete', code: 'MISSING_CLIP', path: 'condition.children.0', message: 'MISSING_CLIP', referenceId: 'secret' } } as CleanupRule;
	const view = renderEdit({ ruleId: 'delete' }, [rule]);
	await view.findByText('A selected clip is unavailable. Choose another clip or change this condition.');
	expect(view.getByRole('button', { name: 'Edit' })).toBeTruthy();
	expect(view.container.textContent).not.toMatch(/MISSING_CLIP|secret|condition.children.0/);
});
