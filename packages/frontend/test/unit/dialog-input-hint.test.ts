/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';

import MkDialog from '@/components/MkDialog.vue';
import { i18n } from '@/i18n.js';

const stubs = {
	MkModal: { template: '<div><slot/></div>' },
	MkInput: {
		props: ['modelValue'], emits: ['update:modelValue'],
		template: '<label>name<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/><slot name="caption"/></label>',
	},
	MkButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' },
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const hint = (current: number) => i18n.tsx._dialog.charactersBelow({ current, min: 1 });

function renderDialog(input: { hideMinLengthUntilInput?: boolean } = {}) {
	return render(MkDialog, { props: { input: { default: null, minLength: 1, ...input }, title: 'name' }, global: { stubs, directives: { tooltip: {} } } });
}

afterEach(cleanup);

// どの入力の窓でも、頼まれない限りはこれまでどおり
test('an input window says what is missing from the start, as it always did', () => {
	const { container } = renderDialog();

	expect(screen.getByText(hint(0))).toBeTruthy();
	expect(container.querySelector('[data-testid="modal-dialog-ok"]')?.hasAttribute('disabled')).toBe(true);
});

describe('a window that asks to hold the hint until something was typed', () => {
	test('does not point out a missing name before anything was typed, though OK stays off', () => {
		const { container } = renderDialog({ hideMinLengthUntilInput: true });

		expect(screen.queryByText(hint(0))).toBeNull();
		expect(container.querySelector('[data-testid="modal-dialog-ok"]')?.hasAttribute('disabled')).toBe(true);
	});

	test('points it out once the field was emptied again', async () => {
		renderDialog({ hideMinLengthUntilInput: true });
		const input = screen.getByRole('textbox');

		await fireEvent.update(input, 'a');
		expect(screen.queryByText(hint(1))).toBeNull();

		await fireEvent.update(input, '');
		expect(screen.getByText(hint(0))).toBeTruthy();
	});
});
