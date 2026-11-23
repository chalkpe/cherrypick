/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 손가락(터치) 입력에서 발생한 contextmenu(길게 누르기) 인지 판정한다.
 * pointerType 이 'touch' 이면 터치, 명시적인 'pen' 이면 펜으로 본다.
 * 그 밖의 값(빈 문자열, 일부 구형 Chromium 이 터치 유래 이벤트에 붙이는 'mouse', 없음)과
 * MouseEvent 는 sourceCapabilities.firesTouchEvents 가 true 인 경우에만 터치로 본다.
 * 출처가 표시되지 않는 마우스·키보드 입력은 터치로 보지 않는다.
 */
export function isTouchContextmenu(ev: MouseEvent): boolean {
	const pointerType = (ev as Partial<PointerEvent>).pointerType;
	if (pointerType === 'touch') return true;
	if (pointerType === 'pen') return false;
	const caps = (ev as { sourceCapabilities?: { firesTouchEvents?: boolean | null } | null }).sourceCapabilities;
	return caps?.firesTouchEvents === true;
}
