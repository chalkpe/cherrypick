/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import type { MockInstance } from 'vitest';

const mocks = vi.hoisted(() => ({ snowModuleLoaded: vi.fn() }));

// manager.ts → os.ts → preferences.ts 순환 import를 끊는다
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: vi.fn() }));

type Modules = {
	prefer: typeof import('@/preferences.js')['prefer'];
	watchSnowEffect: typeof import('@/utility/snow-effect-watcher.js')['watchSnowEffect'];
};

let prefer: Modules['prefer'];
let watchSnowEffect: Modules['watchSnowEffect'];
let dispose: (() => void) | null = null;
let reducedMotion: ReturnType<typeof stubReducedMotion>;
let animateSpy: MockInstance<Element['animate']>;
let snowModuleLoading: Promise<unknown> | null = null;

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

async function settle() {
	await nextTick();
	await vi.dynamicImportSettled();
	await snowModuleLoading;
	await new Promise(resolve => window.setTimeout(resolve));
	await nextTick();
}

async function expectSnowflakes(count: number) {
	await vi.waitFor(() => expect(flakeCount()).toBe(count), { timeout: 5000 });
}

async function turnOn() {
	prefer.commit('enableSnowEffect', true);
	await settle();
}

async function turnOnAndWait() {
	prefer.commit('enableSnowEffect', true);
	await expectSnowflakes(160);
}

async function waitForSnowModule() {
	await vi.waitFor(() => expect(mocks.snowModuleLoaded).toHaveBeenCalled(), { timeout: 5000 });
	await settle();
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
	vi.doMock('@/utility/snow-effect.js', async (importOriginal) => {
		mocks.snowModuleLoaded();
		snowModuleLoading = importOriginal();
		return await snowModuleLoading;
	});
	mocks.snowModuleLoaded.mockClear();
	snowModuleLoading = null;

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
	({ watchSnowEffect } = await import('@/utility/snow-effect-watcher.js'));
	await prefer.cloudReady;
});

afterEach(async () => {
	vi.useRealTimers();
	dispose?.();
	dispose = null;
	await settle();
	layer()?.remove();
	vi.restoreAllMocks();
});

test('기본값은 꺼짐이고, 꺼져 있으면 코드를 불러오지 않고 요소도 만들지 않는다', async () => {
	expect(prefer.s.enableSnowEffect).toBe(false);

	dispose = watchSnowEffect();
	await settle();

	expect(layer()).toBeNull();
	expect(mocks.snowModuleLoaded).not.toHaveBeenCalled();
	expect(animateSpy).not.toHaveBeenCalled();
});

test('켜면 새로 고침 없이 폭에 맞는 개수의 눈이 생긴다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();

	expect(mocks.snowModuleLoaded).toHaveBeenCalledTimes(1);
	expect(allAnimations()).toHaveLength(160);
});

test('시작할 때 이미 켜져 있으면 바로 내린다', async () => {
	prefer.commit('enableSnowEffect', true);

	dispose = watchSnowEffect();

	await expectSnowflakes(160);
});

test('끄면 요소, 애니메이션, 스타일이 모두 사라진다', async () => {
	const stylesBefore = window.document.querySelectorAll('style, link[rel="stylesheet"]').length;

	dispose = watchSnowEffect();
	await turnOnAndWait();

	prefer.commit('enableSnowEffect', false);
	await settle();

	expect(layer()).toBeNull();
	expect(allAnimations()).toHaveLength(160);
	for (const animation of allAnimations()) expect(animation.playState).toBe('idle');
	expect(window.document.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(stylesBefore);
});

test('다시 켜면 다시 내리고, 겹쳐서 만들지 않는다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();
	prefer.commit('enableSnowEffect', false);
	await settle();
	await turnOnAndWait();

	expect(window.document.querySelectorAll('[data-snow-effect]')).toHaveLength(1);
});

test('불러오는 사이에 끄면 눈을 만들지 않는다', async () => {
	dispose = watchSnowEffect();
	prefer.commit('enableSnowEffect', true);
	await nextTick();
	prefer.commit('enableSnowEffect', false);
	await waitForSnowModule();

	expect(mocks.snowModuleLoaded).toHaveBeenCalledTimes(1);
	expect(layer()).toBeNull();
});

test('불러오는 사이에 껐다가 다시 켜도 눈은 한 벌만 생긴다', async () => {
	dispose = watchSnowEffect();
	prefer.commit('enableSnowEffect', true);
	await nextTick();
	prefer.commit('enableSnowEffect', false);
	await nextTick();
	prefer.commit('enableSnowEffect', true);
	await waitForSnowModule();
	await expectSnowflakes(160);

	expect(window.document.querySelectorAll('[data-snow-effect]')).toHaveLength(1);
});

test('기기가 움직임 줄이기면 켜져 있어도 생기지 않는다', async () => {
	prefer.commit('animation', true);
	reducedMotion.set(true);

	dispose = watchSnowEffect();
	await turnOn();

	expect(layer()).toBeNull();
	expect(mocks.snowModuleLoaded).not.toHaveBeenCalled();
});

test('켜진 채로 기기의 움직임 줄이기가 바뀌면 그대로 따라간다', async () => {
	prefer.commit('animation', true);
	dispose = watchSnowEffect();
	await turnOnAndWait();

	reducedMotion.set(true);
	await settle();
	expect(layer()).toBeNull();

	reducedMotion.set(false);
	await expectSnowflakes(160);
});

test('애니메이션 설정이 꺼져 있으면 생기지 않고, 설정을 바꾸면 따라간다', async () => {
	prefer.commit('animation', false);
	dispose = watchSnowEffect();
	await turnOn();
	expect(layer()).toBeNull();

	prefer.commit('animation', true);
	await expectSnowflakes(160);

	prefer.commit('animation', false);
	await settle();
	expect(layer()).toBeNull();
});

test('팝아웃 창(?zen)에서는 켜져 있어도 내리지 않는다', async () => {
	window.history.replaceState(null, '', '/notes/abc?zen');

	dispose = watchSnowEffect();
	await turnOn();

	expect(layer()).toBeNull();
	expect(mocks.snowModuleLoaded).not.toHaveBeenCalled();
});

test('감시를 멈추면 눈과 기기 설정 구독을 모두 정리한다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();
	expect(reducedMotion.listeners.size).toBe(1);

	dispose();
	dispose = null;

	expect(layer()).toBeNull();
	expect(reducedMotion.listeners.size).toBe(0);
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

test('레이어는 고정 위치이고 입력을 막지 않으며 대화상자 아래에 있고 보조 기술에서 숨겨진다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();
	const el = layer()!;

	expect(el.parentElement).toBe(window.document.body);
	expect(el.style.position).toBe('fixed');
	expect(el.style.pointerEvents).toBe('none');
	expect(el.style.overflow).toBe('hidden');
	expect(el.getAttribute('aria-hidden')).toBe('true');
	// claimZIndex의 최솟값이 500000이다
	expect(Number(el.style.zIndex)).toBeGreaterThan(10000);
	expect(Number(el.style.zIndex)).toBeLessThan(500000);
});

test('눈은 transform만 움직이고, 시작부터 흩어져 있으며, 시간과 크기와 흔들림이 제각각이다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();

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
});

test('창 폭이 바뀌면 개수를 맞추고, 줄인 만큼 애니메이션을 멈춘다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();
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
});

test('폭이 그대로이면 높이만 바뀌어도 눈을 다시 만들지 않는다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();
	const first = layer()!.firstElementChild;
	const animateCount = animateSpy.mock.calls.length;

	vi.useFakeTimers();
	window.dispatchEvent(new Event('resize'));
	vi.advanceTimersByTime(1000);

	expect(layer()!.firstElementChild).toBe(first);
	expect(animateSpy.mock.calls.length).toBe(animateCount);
});

test('끈 뒤에는 창 크기가 바뀌어도 눈이 되살아나지 않는다', async () => {
	dispose = watchSnowEffect();
	await turnOnAndWait();
	prefer.commit('enableSnowEffect', false);
	await settle();
	const animateCount = animateSpy.mock.calls.length;

	vi.useFakeTimers();
	setViewportWidth(1920);
	window.dispatchEvent(new Event('resize'));
	vi.advanceTimersByTime(1000);

	expect(layer()).toBeNull();
	expect(animateSpy.mock.calls.length).toBe(animateCount);
});
