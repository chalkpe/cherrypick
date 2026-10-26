/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/vue';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';

vi.mock('@/os.js', () => ({ popupMenu: vi.fn(), claimZIndex: () => 1000, alert: vi.fn(), launchUploader: vi.fn() }));
vi.mock('@/preferences.js', async () => ({
	prefer: (await import('./fake-prefer.js')).createFakePrefer({
		'voiceCall.echoCancellation': true,
		'voiceCall.noiseSuppression': true,
		'voiceCall.autoGainControl': true,
		'chat.sendOnEnter': false,
	}),
}));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: { policies: { canScreenShare: false } } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/voice-call.js', async () => {
	const { reactive } = await import('vue');
	const voiceCall = reactive({ status: 'connected', room: { id: 'r1', name: 'room 1' }, micEnabled: true, deafened: false, audioBlocked: false, screenSharing: false });
	return {
		voiceCall,
		canShareScreen: () => false,
		leaveVoiceCall: vi.fn(),
		resumeAudio: vi.fn(),
		setDeafened: vi.fn(),
		setMicEnabled: vi.fn(),
		startScreenShare: vi.fn(),
		stopScreenShare: vi.fn(),
		activeAudioDeviceId: () => 'default',
		selectAudioDevice: vi.fn(),
	};
});
// 入力欄の中身は置き場所と関係ないので、ブラウザの入力まわりに触る部品は差し替える
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { detach() {} } }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { show: vi.fn() } }));
vi.mock('@/utility/drive.js', () => ({ selectFile: vi.fn() }));

import { installFakeResizeObserver, resizeObserved } from './fake-resize-observer.js';
import { i18n } from '@/i18n.js';
import XVoiceCallBar from '@/ui/_common_/voice-call-bar.vue';
import XVoiceCallBarSlot from '@/ui/_common_/voice-call-bar-slot.vue';
import XForm from '@/pages/chat/room.form.vue';

// 入力欄の差し込み先の幅は ResizeObserver で測るので、テストから幅を決められるものに差し替える
installFakeResizeObserver();

const room = { id: 'r1', name: 'room 1' } as any;
const stubs = { MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' }, MkLoading: { template: '<span></span>' } };

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

async function setWidth(width: number) {
	window.innerWidth = width;
	window.dispatchEvent(new Event('resize'));
	await flush();
}

const bar = () => screen.getByRole('region', { name: i18n.ts._voiceCall.inCall });
const variantOf = (el: Element) => [...el.classList].find(name => /docked|top|floating/.test(name));
// 入力欄の絵文字ボタンと送信ボタンの間にある差し込み先
const chatFormSlot = (container: Element) => container.querySelector('.ti-mood-happy')!.closest('button')!.nextElementSibling!;

async function resizeElement(el: Element, width: number) {
	resizeObserved(width, el);
	await flush();
}

// 通話バーは common.vue に 1 つだけ置かれ、レイアウトの上端とチャットの入力欄にそれぞれ差し込み先がある
function renderApp(options: { form?: ReturnType<typeof ref<boolean>> } = {}) {
	const form = options.form ?? ref(true);
	const host = defineComponent({
		setup() {
			return () => h('div', [
				h(XVoiceCallBarSlot, { kind: 'top', 'data-testid': 'top' }),
				h('main', form.value ? [h(XForm, { room })] : []),
				h(XVoiceCallBar),
			]);
		},
	});
	return { form, ...render(host, { global: { stubs } }) };
}

beforeEach(async () => {
	await setWidth(1024);
});

afterEach(async () => {
	cleanup();
	await setWidth(1024);
});

describe('voice call bar placement', () => {
	test('docks into the chat form between the emoji button and the send button on PC', async () => {
		const { container } = renderApp();
		await flush();

		const footer = container.querySelector('footer')!;
		expect(footer.contains(bar())).toBe(true);
		const slot = bar().parentElement!;
		expect(slot.previousElementSibling?.querySelector('.ti-mood-happy')).not.toBeNull();
		expect(slot.nextElementSibling?.querySelector('.ti-send')).not.toBeNull();
		expect(variantOf(bar())).toMatch(/docked/);
		expect(screen.getAllByRole('region')).toHaveLength(1);
	});

	test('floats when no chat form is mounted', async () => {
		renderApp({ form: ref(false) });
		await flush();

		expect(screen.getByTestId('top').contains(bar())).toBe(false);
		expect(variantOf(bar())).toMatch(/floating/);
	});

	test('goes back to floating when the chat form goes away', async () => {
		const { form, container } = renderApp();
		await flush();
		expect(container.querySelector('footer')!.contains(bar())).toBe(true);

		form.value = false;
		await flush();

		expect(container.querySelector('footer')).toBeNull();
		expect(variantOf(bar())).toMatch(/floating/);
		expect(screen.getAllByRole('region')).toHaveLength(1);
	});

	test('leaves a chat form that is kept alive in the background', async () => {
		const showForm = ref(true);
		const host = defineComponent({
			setup() {
				return () => h('div', [
					h(KeepAlive, null, [showForm.value ? h(XForm, { room, key: 'form' }) : h('div', { key: 'other' })]),
					h(XVoiceCallBar),
				]);
			},
		});
		render(host, { global: { stubs } });
		await flush();
		expect(variantOf(bar())).toMatch(/docked/);

		showForm.value = false;
		await flush();

		expect(variantOf(bar())).toMatch(/floating/);
		expect(document.body.contains(bar())).toBe(true);
	});

	test('renders at the top on mobile, even with a chat form on screen', async () => {
		await setWidth(400);
		const { container } = renderApp();
		await flush();

		expect(screen.getByTestId('top').contains(bar())).toBe(true);
		expect(container.querySelector('footer')!.contains(bar())).toBe(false);
		expect(variantOf(bar())).toMatch(/top/);
		expect(screen.getAllByRole('region')).toHaveLength(1);
	});

	test('shows only the call status and no room name, wherever it is placed', async () => {
		const { form } = renderApp();
		await flush();
		expect(variantOf(bar())).toMatch(/docked/);
		expect(within(bar()).getByText(i18n.ts._voiceCall.inCall)).toBeTruthy();
		expect(within(bar()).queryByText(room.name)).toBeNull();

		form.value = false;
		await flush();
		expect(variantOf(bar())).toMatch(/floating/);
		expect(within(bar()).getByText(i18n.ts._voiceCall.inCall)).toBeTruthy();
		expect(within(bar()).queryByText(room.name)).toBeNull();

		await setWidth(400);
		expect(variantOf(bar())).toMatch(/top/);
		expect(within(bar()).getByText(i18n.ts._voiceCall.inCall)).toBeTruthy();
		expect(within(bar()).queryByText(room.name)).toBeNull();
	});

	test('floats when the chat form leaves too little room for the buttons', async () => {
		const { container } = renderApp();
		await flush();
		const slot = chatFormSlot(container);
		expect(slot.contains(bar())).toBe(true);

		await resizeElement(slot, 100);
		expect(variantOf(bar())).toMatch(/floating/);
		expect(slot.contains(bar())).toBe(false);
		expect(screen.getAllByRole('region')).toHaveLength(1);

		await resizeElement(slot, 300);
		expect(variantOf(bar())).toMatch(/docked/);
		expect(slot.contains(bar())).toBe(true);
	});

	test('docks in a 330px deck column, whose form leaves 180px between its buttons', async () => {
		const { container } = renderApp();
		await flush();
		const slot = chatFormSlot(container);

		await resizeElement(slot, 330 - 3 * 50);
		expect(variantOf(bar())).toMatch(/docked/);
		expect(slot.contains(bar())).toBe(true);
	});

	test('moves between the chat form and the top as the window is resized', async () => {
		const { container } = renderApp();
		await flush();
		expect(container.querySelector('footer')!.contains(bar())).toBe(true);

		await setWidth(400);
		expect(screen.getByTestId('top').contains(bar())).toBe(true);

		await setWidth(1024);
		expect(container.querySelector('footer')!.contains(bar())).toBe(true);
	});
});
