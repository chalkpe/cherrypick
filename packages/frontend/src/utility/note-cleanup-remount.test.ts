/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { Suspense, defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' }, ensureSignin: () => ({ id: 'me' }) }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locale = load(readFileSync('../../locales/en-US.yml', 'utf8')) as Locale;
	return { i18n: new I18n(locale, false) };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// 실제 선택기는 메뉴를 os.popupMenu로 띄우므로, 메뉴 항목을 가로채 직접 실행한다.
const menuCalls = vi.hoisted(() => [] as { items: { text?: string; action?: () => void }[] }[]);
vi.mock('@/os.js', () => ({
	alert: vi.fn(async () => {}),
	confirm: vi.fn(async () => ({ canceled: true })),
	toast: vi.fn(),
	popupMenu: vi.fn((items: { text?: string; action?: () => void }[]) => { menuCalls.push({ items }); }),
}));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/components/MkFolder.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', [slots.label?.(), slots.default?.()]) }) }));
vi.mock('@/pages/settings/note-cleanup/ReferencePicker.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import EditPage from '@/pages/settings/note-cleanup.edit.vue';

// 실제 MkInput·MkSelect·MkTextarea·MkSwitch·MkDraggable을 그대로 렌더링해 노드 정체성을 측정한다.
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); menuCalls.length = 0; });

const base: CleanupRule = {
	id: 'r', name: 'Rule', defaultName: null, action: 'delete', enabled: false, automatic: false, automaticConfirmed: false, legacy: null, lastError: null,
	condition: { type: 'keyword', mode: 'literal', value: 'seed', flags: '', targets: ['text'] },
};

function renderEdit(rule: CleanupRule) {
	const requests: { url: string; body: any }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const body = init?.body ? JSON.parse(init.body as string) : {};
		requests.push({ url, body });
		if (url.endsWith('/list')) return new Response(JSON.stringify({ rules: [rule], blocked: false }));
		return new Response(JSON.stringify({ rule: { ...rule, ...body, id: rule.id } }));
	});
	const Host = defineComponent({ setup: () => () => h('div', [h(Suspense, null, { default: () => h(EditPage, { ruleId: rule.id }), fallback: () => h('div', 'loading') })]) });
	const view = render(Host, { global: { directives: { 'adaptive-border': {}, panel: {}, tooltip: {} }, stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } } } });
	return { view, requests };
}

const mark = (el: Element, token: string) => el.setAttribute('data-cr-mark', token);
const intact = (el: Element, token: string) => el.isConnected && el.getAttribute('data-cr-mark') === token;
const sectionOf = (container: Element, path: string) => container.querySelector(`[data-condition-path="${path}"]`) as HTMLElement;

async function selectOption(scope: HTMLElement, ariaLabel: string, optionText: string) {
	const trigger = scope.querySelector(`[aria-label="${ariaLabel}"][role="button"]`) as HTMLElement;
	if (!trigger) throw new Error(`select not found: ${ariaLabel}`);
	menuCalls.length = 0;
	await fireEvent.mouseDown(trigger);
	const item = menuCalls.at(-1)?.items.find(entry => entry.text === optionText);
	if (!item?.action) throw new Error(`menu option not found: ${optionText}`);
	await item.action();
}

async function clickMenu(scope: HTMLElement, itemText: string) {
	const button = scope.querySelector('button[aria-label="Menu"]') as HTMLElement;
	menuCalls.length = 0;
	await fireEvent.click(button);
	const item = menuCalls.at(-1)?.items.find(entry => entry.text === itemText);
	if (!item?.action) throw new Error(`menu item not found: ${itemText}`);
	await item.action();
}

test('단위 변경은 수량을 유지하고 입력란 노드를 다시 만들지 않는다', async () => {
	const { view, requests } = renderEdit({ ...base, condition: { type: 'all', children: [{ type: 'age', seconds: 30 * 86400, operator: 'gte' }] } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const section = sectionOf(view.container, '0');
	const qty = section.querySelector('input[type="number"]') as HTMLInputElement;
	mark(section, 'unit'); mark(qty, 'unit');
	expect(qty.value).toBe('30');
	await selectOption(section, 'Time unit', 'Hours');
	await waitFor(() => expect(qty.value).toBe('30'));
	expect(intact(section, 'unit') && intact(qty, 'unit')).toBe(true);
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(requests.some(request => request.url.endsWith('/update'))).toBe(true));
	const saved = requests.find(request => request.url.endsWith('/update'))!;
	expect(saved.body.condition.children[0].seconds).toBe(30 * 3600);
});

test('묶음 안 키워드 입력은 포커스와 노드를 유지한다', async () => {
	const { view } = renderEdit({ ...base, condition: { type: 'all', children: [{ type: 'keyword', mode: 'literal', value: 'seed', flags: '', targets: ['text'] }] } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const section = sectionOf(view.container, '0');
	const textarea = section.querySelector('textarea') as HTMLTextAreaElement;
	mark(section, 'kw'); mark(textarea, 'kw');
	textarea.focus();
	await fireEvent.update(textarea, '고양이');
	expect(textarea.value).toBe('고양이');
	expect(window.document.activeElement).toBe(textarea);
	expect(intact(section, 'kw') && intact(textarea, 'kw')).toBe(true);
});

test('단위 선택은 같은 묶음의 다른 조건을 편집해도 유지된다', async () => {
	const { view } = renderEdit({ ...base, condition: { type: 'all', children: [{ type: 'age', seconds: 30 * 86400, operator: 'gte' }, { type: 'keyword', mode: 'literal', value: 'seed', flags: '', targets: ['text'] }] } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const ageSection = sectionOf(view.container, '0');
	const kwSection = sectionOf(view.container, '1');
	mark(ageSection, 'sib');
	await selectOption(ageSection, 'Time unit', 'Hours');
	const qty = ageSection.querySelector('input[type="number"]') as HTMLInputElement;
	await waitFor(() => expect(qty.value).toBe('30'));
	await fireEvent.update(kwSection.querySelector('textarea')!, '변경');
	const unitText = (ageSection.querySelector('[aria-label="Time unit"][role="button"]') as HTMLElement).textContent?.trim();
	expect(unitText).toBe('Hours');
	expect(qty.value).toBe('30');
	expect(intact(ageSection, 'sib')).toBe(true);
});

test('유형 변경은 섹션 노드를 유지하면서 입력란만 새로 시작한다', async () => {
	const { view } = renderEdit({ ...base, condition: { type: 'all', children: [{ type: 'keyword', mode: 'literal', value: 'alpha', flags: '', targets: ['text'] }] } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const section = sectionOf(view.container, '0');
	mark(section, 'type');
	await selectOption(section, 'Condition', 'Hashtag');
	expect(intact(section, 'type')).toBe(true);
	expect(section.querySelector('textarea')).toBeNull();
	expect(section.querySelector('input:not([type])')).toBeTruthy();
});

test('복제·순서 이동·삭제·추가는 기존 노드를 다시 만들지 않는다', async () => {
	const { view } = renderEdit({ ...base, condition: { type: 'all', children: [
		{ type: 'keyword', mode: 'literal', value: 'alpha', flags: '', targets: ['text'] },
		{ type: 'keyword', mode: 'literal', value: 'beta', flags: '', targets: ['text'] },
	] } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const alpha = sectionOf(view.container, '0');
	const beta = sectionOf(view.container, '1');
	mark(alpha, 'st'); mark(beta, 'st');
	mark(alpha.querySelector('textarea')!, 'st'); mark(beta.querySelector('textarea')!, 'st');
	await clickMenu(alpha, 'Duplicate');
	expect(view.container.querySelectorAll('[data-condition-path]').length).toBe(4);
	expect(intact(alpha, 'st') && intact(beta, 'st')).toBe(true);
	expect(intact(alpha.querySelector('textarea')!, 'st') && intact(beta.querySelector('textarea')!, 'st')).toBe(true);
	const copy = sectionOf(view.container, '1');
	mark(copy, 'copy');
	await clickMenu(copy, 'Move down');
	expect(intact(copy, 'copy')).toBe(true);
	expect(copy.getAttribute('data-condition-path')).toBe('2');
	await fireEvent.click(sectionOf(view.container, '1').querySelector('button[aria-label="Delete"]')!);
	expect(intact(copy, 'copy')).toBe(true);
	expect(intact(alpha, 'st')).toBe(true);
	const addButton = [...sectionOf(view.container, '').querySelectorAll('button')].find(button => button.textContent?.includes('Add condition'))!;
	await fireEvent.click(addButton);
	expect(intact(copy, 'copy') && intact(alpha, 'st')).toBe(true);
	expect(view.container.querySelectorAll('[data-condition-path]').length).toBe(4);
});

test('2단 묶음 안 공개 범위 체크박스는 같은 노드에서 상태가 바뀐다', async () => {
	const { view } = renderEdit({ ...base, condition: { type: 'all', children: [{ type: 'any', children: [{ type: 'visibility', values: ['public'] }] }] } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const root = sectionOf(view.container, '');
	const group = sectionOf(view.container, '0');
	const leaf = sectionOf(view.container, '0.0');
	const boxes = leaf.querySelectorAll('input[type="checkbox"]');
	mark(root, 'vis'); mark(group, 'vis'); mark(leaf, 'vis');
	boxes.forEach(box => mark(box, 'vis'));
	await fireEvent.click(boxes[1]);
	expect(intact(root, 'vis') && intact(group, 'vis') && intact(leaf, 'vis')).toBe(true);
	expect([...boxes].every(box => intact(box, 'vis'))).toBe(true);
	expect((boxes[0] as HTMLInputElement).checked).toBe(true);
	expect((boxes[1] as HTMLInputElement).checked).toBe(true);
});

test('최상위 수량 편집은 에코 뒤에도 같은 입력란에 포커스를 유지한다', async () => {
	const { view } = renderEdit({ ...base, condition: { type: 'age', seconds: 30 * 86400, operator: 'gte' } });
	await waitFor(() => expect(view.container.querySelector('[data-condition-path=""]')).toBeTruthy());
	const section = sectionOf(view.container, '');
	const qty = section.querySelector('input[type="number"]') as HTMLInputElement;
	mark(section, 'top'); mark(qty, 'top');
	qty.focus();
	await fireEvent.update(qty, '45');
	await waitFor(() => expect(qty.value).toBe('45'));
	expect(window.document.activeElement).toBe(qty);
	expect(intact(section, 'top') && intact(qty, 'top')).toBe(true);
});
