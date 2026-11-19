/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 外部サイト移動の警告を経由して新しいタブでURLを開く。
 * 警告が不要なURL(信頼済み・警告設定オフ)はそのまま開き、警告した場合は確認後のみ開く。
 */
export async function openExternalUrl(url: string): Promise<void> {
	// 警告ダイアログ(Vueコンポーネント)を呼び出し元のモジュール読み込み時に巻き込まないよう、使用時に読み込む
	const { warningExternalWebsite } = await import('@/utility/warning-external-website.js');
	const ev = new MouseEvent('click', { cancelable: true });
	await warningExternalWebsite(ev, url);
	// 警告を表示した場合は warningExternalWebsite 側で確認後に開く
	if (!ev.defaultPrevented) window.open(url, '_blank', 'noopener');
}
