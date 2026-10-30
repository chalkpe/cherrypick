/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/vue';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import type { Ref } from 'vue';

vi.mock('@/os.js', () => ({ popupMenu: vi.fn(), claimZIndex: () => 1000, alert: vi.fn(), launchUploader: vi.fn(), inputText: vi.fn() }));
vi.mock('@/preferences.js', async () => ({
	prefer: (await import('./fake-prefer.js')).createFakePrefer({
		'voiceCall.echoCancellation': true,
		'voiceCall.noiseSuppression': true,
		'voiceCall.autoGainControl': true,
		'voiceCall.micEnabled': true,
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
import { voiceCall } from '@/utility/voice-call.js';
import { useVoiceCallStatusAnnouncer } from '@/utility/voice-call-status.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import XVoiceCallBar from '@/ui/_common_/voice-call-bar.vue';
import XVoiceCallBarSlot from '@/ui/_common_/voice-call-bar-slot.vue';
import XForm from '@/pages/chat/room.form.vue';

// 入力欄の差し込み先の幅は ResizeObserver で測るので、テストから幅を決められるものに差し替える
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
const originalWidth = window.innerWidth;
installFakeResizeObserver();
afterAll(() => {
	if (resizeObserverDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
	else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

const room = { id: 'r1', name: 'room 1' } as any;
const stubs = { MkDraggable: { props: ['modelValue'], template: '<div><slot v-for="item in modelValue" :item="item"/></div>' }, MkDriveFileThumbnail: { props: ['file'], template: '<img :alt="file.name" />' }, MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' }, MkLoading: { template: '<span></span>' } };

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
	(voiceCall as unknown as { audioBlocked: boolean }).audioBlocked = false;
	await setWidth(1024);
});

afterEach(async () => {
	cleanup();
	await setWidth(originalWidth);
	window.localStorage.clear();
});

describe('chat attachments', () => {
	beforeEach(() => {
		vi.mocked(os.launchUploader).mockReset().mockResolvedValue([{ id: 'f1', name: 'image.png', type: 'image/png', properties: { width: 160, height: 160 }, url: '/image.png', isSensitive: false }] as any);
		vi.mocked(os.alert).mockReset();
	});

	function transferEvent(type: string, property: string, value: unknown) {
		const event = new Event(type, { bubbles: true, cancelable: true });
		Object.defineProperty(event, property, { value });
		return event;
	}

	test('attaches the uploaded drop result and sends its file id', async () => {
		const { misskeyApi } = await import('@/utility/misskey-api.js');
		vi.mocked(misskeyApi).mockReset().mockResolvedValue({} as any);
		render(XForm, { props: { room }, global: { stubs } });
		const image = new File(['image'], 'drop.png', { type: 'image/png' });
		const event = transferEvent('drop', 'dataTransfer', { files: [image] });
		await fireEvent(screen.getByRole('textbox'), event);
		await flush();
		expect(event.defaultPrevented).toBe(true);
		expect(os.launchUploader).toHaveBeenCalledWith([image], { multiple: false });
		expect(screen.getByRole('img', { name: 'image.png' })).toBeTruthy();
		await fireEvent.click(screen.getByTitle(i18n.ts.send));
		expect(misskeyApi).toHaveBeenCalledWith('chat/messages/create-to-room', expect.objectContaining({ fileId: 'f1' }));
	});

	test('accepts a clipboard image alongside text and HTML representations', async () => {
		render(XForm, { props: { room }, global: { stubs } });
		const image = new File(['image'], 'clipboard.png', { type: 'image/png' });
		const event = transferEvent('paste', 'clipboardData', { items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => image }], files: [] });
		await fireEvent(screen.getByRole('textbox'), event);
		await flush();
		expect(event.defaultPrevented).toBe(true);
		expect(os.launchUploader).toHaveBeenCalledTimes(1);
		expect(vi.mocked(os.launchUploader).mock.calls[0][0][0].type).toBe('image/png');
		expect(screen.getByRole('img', { name: 'image.png' })).toBeTruthy();
	});

	test('shows a single-file preview with the note attachment editing menu', async () => {
		const { misskeyApi } = await import('@/utility/misskey-api.js');
		vi.mocked(misskeyApi).mockReset().mockResolvedValue({} as any);
		vi.mocked(os.popupMenu).mockReset().mockResolvedValue(undefined);
		vi.mocked(os.inputText).mockResolvedValueOnce({ canceled: false, result: 'renamed.png' });
		render(XForm, { props: { room }, global: { stubs } });
		await fireEvent(screen.getByRole('textbox'), transferEvent('drop', 'dataTransfer', { files: [new File(['image'], 'a.png', { type: 'image/png' })] }));
		await flush();
		expect(screen.getByText('1/1')).toBeTruthy();
		expect(screen.getByRole('img', { name: 'image.png' }).compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await fireEvent.click(screen.getByRole('img', { name: 'image.png' }).closest('[role="button"]')!);
		const items = vi.mocked(os.popupMenu).mock.calls[0][0] as any[];
		expect(items.map(item => item.text)).toEqual(expect.arrayContaining([i18n.ts.renameFile, i18n.ts.describeFile, i18n.ts.preview, i18n.ts.attachCancel]));
		await items.find(item => item.text === i18n.ts.renameFile).action();
		await flush();
		expect(screen.getByRole('img', { name: 'renamed.png' })).toBeTruthy();
	});

	test('ignores an old rename response after its attachment is removed', async () => {
		const { misskeyApi } = await import('@/utility/misskey-api.js');
		let finish!: (value: any) => void;
		vi.mocked(misskeyApi).mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		vi.mocked(os.popupMenu).mockReset().mockResolvedValue(undefined);
		vi.mocked(os.inputText).mockResolvedValueOnce({ canceled: false, result: 'old-name.png' });
		render(XForm, { props: { room }, global: { stubs } });
		await fireEvent(screen.getByRole('textbox'), transferEvent('drop', 'dataTransfer', { files: [new File(['image'], 'a.png', { type: 'image/png' })] }));
		await flush();
		await fireEvent.click(screen.getByRole('img', { name: 'image.png' }).closest('[role="button"]')!);
		const items = vi.mocked(os.popupMenu).mock.calls[0][0] as any[];
		items.find(item => item.text === i18n.ts.renameFile).action();
		await flush();
		items.find(item => item.text === i18n.ts.attachCancel).action();
		await flush();
		finish({});
		await flush();
		expect(screen.queryByRole('img')).toBeNull();
	});

	test('keeps ordinary text paste native and handles an empty drag item list', async () => {
		render(XForm, { props: { room }, global: { stubs } });
		const input = screen.getByRole('textbox');
		const paste = transferEvent('paste', 'clipboardData', { items: [{ kind: 'string' }], files: [] });
		await fireEvent(input, paste);
		expect(paste.defaultPrevented).toBe(false);
		const drag = transferEvent('dragover', 'dataTransfer', { types: ['Files'], items: [], effectAllowed: 'all' });
		await fireEvent(input, drag);
		expect(drag.defaultPrevented).toBe(true);
		expect(os.launchUploader).not.toHaveBeenCalled();
	});

	test('rejects multiple clipboard files and leaves the draft intact when upload is cancelled', async () => {
		render(XForm, { props: { room }, global: { stubs } });
		const input = screen.getByRole('textbox');
		await fireEvent.update(input, 'draft');
		const image = new File(['image'], 'a.png', { type: 'image/png' });
		const multi = transferEvent('paste', 'clipboardData', { items: [], files: [image, image] });
		await fireEvent(input, multi);
		expect(os.alert).toHaveBeenCalledWith(expect.objectContaining({ text: i18n.ts.onlyOneFileCanBeAttached }));
		expect(os.launchUploader).not.toHaveBeenCalled();
		vi.mocked(os.launchUploader).mockRejectedValueOnce(undefined);
		await fireEvent(input, transferEvent('drop', 'dataTransfer', { files: [image] }));
		await flush();
		expect((input as HTMLTextAreaElement).value).toBe('draft');
	});
});

describe('voice call bar placement', () => {
	test('keeps the bar in the most recently focused of two visible forms', async () => {
		const later = ref(false);
		const host = defineComponent({ setup: () => () => h('div', [
			h('section', { 'data-testid': 'first' }, [h(XForm, { room })]),
			later.value ? h('section', { 'data-testid': 'second' }, [h(XForm, { room: { ...room, id: 'r2' } })]) : null,
			h(XVoiceCallBar),
		]) });
		render(host, { global: { stubs } });
		await flush();
		const first = screen.getByTestId('first');
		within(first).getByRole('textbox').focus();
		later.value = true;
		await flush();
		expect(first.contains(bar())).toBe(true);

		within(screen.getByTestId('second')).getByRole('textbox').focus();
		await flush();
		expect(screen.getByTestId('second').contains(bar())).toBe(true);

		within(first).getByRole('textbox').focus();
		await flush();
		expect(first.contains(bar())).toBe(true);
		await resizeElement(chatFormSlot(first), 100);
		expect(variantOf(bar())).toMatch(/floating/);
	});

	test.each(['display', 'visibility', 'hidden', 'inert'])('ignores a last-mounted form hidden by ancestor %s and follows it when shown', async mode => {
		const hidden = ref(true);
		const host = defineComponent({ setup: () => () => h('div', [
			h('section', { 'data-testid': 'first' }, [h(XForm, { room })]),
			h('section', {
				'data-testid': 'second',
				style: mode === 'display' ? { display: hidden.value ? 'none' : '' } : mode === 'visibility' ? { visibility: hidden.value ? 'hidden' : '' } : undefined,
				[mode]: mode === 'hidden' || mode === 'inert' ? hidden.value : undefined,
			}, [h(XForm, { room: { ...room, id: 'r2' } })]),
			h(XVoiceCallBar),
		]) });
		render(host, { global: { stubs } });
		await flush();
		expect(screen.getByTestId('first').contains(bar())).toBe(true);
		hidden.value = false;
		await new Promise(resolve => setTimeout(resolve, 0));
		await flush();
		expect(screen.getByTestId('second').contains(bar())).toBe(true);
		within(screen.getByTestId('second')).getByRole('textbox').focus();
		hidden.value = true;
		await new Promise(resolve => setTimeout(resolve, 0));
		await flush();
		expect(screen.getByTestId('first').contains(bar())).toBe(true);
	});

	test.each([{ ctrlKey: true }, { metaKey: true }])('sends only once while the request is pending with %o', async modifier => {
		const { misskeyApi } = await import('@/utility/misskey-api.js');
		let finish!: (value: any) => void;
		vi.mocked(misskeyApi).mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		render(XForm, { props: { room }, global: { stubs } });
		const input = screen.getByRole('textbox');
		await fireEvent.update(input, 'hello');
		await fireEvent.keyDown(input, { key: 'Enter', ...modifier });
		await fireEvent.keyDown(input, { key: 'Enter', ...modifier });
		expect(misskeyApi).toHaveBeenCalledTimes(1);
		finish({});
		await flush();
		await fireEvent.update(input, 'next');
		await fireEvent.keyDown(input, { key: 'Enter', ...modifier });
		expect(misskeyApi).toHaveBeenCalledTimes(2);
		finish({});
		await flush();
	});

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

	test('does not dock into a chat form that appears while its page waits in the background', async () => {
		const showPage = ref(true);
		const showForm = ref(false);
		const page = defineComponent({
			setup() {
				return () => h('div', showForm.value ? [h(XForm, { room })] : []);
			},
		});
		const host = defineComponent({
			setup() {
				return () => h('div', [
					h(KeepAlive, null, [showPage.value ? h(page, { key: 'page' }) : h('div', { key: 'other' })]),
					h(XVoiceCallBar),
				]);
			},
		});
		render(host, { global: { stubs } });
		await flush();
		expect(variantOf(bar())).toMatch(/floating/);

		showPage.value = false;
		await flush();
		// 裏に回ったページで入力欄が出ても (読み込みが終わったときなど)、どこにも描かれない所へは差し込まない
		showForm.value = true;
		await flush();
		expect(variantOf(bar())).toMatch(/floating/);
		expect(window.document.body.contains(bar())).toBe(true);

		showPage.value = true;
		await flush();
		expect(variantOf(bar())).toMatch(/docked/);
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

	test('keeps a named return link and a dedicated audio icon in a narrow slot', async () => {
		(voiceCall as unknown as { audioBlocked: boolean }).audioBlocked = true;
		const { container } = renderApp();
		await flush();
		await resizeElement(chatFormSlot(container), 190);
		expect(within(bar()).getByRole('link', { name: i18n.ts._voiceCall.backToRoom })).toBeTruthy();
		const audio = within(bar()).getByRole('button', { name: i18n.ts._voiceCall.enableAudio });
		expect(audio.querySelector('i')).not.toBeNull();
	});

	describe('beside the call card of the room in the call', () => {
		// ルーム画面の通話カードやステージの代わり。見えているあいだは、ルームの中で通話の状態と操作を出している
		const XCallCard = defineComponent({
			setup() {
				const el = ref<HTMLElement | null>(null);
				useVoiceCallStatusAnnouncer(ref(true), el);
				return () => h('div', { ref: el }, 'call card');
			},
		});

		function renderRoom(options: { card: Ref<boolean>; cardVisible?: Ref<boolean> }) {
			const host = defineComponent({
				setup() {
					return () => h('div', [
						h(XVoiceCallBarSlot, { kind: 'top', 'data-testid': 'top' }),
						h('main', [
							h('section', { style: { display: options.cardVisible?.value === false ? 'none' : '' } }, options.card.value ? [h(XCallCard)] : []),
							h(XForm, { room }),
						]),
						h(XVoiceCallBar),
					]);
				},
			});
			return render(host, { global: { stubs } });
		}

		const queryBar = () => screen.queryByRole('region', { name: i18n.ts._voiceCall.inCall });
		const statusLive = () => within(bar()).getByText(i18n.ts._voiceCall.inCall).getAttribute('aria-live');

		// 狭いデッキの列などで入力欄に収まらないとき、浮かせたバーはカードと同じ操作を重ねて出し、入力欄も覆ってしまう
		test('on PC hides the bar instead of floating it over the room while the card shows the call', async () => {
			const card = ref(true);
			const { container } = renderRoom({ card });
			await flush();
			const slot = chatFormSlot(container);

			await resizeElement(slot, 100);
			expect(queryBar()).toBeNull();

			// カードが無くなれば、浮かせたバーで通話の状態を伝える
			card.value = false;
			await flush();
			expect(variantOf(bar())).toMatch(/floating/);
			expect(statusLive()).toBe('polite');

			card.value = true;
			await flush();
			expect(queryBar()).toBeNull();
		});

		test('keeps the common bar hidden while stage controls are present, including under a menu', async () => {
			const { container } = renderRoom({ card: ref(true) });
			await flush();
			await resizeElement(chatFormSlot(container), 300);
			expect(queryBar()).toBeNull();
			const main = container.querySelector('main')!;
			main.inert = true;
			await new Promise(resolve => setTimeout(resolve, 0));
			await flush();
			expect(container.querySelector('[role="region"]')).toBeNull();
			main.inert = false;
		});

		test('on PC floats the bar again when the card is hidden', async () => {
			const cardVisible = ref(true);
			const { container } = renderRoom({ card: ref(true), cardVisible });
			await flush();
			await resizeElement(chatFormSlot(container), 100);
			expect(queryBar()).toBeNull();

			cardVisible.value = false;
			await new Promise(resolve => setTimeout(resolve, 0));
			await flush();
			expect(variantOf(bar())).toMatch(/floating/);
			expect(statusLive()).toBe('polite');
		});

		test('on mobile still hides the bar while the card shows the call, and shows it at the top otherwise', async () => {
			await setWidth(400);
			const card = ref(true);
			renderRoom({ card });
			await flush();
			expect(queryBar()).toBeNull();

			card.value = false;
			await flush();
			expect(screen.getByTestId('top').contains(bar())).toBe(true);
			expect(variantOf(bar())).toMatch(/top/);
		});
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
