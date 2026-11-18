/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import DriveSettings from '@/pages/settings/drive.vue';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), alert: vi.fn() }));

vi.mock('@/os.js', () => ({ alert: mocks.alert, confirm: vi.fn(), popup: vi.fn(), apiWithDialog: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/i.js', () => {
	const me = { id: 'viewer', alwaysMarkNsfw: false, autoSensitive: false, autoDeleteNoteFiles: false, policies: { watermarkAvailable: false } };
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
	mocks.api.mockReset().mockImplementation(async (path: string) => (path === 'drive' ? { usage: 0, capacity: 1 } : undefined));
	const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(DriveSettings) }) });
	const view = render(Host, { global: { stubs: { PageWithHeader: { template: '<div><slot /></div>' } } } });
	await vi.waitFor(() => expect(view.getByText(i18n.ts.autoDeleteNoteFiles)).not.toBeNull());
	return view;
}

test('스위치를 켜고 끄면 그때마다 계정 설정으로 저장한다', async () => {
	const view = await mountPage();
	const label = view.getByText(i18n.ts.autoDeleteNoteFiles);

	// 처음에는 꺼진 상태이므로 처음 누르면 켜는 요청이 나간다.
	await fireEvent.click(label);
	await vi.waitFor(() => expect(mocks.api).toHaveBeenLastCalledWith('i/update', expect.objectContaining({ autoDeleteNoteFiles: true })));

	await fireEvent.click(label);
	await vi.waitFor(() => expect(mocks.api).toHaveBeenLastCalledWith('i/update', expect.objectContaining({ autoDeleteNoteFiles: false })));
});

test('스위치의 설명이 함께 표시된다', async () => {
	const view = await mountPage();

	expect(view.getByText(i18n.ts.autoDeleteNoteFilesDescription)).not.toBeNull();
});
