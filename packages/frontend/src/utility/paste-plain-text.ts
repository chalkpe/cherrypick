/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// test is located in test/unit/post-form.test.ts

import insertTextAtCursor from 'insert-text-at-cursor';

// RFC 3986 のスキーム部分。iOS は URL 形式を作るときにスキームを小文字にする (Note: → note:)
const schemePattern = /^[a-z][a-z0-9+.-]*:/i;

function lowerScheme(text: string): string {
	return text.replace(schemePattern, scheme => scheme.toLowerCase());
}

/**
 * iOS の Safari (iOS 18・27 の実機で確認) は「単語:」で始まる文字列 (URL を含む) をコピーすると、text/plain の原文に加えて
 * パーセントエンコードした text/uri-list も登録し、既定の貼り付けでは後者を入れてしまう。
 * text/uri-list が text/plain と異なり、デコードすると (スキームの大文字小文字を除いて) text/plain と一致する場合に限り原文を返す。
 * 本物のリンクのように両者が同じ場合、どちらか一方しかない場合、ファイルを含む場合は null を返す。
 */
export function getPlainTextEncodedAsUriList(data: DataTransfer): string | null {
	if (Array.from(data.items).some(item => item.kind === 'file')) return null;
	if (!data.types.includes('text/plain') || !data.types.includes('text/uri-list')) return null;

	const plain = data.getData('text/plain');
	const uriList = data.getData('text/uri-list');
	if (uriList === plain) return null;

	let decoded: string;
	try {
		decoded = decodeURIComponent(uriList);
	} catch {
		return null;
	}
	return lowerScheme(decoded) === lowerScheme(plain) ? plain : null;
}

/**
 * getPlainTextEncodedAsUriList に当たる貼り付けなら既定の動作を止め、原文を貼り付け先のキャレット位置に入れて true を返す。
 * insert-text-at-cursor は execCommand('insertText') を先に試すので、取り消しや input イベント (v-model) は通常の入力と同じに扱われる。
 * ev.currentTarget と preventDefault を使うので、イベントの処理中 (await より前) に呼ぶこと。
 */
export function pastePlainTextInsteadOfUriList(ev: ClipboardEvent): boolean {
	const el = ev.currentTarget;
	if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
	if (el.readOnly || el.disabled) return false;
	if (ev.clipboardData == null) return false;

	const plain = getPlainTextEncodedAsUriList(ev.clipboardData);
	if (plain == null) return false;

	ev.preventDefault();
	insertTextAtCursor(el, plain);
	return true;
}
