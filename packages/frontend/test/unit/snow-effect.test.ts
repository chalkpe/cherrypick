/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { render } from '@testing-library/vue';
import type { MockInstance } from 'vitest';

// manager.ts → os.ts → preferences.ts 순환 import를 끊는다
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: vi.fn() }));

type PreferMod = typeof import('@/preferences.js');
type WatcherMod = typeof import('@/utility/snow-effect-watcher.js');

let prefer: PreferMod['prefer'];
let watcher: WatcherMod;
let dispose: (() => void) | null = null;
let reducedMotion: ReturnType<typeof stubReducedMotion>;
let animateSpy: MockInstance<Element['animate']>;

function stubReducedMotion(initial: boolean) {
	const listeners = new Set<(ev: MediaQueryListEvent) => void>();
	const list = {
		matches: initial,
		addEventListener: (_type: string, listener: (ev: MediaQueryListEvent) => void) => listeners.add(listener),
		removeEventListener: (_type: string, listener: (ev: MediaQueryListEvent) => void) => listeners.delete(listener),
	};
	vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => (
		query.includes('prefers-reduced-motion') ? list as unknown as MediaQueryList : { matches: false } as MediaQueryList
	));
	return {
		listeners,
		set(matches: boolean) {
			list.matches = matches;
			for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
		},
	};
}

function setViewportWidth(width: number) {
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function layer() {
	return window.document.querySelector<HTMLElement>('[data-snow-effect]');
}

function flakeCount() {
	return layer()?.childElementCount ?? 0;
}

function allAnimations(): Animation[] {
	return animateSpy.mock.results.map(result => result.value as Animation);
}

beforeEach(async () => {
	// vi.mock의 결과는 resetModules로 지워지지 않아 doMock으로 등록한다
	vi.resetModules();
	// setup.unit.ts의 가짜 prefer에는 기본값이 없다
	vi.doMock('@/preferences.js', async () => {
		const { PreferencesManager } = await import('@/preferences/manager.js');
		return { prefer: new PreferencesManager({
			load: () => null, save: () => {}, cloudGet: async () => null,
			cloudGetBulk: async () => ({}), cloudSet: async () => {},
		}, { id: 'viewer' }) };
	});

	window.history.replaceState(null, '', '/');
	setViewportWidth(1280);
	reducedMotion = stubReducedMotion(false);

	const originalAnimate = Element.prototype.animate;
	animateSpy = vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element, keyframes, options) {
		const animation = originalAnimate.call(this, keyframes, options);
		// happy-dom은 브라우저와 달리 cancel()로 거부된 finished를 처리됨으로 표시하지 않는다
		animation.finished.catch(() => {});
		return animation;
	});

	({ prefer } = await import('@/preferences.js'));
	watcher = await import('@/utility/snow-effect-watcher.js');
	await prefer.cloudReady;
});

afterEach(() => {
	vi.useRealTimers();
	dispose?.();
	dispose = null;
	vi.restoreAllMocks();
});

describe('언제 내리는지', () => {
	test('기본값은 꺼짐이다', () => {
		expect(prefer.s.enableSnowEffect).toBe(false);

		dispose = watcher.watchSnowEffect();

		expect(watcher.snowEffectShowing.value).toBe(false);
	});

	test('켜고 끄면 새로 고침 없이 따라간다', async () => {
		dispose = watcher.watchSnowEffect();

		prefer.commit('enableSnowEffect', true);
		await nextTick();
		expect(watcher.snowEffectShowing.value).toBe(true);

		prefer.commit('enableSnowEffect', false);
		await nextTick();
		expect(watcher.snowEffectShowing.value).toBe(false);
	});

	test('시작할 때 이미 켜져 있으면 바로 내린다', () => {
		prefer.commit('enableSnowEffect', true);

		dispose = watcher.watchSnowEffect();

		expect(watcher.snowEffectShowing.value).toBe(true);
	});

	test('기기가 움직임 줄이기면 켜져 있어도 내리지 않고, 켜진 채로 바뀌면 따라간다', async () => {
		prefer.commit('animation', true);
		prefer.commit('enableSnowEffect', true);
		reducedMotion.set(true);

		dispose = watcher.watchSnowEffect();
		expect(watcher.snowEffectShowing.value).toBe(false);

		reducedMotion.set(false);
		await nextTick();
		expect(watcher.snowEffectShowing.value).toBe(true);

		reducedMotion.set(true);
		await nextTick();
		expect(watcher.snowEffectShowing.value).toBe(false);
	});

	test('애니메이션 설정이 꺼져 있으면 내리지 않고, 설정을 바꾸면 따라간다', async () => {
		prefer.commit('animation', false);
		prefer.commit('enableSnowEffect', true);

		dispose = watcher.watchSnowEffect();
		expect(watcher.snowEffectShowing.value).toBe(false);

		prefer.commit('animation', true);
		await nextTick();
		expect(watcher.snowEffectShowing.value).toBe(true);
	});

	test('팝아웃 창(?zen)에서는 켜져 있어도 내리지 않는다', () => {
		window.history.replaceState(null, '', '/notes/abc?zen');
		prefer.commit('enableSnowEffect', true);

		dispose = watcher.watchSnowEffect();

		expect(watcher.snowEffectShowing.value).toBe(false);
	});

	test('감시를 시작하지 않은 화면(sub-boot)에서는 켜져 있어도 내리지 않는다', () => {
		prefer.commit('enableSnowEffect', true);

		expect(watcher.snowEffectShowing.value).toBe(false);
	});

	test('감시를 멈추면 끄고 기기 설정 구독도 푼다', () => {
		prefer.commit('enableSnowEffect', true);
		dispose = watcher.watchSnowEffect();
		expect(reducedMotion.listeners.size).toBe(1);

		dispose();
		dispose = null;

		expect(watcher.snowEffectShowing.value).toBe(false);
		expect(reducedMotion.listeners.size).toBe(0);
	});
});

describe('눈 레이어', () => {
	async function mountSnow() {
		const SnowEffect = (await import('@/ui/_common_/snow-effect.vue')).default;
		const showing = ref(true);
		const view = render(defineComponent({ render: () => h('div', { id: 'host' }, showing.value ? [h(SnowEffect)] : []) }));
		await nextTick();
		return { view, showing };
	}

	test('폭에 맞는 개수의 눈이 생긴다', async () => {
		const { view } = await mountSnow();

		expect(flakeCount()).toBe(160);
		expect(allAnimations()).toHaveLength(160);
		view.unmount();
	});

	test('사라지면 요소와 애니메이션, 창 크기 구독이 모두 정리된다', async () => {
		const stylesBefore = window.document.querySelectorAll('style, link[rel="stylesheet"]').length;
		const { view, showing } = await mountSnow();

		showing.value = false;
		await nextTick();

		expect(layer()).toBeNull();
		expect(allAnimations()).toHaveLength(160);
		for (const animation of allAnimations()) expect(animation.playState).toBe('idle');
		expect(window.document.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(stylesBefore);

		const animateCount = animateSpy.mock.calls.length;
		vi.useFakeTimers();
		setViewportWidth(1920);
		window.dispatchEvent(new Event('resize'));
		vi.advanceTimersByTime(1000);
		expect(animateSpy.mock.calls.length).toBe(animateCount);
		view.unmount();
	});

	test('부모 안에 그려지고, 입력을 막지 않으며, 팝업보다 낮고, 보조 기술에서 숨겨진다', async () => {
		const { view } = await mountSnow();
		const el = layer()!;

		expect(el.parentElement?.id).toBe('host');
		expect(el.style.position).toBe('fixed');
		expect(el.style.pointerEvents).toBe('none');
		expect(el.style.overflow).toBe('hidden');
		expect(el.getAttribute('aria-hidden')).toBe('true');
		// claimZIndex의 최솟값이 500000이다
		expect(Number(el.style.zIndex)).toBeGreaterThan(10000);
		expect(Number(el.style.zIndex)).toBeLessThan(500000);
		view.unmount();
	});

	test('눈은 transform만 움직이고, 시작부터 흩어져 있으며, 시간과 크기와 흔들림이 제각각이다', async () => {
		const { view } = await mountSnow();

		const calls = animateSpy.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
		const durations = new Set<number>();
		const paths = new Set<string>();
		for (const [keyframes, options] of calls) {
			for (const keyframe of keyframes) expect(Object.keys(keyframe)).toEqual(['transform']);
			const duration = options.duration as number;
			expect(duration).toBeGreaterThanOrEqual(10000);
			expect(duration).toBeLessThanOrEqual(30000);
			expect(options.iterations).toBe(Infinity);
			expect(options.easing).toBe('linear');
			expect(options.delay as number).toBeLessThanOrEqual(0);
			expect(options.delay as number).toBeGreaterThan(-duration);
			durations.add(duration);
			paths.add(JSON.stringify(keyframes));
		}
		expect(durations.size).toBeGreaterThan(50);
		expect(paths.size).toBe(calls.length);

		const delays = calls.map(([, options]) => options.delay as number);
		expect(delays.filter(delay => delay < -5000).length).toBeGreaterThan(calls.length / 3);

		const flakes = [...layer()!.children] as HTMLElement[];
		expect(new Set(flakes.map(flake => flake.style.width)).size).toBeGreaterThan(5);
		expect(new Set(flakes.map(flake => flake.style.opacity)).size).toBeGreaterThan(5);
		expect(new Set(flakes.map(flake => flake.style.left)).size).toBeGreaterThan(50);
		for (const flake of flakes) expect(flake.style.left).toMatch(/%$/);
		view.unmount();
	});

	test('창 폭이 바뀌면 개수를 맞추고, 줄인 만큼 애니메이션을 멈춘다', async () => {
		const { view } = await mountSnow();
		const removable = allAnimations().slice();

		vi.useFakeTimers();
		setViewportWidth(360);
		window.dispatchEvent(new Event('resize'));
		vi.advanceTimersByTime(1000);
		expect(flakeCount()).toBe(45);
		expect(removable.filter(animation => animation.playState === 'idle')).toHaveLength(160 - 45);

		setViewportWidth(1920);
		window.dispatchEvent(new Event('resize'));
		vi.advanceTimersByTime(1000);
		expect(flakeCount()).toBe(200);
		view.unmount();
	});

	test('폭이 그대로이면 높이만 바뀌어도 눈을 다시 만들지 않는다', async () => {
		const { view } = await mountSnow();
		const first = layer()!.firstElementChild;
		const animateCount = animateSpy.mock.calls.length;

		vi.useFakeTimers();
		window.dispatchEvent(new Event('resize'));
		vi.advanceTimersByTime(1000);

		expect(layer()!.firstElementChild).toBe(first);
		expect(animateSpy.mock.calls.length).toBe(animateCount);
		view.unmount();
	});

	test('개수는 폭에 비례하고 넓은 화면에서는 상한에서 멈춘다', async () => {
		const { snowflakeCount, MAX_SNOWFLAKES } = await import('@/utility/snow-effect.js');

		expect(MAX_SNOWFLAKES).toBe(200);
		expect(snowflakeCount(360)).toBe(45);
		expect(snowflakeCount(1280)).toBe(160);
		expect(snowflakeCount(1600)).toBe(200);
		expect(snowflakeCount(1920)).toBe(200);
		expect(snowflakeCount(7680)).toBe(200);
		expect(snowflakeCount(0)).toBe(0);
	});
});
