/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onBeforeUnmount, watch } from 'vue';
import type { Ref } from 'vue';

const PROPERTY = '--MI-mobileFooterHeight';

/**
 * モバイルの画面下のナビゲーション (フッター) の高さを body の --MI-mobileFooterHeight に書く。
 * フッターの上に重ねるもの (通話バーやチャットのシートなど) が、フッターの分だけ空けられるようにする。
 * 高さは ResizeObserver で追い、フッターが無いあいだは 0、フッターのコンポーネントが消えたら変数も消す
 */
export function useMobileFooterHeight(footerEl: Readonly<Ref<HTMLElement | null | undefined>>): void {
	function update() {
		const height = footerEl.value?.getBoundingClientRect().height ?? 0;
		window.document.body.style.setProperty(PROPERTY, `${height}px`);
	}

	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);

	watch(footerEl, (el, previous) => {
		if (previous) observer?.unobserve(previous);
		if (el) observer?.observe(el);
		update();
	}, { immediate: true });

	onBeforeUnmount(() => {
		observer?.disconnect();
		window.document.body.style.removeProperty(PROPERTY);
	});
}
