/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent } from 'vue';
import type { Ref } from 'vue';
import { userPreviewDirective } from '@/directives/user-preview.js';

const { popup } = vi.hoisted(() => ({
	popup: vi.fn<(component: unknown, props: { showing: Ref<boolean>; q: string }, events: unknown) => { dispose: () => void }>(),
}));
vi.mock('@/os.js', () => ({ popup }));
vi.mock('@/utility/touch.js', () => ({ isTouchUsing: false }));

const PreviewTarget = defineComponent({
	props: {
		userId: { type: String, default: undefined },
		title: { type: String, default: '' },
	},
	template: '<span v-user-preview="userId" :title="title" data-testid="target">Avatar</span>',
});

function renderPreview(userId: string | undefined) {
	return render(PreviewTarget, {
		props: { userId },
		global: { directives: { 'user-preview': userPreviewDirective } },
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	popup.mockReset();
	popup.mockReturnValue({ dispose: vi.fn() });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

test('disabling a preview cancels its pending popup', async () => {
	const { getByTestId, rerender } = renderPreview('alice');
	// Vue may schedule its initial devtools detection timer on the first mount.
	const backgroundTimers = vi.getTimerCount();
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(250);
	await rerender({ userId: undefined });
	await vi.advanceTimersByTimeAsync(1000);

	expect(popup).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(backgroundTimers);
});

test('disabling an active preview closes it and clears its timers', async () => {
	const { getByTestId, rerender } = renderPreview('alice');
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(500);
	const showing = popup.mock.calls[0][1].showing;
	expect(showing.value).toBe(true);
	await fireEvent.mouseLeave(getByTestId('target'));
	await rerender({ userId: undefined });

	expect(showing.value).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(1000);
	expect(popup).toHaveBeenCalledTimes(1);
});

test('re-enabling a preview attaches it again', async () => {
	const { getByTestId, rerender } = renderPreview('alice');
	await rerender({ userId: undefined });
	await rerender({ userId: 'bob' });
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(500);

	expect(popup).toHaveBeenCalledTimes(1);
	expect(popup.mock.calls[0][1].q).toBe('bob');
});

test('changing the user closes the previous popup and previews the new user', async () => {
	const { getByTestId, rerender } = renderPreview('alice');
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(500);
	const showing = popup.mock.calls[0][1].showing;
	await rerender({ userId: 'bob' });
	expect(showing.value).toBe(false);
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(500);

	expect(popup).toHaveBeenCalledTimes(2);
	expect(popup.mock.calls[1][1].q).toBe('bob');
});

test('unrelated updates preserve the pending preview', async () => {
	const { getByTestId, rerender } = renderPreview('alice');
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(250);
	await rerender({ title: 'Updated avatar' });
	await vi.advanceTimersByTimeAsync(250);

	expect(popup).toHaveBeenCalledTimes(1);
	expect(popup.mock.calls[0][1].q).toBe('alice');
});

test.each([250, 500])('unmount cleans up a preview after %s ms', async (delay) => {
	const { getByTestId, unmount } = renderPreview('alice');
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(delay);
	const showing = popup.mock.calls[0]?.[1].showing;
	unmount();

	if (showing) expect(showing.value).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});

test('enables a preview that was disabled when mounted', async () => {
	const { getByTestId, rerender } = renderPreview(undefined);
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(500);
	expect(popup).not.toHaveBeenCalled();
	await rerender({ userId: 'alice' });
	await fireEvent.mouseOver(getByTestId('target'));
	await vi.advanceTimersByTimeAsync(500);
	expect(popup.mock.calls[0][1].q).toBe('alice');
});
