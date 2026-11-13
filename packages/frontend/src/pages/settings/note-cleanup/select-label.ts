/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { ObjectDirective } from 'vue';

export function labelSelect(root: HTMLElement, label: string): void {
	// 공용 선택기의 실제 키보드 조작 지점에 전용 화면의 이름을 연결한다.
	const trigger = root.querySelector<HTMLElement>('[tabindex="0"]');
	if (!trigger) return;
	trigger.setAttribute('aria-label', label);
	trigger.setAttribute('role', 'button');
	trigger.setAttribute('aria-haspopup', 'menu');
}
export const vSelectLabel: ObjectDirective<HTMLElement, string> = {
	mounted: (element, binding) => labelSelect(element, binding.value),
	updated: (element, binding) => labelSelect(element, binding.value),
};
