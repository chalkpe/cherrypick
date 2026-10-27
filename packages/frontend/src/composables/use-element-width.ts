/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onBeforeUnmount, readonly, ref, watch } from 'vue';
import type { Ref } from 'vue';

/**
 * 要素の中身の幅 (px) を ResizeObserver で追う。
 * ウィンドウではなく要素そのものの幅なので、デッキの列やウィジェットで幅が変わるページでも使える。
 * 一度も測っていないあいだは null。要素が外れても (タブを切り替えたときなど) 最後に測った幅を覚えておき、
 * 要素が戻ってきたときは測り直すまでその幅を使う
 */
export function useElementWidth(target: Readonly<Ref<HTMLElement | null | undefined>>, onReport?: () => void): Readonly<Ref<number | null>> {
	const width = ref<number | null>(null);
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
		for (const entry of entries) {
			// KeepAlive で裏に回った要素はどこにも描かれないので幅 0 と知らされる。それは見える幅ではないので無視する
			if (!entry.target.isConnected) continue;
			width.value = entry.contentRect.width;
			onReport?.();
		}
	});

	watch(target, (el, prev) => {
		if (prev != null) observer?.unobserve(prev);
		if (el != null) observer?.observe(el);
	}, { immediate: true, flush: 'post' });

	onBeforeUnmount(() => {
		observer?.disconnect();
	});

	return readonly(width);
}
