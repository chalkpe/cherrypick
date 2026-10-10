/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { prefer } from '@/preferences.js';

Object.assign(prefer, { model: vi.fn(() => ref(false)) });
import { cleanup, fireEvent, render } from '@testing-library/vue';
import MkVisibilityPicker from '@/components/MkVisibilityPicker.vue';
import { i18n } from '@/i18n.js';

describe('visibility picker locks', () => {
	afterEach(cleanup);

	test.each([
		{ limit: 'none', silenced: false, locked: [] },
		{ limit: 'home', silenced: false, locked: [1] },
		{ limit: 'followers', silenced: false, locked: [1, 2] },
		{ limit: 'none', silenced: true, locked: [1] },
	] as const)('shows locked options for $limit (silenced=$silenced)', async ({ limit, silenced, locked }) => {
		const picker = render(MkVisibilityPicker, {
			props: { currentVisibility: 'followers', isSilenced: silenced, noteVisibilityLimit: limit },
			global: {
				stubs: {
					MkModal: { template: '<div><slot type="popup" /></div>', methods: { close: vi.fn() } },
					MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				},
				directives: { tooltip: {} },
			},
		});
		const settingsLink = picker.container.querySelector('a[href="/settings/privacy"]');
		expect(settingsLink != null).toBe(limit !== 'none');
		if (settingsLink) expect(settingsLink.getAttribute('aria-label')).toBe(i18n.ts._noteVisibilityLimit.label);
		for (let index = 1; index <= 4; index++) {
			const option = picker.container.querySelector<HTMLButtonElement>(`[data-index="${index}"]`)!;
			expect(option.disabled).toBe((locked as readonly number[]).includes(index));
			if (option.disabled) {
				expect(option.querySelector('[aria-hidden="true"].ti-lock')).not.toBeNull();
				const reason = silenced && index === 1 ? i18n.ts._noteVisibilityLimit.roleLocked : i18n.ts._noteVisibilityLimit.personalLocked;
				expect(option.parentElement?.title).toBe(reason);
				expect(option.parentElement?.getAttribute('tabindex')).toBe('0');
				expect(option.parentElement?.getAttribute('aria-label')).toContain(reason);
				await fireEvent.click(option);
				expect(picker.emitted().changeVisibility).toBeUndefined();
			}
		}
		await fireEvent.click(picker.container.querySelector('[data-index="4"]')!);
		expect(picker.emitted().changeVisibility).toEqual([['specified']]);
	});
});
