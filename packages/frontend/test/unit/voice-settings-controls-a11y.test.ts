/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, ref } from 'vue';

vi.hoisted(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));
vi.mock('@/theme.js', () => ({ themeManager: { currentCompiledTheme: { panel: '#ffffff' } } }));

import MkInput from '@/components/MkInput.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkSwitch from '@/components/MkSwitch.vue';

const global = {
	stubs: {
		MkStickyContainer: { template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' },
		MkCondensedLine: { template: '<span><slot/></span>' },
	},
	directives: { 'adaptive-border': {}, tooltip: {} },
};

afterEach(cleanup);

test('page ARIA attributes fall through to wrappers, without labelling the native controls', () => {
	const view = render(defineComponent({
		setup: () => () => h('div', [
			h(MkInput, { modelValue: '', 'aria-label': 'Address' }),
			h(MkFolder, { 'aria-label': 'Settings', 'aria-expanded': false }),
			h(MkSwitch, { modelValue: true, 'aria-label': 'Enable', 'aria-checked': true }),
		]),
	}), { global });

	for (const control of view.container.querySelectorAll('input, button')) {
		expect(control.getAttribute('aria-label')).toBeNull();
		expect(control.getAttribute('aria-expanded')).toBeNull();
		expect(control.getAttribute('aria-checked')).toBeNull();
	}
	expect(view.container.querySelector('[aria-label="Address"]')?.tagName).toBe('DIV');
	expect(view.container.querySelector('[aria-label="Settings"]')?.tagName).toBe('DIV');
	expect(view.container.querySelector('[aria-label="Enable"]')?.tagName).toBe('DIV');
});

test('default input keeps the existing label focus and model updates without opt-in attributes', async () => {
	const value = ref<string | number>('before');
	const view = render(defineComponent({
		setup: () => () => h(MkInput, { modelValue: value.value, 'onUpdate:modelValue': next => { value.value = next ?? ''; } }, { label: () => 'Address' }),
	}), { global });
	const input = view.container.querySelector('input')!;
	expect(input.getAttribute('aria-labelledby')).toBeNull();

	await fireEvent.click(view.getByText('Address'));
	expect(document.activeElement).toBe(input);
	await fireEvent.update(input, 'after');
	expect(value.value).toBe('after');
});

test('default folder preserves group state, native click and retained content without button ARIA', async () => {
	const value = ref('draft');
	const view = render(defineComponent({
		setup: () => () => h(MkFolder, {}, {
			label: () => 'Settings',
			default: () => h('input', { value: value.value, onInput: (event: Event) => { value.value = (event.target as HTMLInputElement).value; } }),
		}),
	}), { global });
	const header = view.getByRole('button', { name: 'Settings' });
	const group = view.getByRole('group');
	expect(header.getAttribute('aria-expanded')).toBeNull();
	expect(header.getAttribute('aria-labelledby')).toBeNull();
	expect(group.getAttribute('aria-expanded')).toBe('false');

	await fireEvent.click(header);
	await waitFor(() => expect(group.getAttribute('aria-expanded')).toBe('true'));
	const input = view.getByRole<HTMLInputElement>('textbox');
	await fireEvent.update(input, 'kept');
	await fireEvent.click(header);
	await fireEvent.click(header);
	expect(input.isConnected).toBe(true);
	expect(input.value).toBe('kept');
});

test('default switch retains existing native state and pointer model updates without opt-in', async () => {
	const value = ref(true);
	const view = render(defineComponent({
		setup: () => () => h(MkSwitch, { modelValue: value.value, 'onUpdate:modelValue': next => { value.value = next; } }, () => 'Enable'),
	}), { global });
	const checkbox = view.getByRole<HTMLInputElement>('checkbox');
	expect(checkbox.checked).toBe(false);
	expect(checkbox.getAttribute('aria-labelledby')).toBeNull();

	await fireEvent.click(view.getByText('Enable'));
	expect(value.value).toBe(false);
	await fireEvent.click(view.getByTestId('switch-toggle'));
	expect(value.value).toBe(true);
});

test('opted-in switch follows external model changes and blocks disabled activation', async () => {
	const value = ref(true);
	const disabled = ref(false);
	const changes: boolean[] = [];
	const view = render(defineComponent({
		setup: () => () => h(MkSwitch, {
			modelValue: value.value, accessible: true, disabled: disabled.value,
			'onUpdate:modelValue': next => { value.value = next; },
			onChange: next => changes.push(next),
		}, () => 'Enable'),
	}), { global });
	const checkbox = view.getByRole<HTMLInputElement>('checkbox', { name: 'Enable', checked: true });
	expect(checkbox.type).toBe('checkbox');
	expect(checkbox.tabIndex).toBe(0);

	value.value = false;
	await waitFor(() => expect(checkbox.checked).toBe(false));
	await fireEvent.click(checkbox);
	expect(value.value).toBe(true);
	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);

	disabled.value = true;
	await waitFor(() => expect(checkbox.disabled).toBe(true));
	await fireEvent.click(checkbox);
	await fireEvent.click(view.getByText('Enable'));
	await fireEvent.click(view.getByTestId('switch-toggle'));
	expect(value.value).toBe(true);
	expect(changes).toEqual([true]);
});
