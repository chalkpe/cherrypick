/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 親の表示切り替えや Teleport の移動も含め、要素が操作できる表示状態かを追う。 */
export function observeElementVisibility(el: HTMLElement, onChange: (visible: boolean) => void): { refresh: () => void; dispose: () => void } {
	const observer = new MutationObserver(refresh);

	function refresh() {
		observer.disconnect();
		let visible = el.isConnected;
		// ページウィンドウや重ねたルーターは、親の表示状態だけを変えて中身を残すことがある。
		// Teleport で親が変わる場合も、移動後の親を監視し直す。
		for (let ancestor: HTMLElement | null = el; ancestor; ancestor = ancestor.parentElement) {
			const style = window.getComputedStyle(ancestor);
			if (ancestor.hidden || ancestor.hasAttribute('inert') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') visible = false;
			observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'], childList: true });
		}
		onChange(visible);
	}

	refresh();
	return { refresh, dispose: () => observer.disconnect() };
}
