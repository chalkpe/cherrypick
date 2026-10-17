/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { watch } from 'vue';
import type { ShallowRef } from 'vue';
import { prefer } from '@/preferences.js';

/**
 * Prepares the first frame of a paused, poster-less video once it becomes visible.
 * Some WebViews (e.g. PSKey) paint a blank default poster instead of the first frame.
 */
export function useVideoPreview(videoEl: Readonly<ShallowRef<HTMLVideoElement | null>>) {
	watch(videoEl, (element, _, onCleanup) => {
		if (!element || prefer.s.dataSaver.media || typeof IntersectionObserver === 'undefined') return;

		let visible = false;
		let attempted = false;
		const preparePreview = () => {
			if (!visible || attempted || prefer.s.dataSaver.media || element.readyState === 0) return;
			attempted = true;
			observer.disconnect();
			element.removeEventListener('loadedmetadata', preparePreview);

			if (!element.paused || element.seeking || element.currentTime !== 0 || element.error || !Number.isFinite(element.duration) || element.duration <= 0) return;
			if (element.getVideoPlaybackQuality?.().totalVideoFrames > 0) return;

			try {
				// Even at time zero, seeking clears the default poster and requests a frame.
				// Keep it paused: preview preparation must not start audio or interrupt music.
				element.currentTime = 0;
			} catch {
				// A preview is optional; leave unavailable/non-seekable media untouched.
			}
		};
		const observer = new IntersectionObserver(entries => {
			visible = entries.some(entry => entry.isIntersecting);
			preparePreview();
		});
		observer.observe(element);
		element.addEventListener('loadedmetadata', preparePreview);
		onCleanup(() => {
			observer.disconnect();
			element.removeEventListener('loadedmetadata', preparePreview);
		});
	});
}
