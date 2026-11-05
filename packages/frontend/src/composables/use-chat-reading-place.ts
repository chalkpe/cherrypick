/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onBeforeUnmount, watch } from 'vue';
import { getScrollContainer } from '@@/js/scroll.js';
import type { Ref } from 'vue';

// scroll がこれだけのあいだ来なければ、指を離したあとの慣性も含めてスクロールが止まったとみなす (ミリ秒)
const SCROLL_SETTLE_MS = 150;
// scrollTop や要素の位置は丸められたり小数になったりするので、この差までは同じとみなす (px)
const SAME_POSITION_PX = 1;

// TransitionGroup は動いた吹き出しを transform で元の位置から滑らせる。その途中の見かけの位置ではなく、行き着く位置で測る
function topOnScreen(el: Element) {
	const transform = window.getComputedStyle(el).transform;
	const sliding = transform === '' || transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
	return el.getBoundingClientRect().top - sliding;
}

type ReadingPlace = {
	scroller: HTMLElement;
	anchor: Element;
	// 画面での位置で測る。箱の端を基準にすると、入力欄へのフォーカスで箱の下端と中身がそろって動いたときのように、見た目は動いていないのに動いたことになる
	anchorTop: number;
	scrollTop: number;
};

/**
 * 読み返している場所を保つ。
 * column-reverse の scrollTop は下端からの距離なので、下の吹き出しが増えたり高くなったりしても値が変わらず、読んでいる場所だけが押し上げられる。
 * スクロールアンカーのないブラウザ (Safari 18 まで) はそのまま動く。あるブラウザ (Chromium、Safari 27) も、下が縮んだときには直さないことがある
 * (リアクションを外したときや、編集で短くなったとき)。
 * そこでどのブラウザでも、読んでいる吹き出しの画面での位置を測り、ずれた分だけを直す。位置を読むとレイアウトが確定し、ブラウザのスクロールアンカーは
 * そこで済むので、ブラウザが直した分を重ねて動かすことはない。ずれが 1px 未満なら書かない。
 *
 * 指が触れているあいだと慣性で動いているあいだは scrollTop を書かない。iOS では書くとスクロールが止まり、指の動きとも食い違う。
 * その間に起きたずれも、止まったときには直さない (止まった瞬間にもう一度跳ぶほうが読みにくい)。止まったところを新しい読んでいる場所にする。
 */
export function useChatReadingPlace(options: {
	timeline: Readonly<Ref<HTMLElement | null | undefined>>;
	/** 上から順に並んだ吹き出しと日付の区切り */
	items: () => Element[];
	/** 最新からこの距離より近ければ保たない。新着に追従するのは呼び出し側の役目 */
	nearNewest: number;
}): {
	/** 配置が変わったかもしれないときに呼ぶ */
	keep: () => void;
	/** 最新へ移したときなど、読んでいる場所が変わるとこちらが分かっているときに呼ぶ */
	forget: () => void;
	/**
	 * 古いメッセージを読み込むあいだ呼ぶ。返した関数は読み込みの描画のあとに呼ぶ。
	 * 読み込んだ分とのつなぎ目の吹き出しは、まとまりの途中になって低くなることがある。その下の読んでいた場所は動かないので、つなぎ目を基準に保ってはいけない
	 */
	whileLoadingEarlier: () => () => void;
} {
	let place: ReadingPlace | null = null;
	let settleTimer: number | null = null;
	let paused = false;
	let touched: EventTarget | null = null;
	let observedScroller: HTMLElement | null = null;

	// ResizeObserver はレイアウトのあと、描画の前に呼ばれるので、ずれた状態は画面に出ない。
	// リアクションや編集のように、タイムラインの並びが変わらず吹き出しの中だけが変わるものはここで分かる
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => keep());

	// 場所を押し上げるのはメッセージだけではなく、その下の案内やページの下端に貼り付いた入力欄、箱そのものの高さも同じなので、箱と中身全体を見る。
	// スクロールする箱は並べ方で変わる
	function observeScroller(scroller: HTMLElement) {
		if (scroller === observedScroller) return;
		observedScroller = scroller;
		observer?.disconnect();
		observer?.observe(scroller);
		for (const child of scroller.children) observer?.observe(child);
	}

	function remember() {
		place = null;
		const scroller = getScrollContainer(options.timeline.value ?? null);
		if (scroller == null) return;
		observeScroller(scroller);
		const viewTop = scroller.getBoundingClientRect().top;
		const anchor = options.items().find(item => item.getBoundingClientRect().bottom > viewTop);
		if (anchor == null) return;
		place = { scroller, anchor, anchorTop: topOnScreen(anchor), scrollTop: scroller.scrollTop };
	}

	// 触れていた要素が消えると touchend は window まで届かないので、指が離れたことを知る方法がなくなる
	function isTouching() {
		return touched instanceof Node && touched.isConnected;
	}

	function keep() {
		if (paused || settleTimer != null || isTouching()) return;
		if (place == null) {
			remember();
			return;
		}
		const scroller = getScrollContainer(options.timeline.value ?? null);
		if (scroller !== place.scroller || !place.anchor.isConnected) {
			remember();
			return;
		}
		// 先に位置を読む。ここでレイアウトが確定し、ブラウザのスクロールアンカーが動かした分も scrollTop に入る
		const anchorTop = topOnScreen(place.anchor);
		const scrollTop = scroller.scrollTop;
		// 最新の近くにいた、または今いるなら保たない。最新へスクロールした直後は、それが知らされる (scroll) より先に新着が届くことがある
		if (-place.scrollTop < options.nearNewest || -scrollTop < options.nearNewest) {
			remember();
			return;
		}
		// 上へ押し上げられたら正。column-reverse で scrollTop が増える (下へスクロールする) と、同じだけ上へ動く
		const moved = place.anchorTop - anchorTop;
		const scrolled = scrollTop - place.scrollTop;
		if (Math.abs(moved) < SAME_POSITION_PX) {
			// 何も動いていないか、ブラウザが直した。直した結果をそのまま受け入れる (測り直さないと、ブラウザの丸めの分だけいずれ書くことになる)
			if (Math.abs(scrolled) >= SAME_POSITION_PX) place = { ...place, anchorTop, scrollTop };
			return;
		}
		// スクロールした分だけ動いたなら、配置は変わっていない。誰かが別の場所へ移した
		if (Math.abs(moved - scrolled) < SAME_POSITION_PX) {
			remember();
			return;
		}
		// place.anchorTop はそのまま残す。測り直すと scrollTop の丸めの誤差が通数の分だけたまる
		scroller.scrollTop = scrollTop - moved;
		place.scrollTop = scroller.scrollTop;
	}

	function onScroll(ev: Event) {
		const scroller = getScrollContainer(options.timeline.value ?? null);
		if (scroller == null || ev.target !== scroller) return;
		if (place?.scroller === scroller && place.anchor.isConnected && !isTouching()) {
			const scrolled = scroller.scrollTop - place.scrollTop;
			// 自分で戻したときの scroll
			if (Math.abs(scrolled) < SAME_POSITION_PX) return;
			// ブラウザのスクロールアンカーや、一番上にいる人の下で中身が縮んだときにブラウザが詰めた scrollTop も、同じように知らせてくる。
			// 読んでいる場所がスクロールした分だけ動いたのでなければ、人のスクロールではなく配置が変わった
			const moved = place.anchorTop - topOnScreen(place.anchor);
			if (Math.abs(moved - scrolled) >= SAME_POSITION_PX) {
				keep();
				return;
			}
		}
		place = null;
		if (settleTimer != null) window.clearTimeout(settleTimer);
		settleTimer = window.setTimeout(() => {
			settleTimer = null;
			remember();
		}, SCROLL_SETTLE_MS);
	}

	function onTouchStart(ev: TouchEvent) {
		touched = ev.target;
	}

	function onTouchEnd(ev: TouchEvent) {
		if (ev.touches.length > 0) return;
		touched = null;
		// スクロールせずに離したなら、触れているあいだに起きたずれを直す。スクロールしたなら settleTimer が動いていて何もしない
		keep();
	}

	// スクロールする箱は並べ方で変わるので、まとめて受ける (scroll は上へ伝わらないがキャプチャでは受けられる)。
	// どれも passive なのでスクロールを待たせない
	window.addEventListener('scroll', onScroll, { capture: true, passive: true });
	window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
	window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
	window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

	watch(options.timeline, () => {
		remember();
	}, { immediate: true, flush: 'post' });

	onBeforeUnmount(() => {
		observer?.disconnect();
		if (settleTimer != null) window.clearTimeout(settleTimer);
		window.removeEventListener('scroll', onScroll, { capture: true });
		window.removeEventListener('touchstart', onTouchStart, { capture: true });
		window.removeEventListener('touchend', onTouchEnd, { capture: true });
		window.removeEventListener('touchcancel', onTouchEnd, { capture: true });
	});

	return {
		keep,
		forget() {
			place = null;
		},
		whileLoadingEarlier() {
			paused = true;
			const scroller = getScrollContainer(options.timeline.value ?? null);
			const scrollTop = scroller?.scrollTop;
			return () => {
				// つなぎ目より下は下端からの距離が変わらないので、同じ scrollTop に戻せば動かない。動かすのは二つ:
				// ブラウザのスクロールアンカーがつなぎ目を基準にした分と、「もっと見る」が先に消えて読み込んだ分がまだ入っていないところを
				// TransitionGroup が測ったときに一番上にいた人の scrollTop をブラウザが詰めた分。
				// 動いたときだけ戻す。慣性で動いている途中に書くとスクロールが止まるので、同じ値は書かない
				if (scroller != null && scrollTop != null && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
				paused = false;
				if (settleTimer == null) remember();
			};
		},
	};
}
