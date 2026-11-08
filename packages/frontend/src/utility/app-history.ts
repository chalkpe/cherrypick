/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// ブラウザの履歴の長さからは、一つ前の項目がこのアプリのものかどうかが分からない。
// 項目ごとに持たせた数は、再読み込みでも残り、戻る・進むでもその項目の値に戻る。
const DEPTH_KEY = 'appHistoryDepth';

function currentDepth(): number {
	const depth = window.history.state?.[DEPTH_KEY];
	return typeof depth === 'number' ? depth : 0;
}

export function pushAppHistory(fullPath: string): void {
	window.history.pushState({ [DEPTH_KEY]: currentDepth() + 1 }, '', fullPath);
}

export function replaceAppHistory(fullPath: string): void {
	window.history.replaceState({ [DEPTH_KEY]: currentDepth() }, '', fullPath);
}

/** 戻ってもこのアプリの中にとどまるか。ページを新しいタブで直接開いたときなどは、戻るとアプリの外へ出てしまう */
export function canGoBackInApp(): boolean {
	return currentDepth() > 0;
}
