/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, watch } from 'vue';
import { prefer } from '@/preferences.js';

/** common.vue가 이 값을 보고 눈 레이어를 그린다. 메인 앱에서 watchSnowEffect()를 부를 때만 켜질 수 있다 */
export const snowEffectShowing = ref(false);

export function watchSnowEffect(): () => void {
	// popout()이 연 창
	if (new URLSearchParams(window.location.search).has('zen')) return () => {};

	const deviceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const deviceReducesMotion = ref(deviceMotion.matches);
	const onDeviceMotionChange = (ev: MediaQueryListEvent) => {
		deviceReducesMotion.value = ev.matches;
	};
	deviceMotion.addEventListener('change', onDeviceMotionChange);

	const stopWatching = watch(
		() => prefer.r.enableSnowEffect.value && prefer.r.animation.value && !deviceReducesMotion.value,
		(snow) => {
			snowEffectShowing.value = snow;
		},
		{ immediate: true },
	);

	return () => {
		stopWatching();
		deviceMotion.removeEventListener('change', onDeviceMotionChange);
		snowEffectShowing.value = false;
	};
}
