/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, ref } from 'vue';

vi.mock('@/os.js', () => ({ claimZIndex: () => 3000000 }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false, menuStyle: 'popup' }) }));
vi.mock('@/utility/touch.js', () => ({ isTouchUsing: false }));
vi.mock('@/utility/device-kind.js', () => ({ deviceKind: 'desktop' }));

import MkModal from '@/components/MkModal.vue';
import MkPopupMenu from '@/components/MkPopupMenu.vue';

const fullscreenDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	if (fullscreenDescriptor) Object.defineProperty(document, 'fullscreenElement', fullscreenDescriptor);
	else Reflect.deleteProperty(document, 'fullscreenElement');
});

function setup(fullscreen = true) {
	const viewer = document.createElement('div');
	const anchor = document.createElement('button');
	anchor.textContent = 'Volume';
	viewer.append(anchor);
	document.body.append(viewer);
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen ? viewer : null });
	const instance = ref<InstanceType<typeof MkModal>>();
	const host = defineComponent({
		emits: ['close'],
		setup(_, { emit }) {
			return () => h(MkModal, { ref: instance, anchorElement: anchor, onClose: () => emit('close') }, { default: () => h('input', { 'aria-label': 'Volume slider', type: 'range' }) });
		},
	});
	const modal = render(host, { global: { directives: { hotkey: {} } } });
	const container = modal.container as HTMLElement;

	return { viewer, anchor, modal, container, instance };
}

test('renders an anchored menu inside fullscreen and restores controls on close', async () => {
	const { viewer, anchor, instance } = setup();
	await nextTick();
	const slider = document.querySelector('input')!;
	expect(viewer.contains(slider)).toBe(true);
	expect(viewer.inert).not.toBe(true);
	instance.value!.close();
	await nextTick();
	expect(anchor.inert).toBe(false);
	expect(document.activeElement).toBe(anchor);
});

test('keeps ordinary menus in their usual popup host', async () => {
	const { viewer } = setup(false);
	await nextTick();
	expect(viewer.contains(document.querySelector('input'))).toBe(false);
});

test('dismisses the menu when fullscreen ends and releases inert state', async () => {
	const { anchor, modal } = setup();
	await nextTick();
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
	document.dispatchEvent(new Event('fullscreenchange'));
	await nextTick();
	expect(modal.emitted().close).toHaveLength(1);
	expect(anchor.inert).toBe(false);
	expect(anchor.style.pointerEvents).not.toBe('none');
});

test('releases the page if the fullscreen share disappears with a menu open', async () => {
	const { viewer, container } = setup();
	await nextTick();
	viewer.remove();
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
	document.dispatchEvent(new Event('fullscreenchange'));
	await nextTick();
	expect(container.inert).toBe(false);
});

test.each([false, true])('closes the actual popup on fullscreen exit (removed host: %s)', async (removeHost) => {
	const viewer = document.createElement('div');
	const anchor = document.createElement('button');
	viewer.append(anchor);
	document.body.append(viewer);
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: viewer });
	const menu = render(MkPopupMenu, {
		props: { anchorElement: anchor, items: [{ text: 'Volume', action: () => {} }] },
		global: { directives: { hotkey: {}, tooltip: {}, adaptiveBorder: {} }, stubs: { MkA: true, MkAvatar: true, MkUserName: true, MkEllipsis: true, MkLoading: true, Mfm: true } },
	});
	await nextTick();
	expect(anchor.inert).toBe(true);
	if (removeHost) viewer.remove();
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
	document.dispatchEvent(new Event('fullscreenchange'));
	await nextTick();
	expect(menu.emitted().closing).toHaveLength(1);
	expect(anchor.inert).toBe(false);
	expect((menu.container as HTMLElement).inert).toBe(false);
});

test.each([false, true])('passes fallthrough attributes to the modal root (fullscreen: %s)', async (fullscreen) => {
	const { anchor } = setup(fullscreen);
	cleanup();
	const modal = render(MkModal, {
		props: { anchorElement: anchor },
		attrs: { 'data-testid': 'some-dialog' },
		slots: { default: () => h('input', { type: 'range' }) },
		global: { directives: { hotkey: {} } },
	});
	await nextTick();
	expect(document.querySelector('[data-testid="some-dialog"] input')).not.toBeNull();
	modal.unmount();
});
