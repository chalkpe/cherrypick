/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, ref, watch } from 'vue';
import { prefer } from '@/preferences.js';

export function watchSnowEffect(): () => void {
	// popout()이 연 창
	if (new URLSearchParams(window.location.search).has('zen')) return () => {};

	const deviceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const deviceReducesMotion = ref(deviceMotion.matches);
	const onDeviceMotionChange = (ev: MediaQueryListEvent) => {
		deviceReducesMotion.value = ev.matches;
	};
	deviceMotion.addEventListener('change', onDeviceMotionChange);

	const shouldSnow = computed(() => prefer.r.enableSnowEffect.value && prefer.r.animation.value && !deviceReducesMotion.value);

	let stopSnow: (() => void) | null = null;
	let disposed = false;

	const stopWatching = watch(shouldSnow, async (snow) => {
		if (!snow) {
			stopSnow?.();
			stopSnow = null;
			return;
		}
		if (stopSnow != null) return;

		try {
			const { startSnow } = await import('@/utility/snow-effect.js');
			// 불러오는 사이에 상태가 바뀌었을 수 있다
			if (shouldSnow.value && stopSnow == null && !disposed) stopSnow = startSnow();
		} catch (err) {
			console.error('Failed to start the snow effect:', err);
		}
	}, { immediate: true });

	return () => {
		disposed = true;
		stopWatching();
		deviceMotion.removeEventListener('change', onDeviceMotionChange);
		stopSnow?.();
		stopSnow = null;
	};
}
