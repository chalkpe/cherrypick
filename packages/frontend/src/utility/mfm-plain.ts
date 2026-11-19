/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function mfmPlain(text: string): string {
	if (text === '') return '';

	// MFM이 경계의 줄바꿈 하나를 소비하므로 값 바깥에 줄바꿈을 넣는다.
	// 닫는 태그는 두 plain 노드에 나눠 원래 글자가 그대로 보이게 한다.
	return '<plain>\n' + text.replaceAll('</plain>', '</\n</plain><plain>\nplain>') + '\r\n</plain>';
}
