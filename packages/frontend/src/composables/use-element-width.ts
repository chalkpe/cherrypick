/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onBeforeUnmount, readonly, ref, watch } from 'vue';
import type { Ref } from 'vue';

/**
 * 要素の中身の幅 (px) を ResizeObserver で追う。
 * ウィンドウではなく要素そのものの幅なので、デッキの列やウィジェットで幅が変わるページでも使える。
 * 要素が無いあいだと、まだ測っていないあいだは null
 */
export function useElementWidth(target: Readonly<Ref<HTMLElement | null | undefined>>): Readonly<Ref<number | null>> {
	const width = ref<number | null>(null);
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
		for (const entry of entries) width.value = entry.contentRect.width;
	});

	watch(target, (el, prev) => {
		if (prev != null) observer?.unobserve(prev);
		width.value = null;
		if (el != null) observer?.observe(el);
	}, { immediate: true, flush: 'post' });

	onBeforeUnmount(() => {
		observer?.disconnect();
	});

	return readonly(width);
}
