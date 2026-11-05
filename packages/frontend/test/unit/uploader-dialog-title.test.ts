/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import { nextTick, ref } from 'vue';

const mocks = vi.hoisted(() => ({
	chooseFileFromPc: vi.fn(),
	items: { value: null as unknown as { value: { name: string }[] } },
}));

vi.mock('@/os.js', () => ({ chooseFileFromPc: mocks.chooseFileFromPc, confirm: vi.fn(), popupMenu: vi.fn() }));
vi.mock('@/i.js', async importOriginal => {
	const me = { id: 'me', policies: { maxFileSizeMb: 10 } };
	return { ...await importOriginal<typeof import('@/i.js')>(), $i: me, ensureSignin: () => me };
});
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => []) }));
vi.mock('@/composables/use-uploader.js', async () => {
	const { computed } = await import('vue');
	return {
		useUploader: () => ({
			items: mocks.items.value,
			addFiles: (files: File[]) => { mocks.items.value.value.push(...files.map(file => ({ name: file.name }))); },
			uploading: computed(() => false),
			readyForUpload: computed(() => true),
			allItemsUploaded: computed(() => false),
			abortAll: vi.fn(),
			upload: vi.fn(),
			dispose: vi.fn(),
			getMenu: vi.fn(),
		}),
	};
});

import MkUploaderDialog from '@/components/MkUploaderDialog.vue';
import { i18n } from '@/i18n.js';

const stubs = {
	MkModalWindow: { methods: { close: vi.fn() }, template: '<div><header data-testid="title"><slot name="header"/></header><slot/><slot name="footer"/></div>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\', $event)"><slot/></button>' },
	MkUploaderItems: true,
	MkTip: true,
};

const file = (name: string) => new File(['x'], name, { type: 'image/png' });
const title = () => screen.getByTestId('title').textContent?.trim();
const plusButton = (container: Element) => container.querySelector('.ti-plus')!.closest('button')!;

function renderDialog(files: File[]) {
	return render(MkUploaderDialog, { props: { files }, global: { stubs } });
}

beforeEach(() => {
	mocks.items.value = ref([]);
	mocks.chooseFileFromPc.mockReset();
});
afterEach(cleanup);

test('counts what was picked first', async () => {
	renderDialog([file('a.png'), file('b.png')]);
	await nextTick();

	expect(title()).toBe(i18n.tsx.uploadNFiles({ n: 2 }));
});

test('counts a file added with the plus button of the window', async () => {
	mocks.chooseFileFromPc.mockResolvedValue([file('b.png')]);
	const { container } = renderDialog([file('a.png')]);
	await nextTick();
	expect(title()).toBe(i18n.tsx.uploadNFiles({ n: 1 }));

	await fireEvent.click(plusButton(container));
	await nextTick();
	await nextTick();

	expect(title()).toBe(i18n.tsx.uploadNFiles({ n: 2 }));
});

test('counts down when a file leaves the list', async () => {
	renderDialog([file('a.png'), file('b.png')]);
	await nextTick();

	mocks.items.value.value.splice(0, 1);
	await nextTick();

	expect(title()).toBe(i18n.tsx.uploadNFiles({ n: 1 }));
});
