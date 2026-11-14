/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onActivated, onBeforeUnmount, onDeactivated, ref } from 'vue';
import type { Ref } from 'vue';

// ソフトウェアキーボードは少なくともこれだけは画面を覆う。アドレスバーの折りたたみなど、これより小さい高さの変化はキーボードとみなさない
const KEYBOARD_MIN_HEIGHT = 150;

function isTextEditable(el: Element | null): boolean {
	if (el == null) return false;
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement) {
		return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type);
	}
	return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * ソフトウェアキーボードが出ているかをイベントだけで検知する。
 * 画面の高さが最も大きかったときからどれだけ減ったかで判断し、入力要素にフォーカスがあるときだけキーボードとみなす。
 * iOS Safari とホーム画面のウェブアプリ、Android Chrome のいずれでもポーリングなしで動く。
 * KeepAlive でキャッシュされるページでは、離れているあいだ検知を止めて状態を落とす。
 */
export function useSoftwareKeyboard(): Readonly<Ref<boolean>> {
	const visible = ref(false);

	let listening = false;
	let baselineWidth = window.innerWidth;
	let baselineHeight = window.innerHeight;

	function update(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;

		// 回転やウィンドウ幅の変化があれば前の高さの基準は使えないので、取り直す
		if (width !== baselineWidth) {
			baselineWidth = width;
			baselineHeight = height;
			visible.value = false;
			return;
		}

		if (height > baselineHeight) baselineHeight = height;

		const viewport = window.visualViewport;
		// ピンチズームでも表示領域は縮むので、倍率が 1 のときだけ縮んだ量として数える
		const visualShrink = viewport != null && Math.abs(viewport.scale - 1) < 0.01
			? baselineHeight - viewport.height
			: 0;
		const shrink = Math.max(baselineHeight - height, visualShrink);

		visible.value = shrink >= KEYBOARD_MIN_HEIGHT && isTextEditable(window.document.activeElement);
	}

	function listen(): void {
		if (listening) return;
		listening = true;
		window.addEventListener('resize', update, { passive: true });
		window.visualViewport?.addEventListener('resize', update, { passive: true });
		window.document.addEventListener('focusin', update);
		window.document.addEventListener('focusout', update);
	}

	function unlisten(): void {
		if (!listening) return;
		listening = false;
		window.removeEventListener('resize', update);
		window.visualViewport?.removeEventListener('resize', update);
		window.document.removeEventListener('focusin', update);
		window.document.removeEventListener('focusout', update);
	}

	listen();
	update();

	onActivated(() => {
		baselineWidth = window.innerWidth;
		baselineHeight = window.innerHeight;
		listen();
		update();
	});

	onDeactivated(() => {
		unlisten();
		visible.value = false;
	});

	onBeforeUnmount(() => {
		unlisten();
	});

	return visible;
}
