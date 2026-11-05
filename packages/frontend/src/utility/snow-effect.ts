/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const MAX_SNOWFLAKES = 200;

const VIEWPORT_WIDTH_PER_SNOWFLAKE = 8;

// claimZIndex의 최솟값(500000) 바로 아래. 화면과 드로어는 덮고 팝업은 덮지 않는다
const LAYER_Z_INDEX = 499999;

const MIN_SIZE_PX = 1;
const MAX_SIZE_PX = 10;
const MIN_OPACITY = 0.1;
const MAX_OPACITY = 1;
const MIN_FALL_MS = 10000;
const MAX_FALL_MS = 30000;
const MIN_SWAY_VW = 0.5;
const MAX_SWAY_VW = 6;
const MIN_SWAY_WAVES = 0.5;
const MAX_SWAY_WAVES = 2;

const FALL_DISTANCE_VH = 105;
const PATH_SEGMENTS = 8;

const RESIZE_SETTLE_MS = 300;

type Snowflake = {
	element: HTMLElement;
	animation: Animation;
};

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

export function snowflakeCount(viewportWidth: number): number {
	return Math.min(MAX_SNOWFLAKES, Math.round(viewportWidth / VIEWPORT_WIDTH_PER_SNOWFLAKE));
}

function fallingPath(): Keyframe[] {
	const sway = randomBetween(MIN_SWAY_VW, MAX_SWAY_VW);
	const waves = randomBetween(MIN_SWAY_WAVES, MAX_SWAY_WAVES);
	const startAngle = randomBetween(0, Math.PI * 2);

	const path: Keyframe[] = [];
	for (let segment = 0; segment <= PATH_SEGMENTS; segment++) {
		const progress = segment / PATH_SEGMENTS;
		const x = sway * Math.sin(startAngle + progress * waves * Math.PI * 2);
		const y = progress * FALL_DISTANCE_VH;
		path.push({ transform: `translate(${x.toFixed(2)}vw, ${y.toFixed(2)}vh)` });
	}
	return path;
}

function createSnowflake(): Snowflake {
	const size = randomBetween(MIN_SIZE_PX, MAX_SIZE_PX).toFixed(1);

	const element = window.document.createElement('div');
	element.style.cssText = [
		'position: absolute',
		`top: -${size}px`,
		`left: ${randomBetween(0, 100).toFixed(2)}%`,
		`width: ${size}px`,
		`height: ${size}px`,
		'border-radius: 50%',
		'background: #fff',
		`opacity: ${randomBetween(MIN_OPACITY, MAX_OPACITY).toFixed(2)}`,
	].join(';');

	const duration = randomBetween(MIN_FALL_MS, MAX_FALL_MS);
	const animation = element.animate(fallingPath(), {
		duration,
		delay: -randomBetween(0, duration),
		iterations: Infinity,
		easing: 'linear',
	});

	return { element, animation };
}

export function startSnow(): () => void {
	const layer = window.document.createElement('div');
	layer.dataset.snowEffect = '';
	layer.setAttribute('aria-hidden', 'true');
	layer.style.cssText = [
		'position: fixed',
		'inset: 0',
		`z-index: ${LAYER_Z_INDEX}`,
		'overflow: hidden',
		'contain: strict',
		'pointer-events: none',
	].join(';');

	const snowflakes: Snowflake[] = [];

	function matchViewportWidth() {
		const count = snowflakeCount(window.innerWidth);

		while (snowflakes.length > count) {
			const { element, animation } = snowflakes.pop()!;
			// Web Animations는 요소를 지워도 멈추지 않는다
			animation.cancel();
			element.remove();
		}

		if (snowflakes.length < count) {
			const added = window.document.createDocumentFragment();
			while (snowflakes.length < count) {
				const snowflake = createSnowflake();
				snowflakes.push(snowflake);
				added.append(snowflake.element);
			}
			layer.append(added);
		}
	}

	let resizeTimer: number | null = null;

	function onResize() {
		if (resizeTimer != null) window.clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			resizeTimer = null;
			matchViewportWidth();
		}, RESIZE_SETTLE_MS);
	}

	matchViewportWidth();
	window.document.body.append(layer);
	window.addEventListener('resize', onResize, { passive: true });

	return () => {
		window.removeEventListener('resize', onResize);
		if (resizeTimer != null) window.clearTimeout(resizeTimer);
		for (const { animation } of snowflakes) animation.cancel();
		layer.remove();
	};
}
