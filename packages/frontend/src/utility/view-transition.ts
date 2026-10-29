/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * document.startViewTransition を安全に呼ぶ。
 *
 * 非表示のタブ (バックグラウンドで開いたタブや PWA の切り替え中) ではトランジションがスキップされ、
 * ready / finished が InvalidStateError で reject される。誰も待っていないと unhandledrejection になり、
 * 起動中なら boot.js のエラー画面が出てしまう。表示中でなければ更新だけ行い、reject は握りつぶす。
 */
export function startViewTransition(update: () => void | Promise<void>): void {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (typeof window.document.startViewTransition !== 'function' || window.document.visibilityState !== 'visible') {
		void update();
		return;
	}

	let transition: ViewTransition;
	try {
		transition = window.document.startViewTransition(update);
	} catch (err) {
		// 様々な理由により startViewTransition は失敗することがある
		// ref. https://github.com/misskey-dev/misskey/issues/16562
		console.error(err);
		void update();
		return;
	}

	const ignore = () => {};
	transition.ready.catch(ignore);
	transition.updateCallbackDone.catch(ignore);
	transition.finished.catch(ignore);
}
