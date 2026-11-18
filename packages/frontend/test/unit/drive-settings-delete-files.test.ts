/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import DriveSettings from '@/pages/settings/drive.vue';
import { i18n } from '@/i18n.js';

// 실제 $i처럼 반응형 객체로 둬서 다른 곳에서 값이 바뀌는 상황을 흉내 낸다.
const mocks = vi.hoisted(async () => {
	const { reactive } = await import('vue');
	return {
		api: vi.fn(),
		alert: vi.fn(),
		me: reactive({ id: 'viewer', alwaysMarkNsfw: false, autoSensitive: false, autoDeleteNoteFiles: false, policies: { watermarkAvailable: false } }),
	};
});

vi.mock('@/os.js', async () => ({ alert: (await mocks).alert, confirm: vi.fn(), popup: vi.fn(), apiWithDialog: vi.fn() }));
vi.mock('@/utility/misskey-api.js', async () => ({ misskeyApi: (await mocks).api }));
vi.mock('@/i.js', async () => {
	const { me } = await mocks;
	return { $i: me, ensureSignin: () => me };
});
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	return { prefer: { model: () => ref(false), isSyncEnabled: () => false, enableSync: vi.fn(), disableSync: vi.fn(), r: new Proxy({}, { get: () => ref([]) }), s: new Proxy({}, { get: () => null }), commit: vi.fn() } };
});
vi.mock('@/utility/drive.js', () => ({ selectDriveFolder: vi.fn() }));
vi.mock('@/components/MkChart.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));
vi.mock('@/components/MkPreferenceContainer.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/global/SearchMarker.vue', () => ({ default: { template: '<div><slot /></div>' } }));

afterEach(cleanup);

async function mountPage() {
	const { api, alert, me } = await mocks;
	me.autoDeleteNoteFiles = false;
	alert.mockReset();
	api.mockReset().mockImplementation(async (path: string) => (path === 'drive' ? { usage: 0, capacity: 1 } : undefined));
	const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(DriveSettings) }) });
	const view = render(Host, { global: { stubs: { PageWithHeader: { template: '<div><slot /></div>' } } } });
	await vi.waitFor(() => expect(view.getByText(i18n.ts.autoDeleteNoteFiles)).not.toBeNull());
	return { view, api, alert, me };
}

function switchOf(view: ReturnType<typeof render>, label: string) {
	return view.getByText(label).closest('div')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

test('스위치를 켜고 끄면 그때마다 자기 값만 저장한다', async () => {
	const { view, api } = await mountPage();
	const label = view.getByText(i18n.ts.autoDeleteNoteFiles);

	// 처음에는 꺼진 상태이므로 처음 누르면 켜는 요청이 나간다.
	await fireEvent.click(label);
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));

	await fireEvent.click(label);
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: false }));
});

test('저장에 실패하면 알리고 마지막으로 확인된 값으로 되돌린다', async () => {
	const { view, api, alert } = await mountPage();
	api.mockImplementation(async (path: string) => {
		if (path === 'i/update') throw new Error('저장 실패');
		return { usage: 0, capacity: 1 };
	});

	await fireEvent.click(view.getByText(i18n.ts.autoDeleteNoteFiles));

	await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text: '저장 실패' })));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).checked).toBe(false));
});

test('다른 스위치를 저장하는 요청에는 이 옵션의 값이 실리지 않는다', async () => {
	const { view, api } = await mountPage();
	// 이 화면에서 옵션을 켠 뒤, 다른 탭에서 꺼진 상태(서버 값)와 화면 값이 어긋난 상황을 만든다.
	await fireEvent.click(view.getByText(i18n.ts.autoDeleteNoteFiles));
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));
	api.mockClear();

	await fireEvent.click(view.getByText(i18n.ts.alwaysMarkSensitive));

	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('i/update', { alwaysMarkNsfw: true, autoSensitive: false }));
	for (const call of api.mock.calls) expect(call[1]).not.toHaveProperty('autoDeleteNoteFiles');
});

test('계정 정보의 값이 바뀌면 화면의 스위치도 따라간다', async () => {
	const { view, me } = await mountPage();
	expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).checked).toBe(false);

	me.autoDeleteNoteFiles = true;

	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).checked).toBe(true));
});

test('스위치의 설명이 함께 표시된다', async () => {
	const { view } = await mountPage();

	expect(view.getByText(i18n.ts.autoDeleteNoteFilesDescription)).not.toBeNull();
});
