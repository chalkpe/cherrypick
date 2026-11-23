/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 손가락(터치) 입력에서 발생한 contextmenu(길게 누르기) 인지 판정한다.
 * pointerType 이 있으면 그것을 우선하고, 없을 때(MouseEvent 로 전달되는 브라우저)만
 * sourceCapabilities.firesTouchEvents 가 명시적으로 true 인 경우를 터치로 본다.
 * 마우스·펜·키보드(pointerType 이 빈 문자열)는 터치로 보지 않는다.
 */
export function isTouchContextmenu(ev: MouseEvent): boolean {
	const pointerType = (ev as Partial<PointerEvent>).pointerType;
	if (typeof pointerType === 'string' && pointerType !== '') return pointerType === 'touch';
	if (typeof pointerType === 'string') return false;
	const caps = (ev as { sourceCapabilities?: { firesTouchEvents?: boolean | null } | null }).sourceCapabilities;
	return caps?.firesTouchEvents === true;
}
