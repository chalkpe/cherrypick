/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HTML_TAGS, MFM_TAGS } from '@@/js/const.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';

/**
 * MFMの装飾のリストを表示する
 */
export function mfmFunctionPicker(anchorElement: HTMLElement | EventTarget | null, onChosen: (tag: string) => void, onClosed?: () => void) {
	os.popupMenu([{
		text: i18n.ts.addMfmFunction,
		type: 'label',
	}, ...HTML_TAGS.map(tag => ({
		text: tag,
		icon: htmlFunctions[tag].icon,
		action: () => onChosen(tag),
	})), { type: 'divider' }, ...MFM_TAGS.map(tag => ({
		text: tag,
		icon: 'ti ti-icons',
		action: () => {
			onChosen(tag);
		},
	}))], anchorElement, {
		onClosed: () => {
			if (onClosed) onClosed();
		},
	});
}

const htmlFunctions: Record<string, { open: string; close: string; icon: string }> = {
	bold: { open: '<b>', close: '</b>', icon: 'ti ti-bold' },
	strike: { open: '~~', close: '~~', icon: 'ti ti-strikethrough' },
	italic: { open: '<i>', close: '</i>', icon: 'ti ti-italic' },
	small: { open: '<small>', close: '</small>', icon: 'ti ti-text-decrease' },
	center: { open: '<center>', close: '</center>', icon: 'ti ti-align-center' },
	plain: { open: '<plain>', close: '</plain>', icon: 'ti ti-clear-formatting' },
	inlinecode: { open: '`', close: '`', icon: 'ti ti-code' },
	blockcode: { open: '```\n', close: '\n```', icon: 'ti ti-script' },
	mathinline: { open: '\\(', close: '\\)', icon: 'ti ti-math' },
	mathblock: { open: '\\[\n', close: '\n\\]', icon: 'ti ti-math-function' },
};

export function insertMfmFunction(text: string, start: number, end: number, tag: string) {
	const { open, close } = htmlFunctions[tag] ?? { open: `$[${tag} `, close: ']' };
	return {
		text: text.substring(0, start) + open + text.substring(start, end) + close + text.substring(end),
		start: start + open.length,
		end: end + open.length,
	};
}
