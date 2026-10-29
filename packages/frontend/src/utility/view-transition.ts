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
 *
 * update にはトランジションの中で呼ばれているかどうかを渡す (描画の確定を待ちたい更新は、トランジションの中でだけ Promise を返せる)。
 * onDone はトランジションが終わった (finished が決着した) ときに一度だけ呼ぶ。トランジションを使わないときは、
 * 更新が終わったあと (同期の更新ならその場で、Promise を返す更新ならそれが決着してから) に呼ぶ。更新が失敗しても呼ぶ。
 */
export function startViewTransition(update: (transitioning: boolean) => void | Promise<void>, options: { onDone?: () => void } = {}): void {
	const ignore = () => {};
	let doneCalled = false;
	const done = () => {
		if (doneCalled) return;
		doneCalled = true;
		options.onDone?.();
	};
	const updateWithoutTransition = () => {
		const result = update(false);
		if (result instanceof Promise) {
			result.then(done, done);
		} else {
			done();
		}
	};

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (typeof window.document.startViewTransition !== 'function' || window.document.visibilityState !== 'visible') {
		updateWithoutTransition();
		return;
	}

	let transition: ViewTransition;
	try {
		transition = window.document.startViewTransition(() => update(true));
	} catch (err) {
		// 様々な理由により startViewTransition は失敗することがある
		// ref. https://github.com/misskey-dev/misskey/issues/16562
		console.error(err);
		updateWithoutTransition();
		return;
	}

	transition.ready.catch(ignore);
	transition.updateCallbackDone.catch(ignore);
	transition.finished.then(done, done);
}
