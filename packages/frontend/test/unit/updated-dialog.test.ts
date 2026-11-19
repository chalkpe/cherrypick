/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import MkUpdated from '@/components/MkUpdated.vue';
import { i18n } from '@/i18n.js';

vi.mock('@/utility/confetti.js', () => ({ confetti: vi.fn() }));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test('the update notice opens the release notes without an opener', async () => {
	const open = vi.spyOn(window, 'open').mockReturnValue(null);
	const { getByRole } = render(MkUpdated, {
		global: { stubs: { MkModal: { emits: ['click'], template: '<div><slot /></div>' }, MkSparkle: { template: '<div><slot /></div>' }, Mfm: true } },
	});

	await fireEvent.click(getByRole('button', { name: i18n.ts.whatIsNew }));

	expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('CHANGELOG_CHERRYPICK.md'), '_blank', 'noopener');
});
