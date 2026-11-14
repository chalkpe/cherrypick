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
 * scope を渡すと、フォーカスがその要素の中にあるときだけキーボードとみなす (スタックの後ろに残った画面が、前景の画面の入力欄を自分のものとして数えないように)。
 */
export function useSoftwareKeyboard(options?: { scope?: () => Element | null }): Readonly<Ref<boolean>> {
	const visible = ref(false);
	const scope = options?.scope;

	let listening = false;
	let baselineWidth = window.innerWidth;
	let baselineHeight = window.innerHeight;

	function update(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;

		// 回転やウィンドウ幅の変化で基準の幅は取り直す。ただしキーボードが開いたまま幅が変わったとき、
		// 現在の高さはすでにキーボードの分だけ縮んでいて全体高さの基準に使えない。検知中なら直前の全体高さの基準を
		// 保って検知を維持し、キーボードを検知していないときだけ現在の高さで基準を取り直す。すぐ false を返さず続けて縮小量を計算する。
		if (width !== baselineWidth) {
			baselineWidth = width;
			if (!visible.value) {
				baselineHeight = height;
			}
		}

		if (height > baselineHeight) baselineHeight = height;

		const viewport = window.visualViewport;
		// ピンチズームでも表示領域は縮むので、倍率が 1 のときだけ縮んだ量として数える
		const visualShrink = viewport != null && Math.abs(viewport.scale - 1) < 0.01
			? baselineHeight - viewport.height
			: 0;
		const shrink = Math.max(baselineHeight - height, visualShrink);

		const active = window.document.activeElement;
		const inScope = scope == null || (scope()?.contains(active) ?? false);
		visible.value = shrink >= KEYBOARD_MIN_HEIGHT && isTextEditable(active) && inScope;
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
