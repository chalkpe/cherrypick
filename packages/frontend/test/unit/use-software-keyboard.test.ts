/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue';
import type { Ref } from 'vue';
import { useSoftwareKeyboard } from '@/composables/use-software-keyboard.js';

// 키보드 감지는 window/visualViewport 크기와 포커스 이벤트만으로 움직인다. 시험에서는 이 값들을 직접 놓는다.
const FULL_WIDTH = 390;
const FULL_HEIGHT = 844;
const KEYBOARD_HEIGHT = 300;

function setViewport(width: number, height: number): void {
	window.innerWidth = width;
	window.innerHeight = height;
}

function resizeTo(width: number, height: number): void {
	setViewport(width, height);
	window.dispatchEvent(new Event('resize'));
}

function makeTextarea(container: Element): HTMLTextAreaElement {
	const textarea = document.createElement('textarea');
	container.appendChild(textarea);
	return textarea;
}

function focusEl(el: HTMLElement): void {
	el.focus();
	document.dispatchEvent(new Event('focusin'));
}

function blurEl(el: HTMLElement): void {
	el.blur();
	document.dispatchEvent(new Event('focusout'));
}

// visualViewport만 줄어드는 경로(iOS Safari)를 재현한다. window.innerHeight는 그대로 둔다.
function installVisualViewport(height: number, scale = 1) {
	const listeners = new Set<() => void>();
	const stub = {
		height,
		scale,
		addEventListener: (_type: string, fn: () => void) => { listeners.add(fn); },
		removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
	};
	Object.defineProperty(window, 'visualViewport', { configurable: true, value: stub });
	return {
		set(nextHeight: number, nextScale = 1) {
			stub.height = nextHeight;
			stub.scale = nextScale;
			for (const fn of listeners) fn();
		},
	};
}

// KeepAlive로 캐시되는 페이지 안에서 컴포저블을 돌린다. 뒤로 물리면 deactivated, 돌아오면 activated가 일어난다.
function mountKeyboard(options?: { scope?: () => Element | null }) {
	const state: { visible: Readonly<Ref<boolean>> | null } = { visible: null };
	const show = ref(true);
	const Page = defineComponent({
		setup() {
			state.visible = useSoftwareKeyboard(options);
			return () => h('div', { 'data-testid': 'page' });
		},
	});
	const Host = defineComponent({
		setup() {
			return () => h(KeepAlive, null, { default: () => show.value ? h(Page) : h('div', { 'data-testid': 'other' }) });
		},
	});
	const utils = render(Host);
	return {
		isVisible: () => state.visible!.value,
		async setShow(value: boolean) {
			show.value = value;
			await nextTick();
			await nextTick();
		},
		utils,
	};
}

beforeEach(() => {
	setViewport(FULL_WIDTH, FULL_HEIGHT);
	Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
	document.body.innerHTML = '';
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test('detects the keyboard when a focused input shrinks the viewport by at least the threshold', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	expect(k.isVisible()).toBe(false);

	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);
});

test('the shrink threshold is 150px', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();

	resizeTo(FULL_WIDTH, FULL_HEIGHT - 149);
	expect(k.isVisible()).toBe(false);

	resizeTo(FULL_WIDTH, FULL_HEIGHT - 150);
	expect(k.isVisible()).toBe(true);
});

test('a shrink without a focused editable element is not the keyboard', () => {
	const k = mountKeyboard();
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(false);

	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	expect(k.isVisible()).toBe(true);
});

test('a non-editable focused element does not count as the keyboard', () => {
	const button = document.createElement('button');
	document.body.appendChild(button);
	focusEl(button);
	const k = mountKeyboard();

	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(false);
});

test('a visualViewport-only shrink is detected while innerHeight stays full', () => {
	const vv = installVisualViewport(FULL_HEIGHT);
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();

	vv.set(FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(window.innerHeight).toBe(FULL_HEIGHT);
	expect(k.isVisible()).toBe(true);
});

test('the scale guard ignores a pinch-zoom shrink', () => {
	const vv = installVisualViewport(FULL_HEIGHT);
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();

	vv.set(FULL_HEIGHT - KEYBOARD_HEIGHT, 2);
	expect(k.isVisible()).toBe(false);

	vv.set(FULL_HEIGHT - KEYBOARD_HEIGHT, 1);
	expect(k.isVisible()).toBe(true);
});

// 회전: 키보드가 열린 채 너비가 바뀌어도 감지가 유지된다 (줄어든 현재 높이를 전체 기준도로 다시 잡지 않는다)
test('a width change while the keyboard is open keeps detection', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	resizeTo(500, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);
});

test('a width change without the keyboard re-baselines the height', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();

	resizeTo(500, FULL_HEIGHT);
	expect(k.isVisible()).toBe(false);

	resizeTo(500, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);
});

test('focusout drops detection', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	blurEl(textarea);
	expect(k.isVisible()).toBe(false);
});

test('KeepAlive deactivation stops detection and drops the state', async () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	await k.setShow(false);
	expect(k.isVisible()).toBe(false);
});

// 스택의 뒤에 남은 화면: 포커스가 자기 페이지 밖(전경 화면의 입력란)에 있으면 키보드로 세지 않는다
test('a scoped detector ignores a focused input outside its own page', () => {
	const backgroundPage = document.createElement('div');
	const foregroundPage = document.createElement('div');
	document.body.appendChild(backgroundPage);
	document.body.appendChild(foregroundPage);
	const foregroundInput = makeTextarea(foregroundPage);
	focusEl(foregroundInput);

	const k = mountKeyboard({ scope: () => backgroundPage });
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(false);
});

test('a scoped detector sees a focused input inside its own page', () => {
	const page = document.createElement('div');
	document.body.appendChild(page);
	const input = makeTextarea(page);
	focusEl(input);

	const k = mountKeyboard({ scope: () => page });
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);
});

// 회전: 키보드가 열린 채 방향이 바뀌면 새 방향의 전체 높이(직전 너비)를 기준으로 잡아야 한다.
// 줄어든 현재 높이나 이전 방향의 전체 높이를 기준으로 남기면 키보드가 닫혀도 감지가 떨어지지 않는다
test('rotation with the keyboard open re-baselines to the new orientation full height', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	// 가로 회전: 전체 높이 390, 키보드 190 → 200. 감지 유지
	resizeTo(FULL_HEIGHT, 200);
	expect(k.isVisible()).toBe(true);

	// 포커스를 유지한 채 키보드가 닫히면 감지가 떨어져야 한다
	resizeTo(FULL_HEIGHT, FULL_WIDTH);
	expect(k.isVisible()).toBe(false);
});

test('rotation in a visualViewport-only environment converges when the keyboard closes', () => {
	const vv = installVisualViewport(FULL_HEIGHT);
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	vv.set(FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	// 회전: layout 높이는 새 방향 전체(390), visualViewport는 키보드만큼 축소(200)
	resizeTo(FULL_HEIGHT, FULL_WIDTH);
	vv.set(200);
	expect(k.isVisible()).toBe(true);

	vv.set(FULL_WIDTH);
	expect(k.isVisible()).toBe(false);
});

test('rotation with the keyboard open on tablet dimensions keeps detection and converges', () => {
	setViewport(768, 1024);
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	resizeTo(768, 724);
	expect(k.isVisible()).toBe(true);

	resizeTo(1024, 468);
	expect(k.isVisible()).toBe(true);

	resizeTo(1024, 768);
	expect(k.isVisible()).toBe(false);
});

// 높이 변화 없는 너비 변경(키보드 열린 채 회전 아님)은 기존 전체 높이 기준을 보존한다
test('a width-only change while the keyboard is open keeps the previous full-height baseline', () => {
	const textarea = makeTextarea(document.body);
	focusEl(textarea);
	const k = mountKeyboard();
	resizeTo(FULL_WIDTH, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	resizeTo(500, FULL_HEIGHT - KEYBOARD_HEIGHT);
	expect(k.isVisible()).toBe(true);

	resizeTo(500, FULL_HEIGHT);
	expect(k.isVisible()).toBe(false);
});
