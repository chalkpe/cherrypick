/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import NoteCleanupSettings from '@/pages/settings/note-cleanup.vue';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	setKeepDriveFiles: vi.fn(),
	me: { id: 'viewer', autoDeleteNoteFiles: false },
}));

vi.mock('@/os.js', () => ({ alert: vi.fn() }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/utility/note-cleanup-api.js', () => ({ cleanupApi: { list: mocks.list, setKeepDriveFiles: mocks.setKeepDriveFiles } }));
vi.mock('@/components/global/SearchMarker.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));
vi.mock('@/components/MkLoading.vue', () => ({ default: { template: '<div />' } }));

beforeEach(() => {
	mocks.list.mockReset().mockResolvedValue({ rules: [], blocked: false, keepDriveFiles: true });
	mocks.setKeepDriveFiles.mockReset().mockResolvedValue({ keepDriveFiles: false });
});
afterEach(cleanup);

async function mountPage(autoDeleteNoteFiles: boolean) {
	mocks.me.autoDeleteNoteFiles = autoDeleteNoteFiles;
	const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(NoteCleanupSettings) }) });
	const view = render(Host);
	await vi.waitFor(() => expect(view.getByText(i18n.ts._noteCleanup.keepDriveFiles)).not.toBeNull());
	return view;
}

function toggleInput(container: Element) {
	return container.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

test('드라이브 설정에서 첨부 파일을 함께 지우도록 했으면 스위치를 잠그고 안내를 보여 준다', async () => {
	const view = await mountPage(true);

	expect(toggleInput(view.container).disabled).toBe(true);
	expect(view.getByText(i18n.ts._noteCleanup.keepDriveFilesOverridden)).not.toBeNull();
	await fireEvent.click(view.getByText(i18n.ts._noteCleanup.keepDriveFiles));
	expect(mocks.setKeepDriveFiles).not.toHaveBeenCalled();
});

test('드라이브 설정의 옵션이 꺼져 있으면 저장된 값대로 켜진 스위치이고 안내가 없다', async () => {
	const view = await mountPage(false);

	expect(toggleInput(view.container).disabled).toBe(false);
	expect(toggleInput(view.container).checked).toBe(true);
	expect(view.queryByText(i18n.ts._noteCleanup.keepDriveFilesOverridden)).toBeNull();

	await fireEvent.click(view.getByText(i18n.ts._noteCleanup.keepDriveFiles));
	await vi.waitFor(() => expect(mocks.setKeepDriveFiles).toHaveBeenCalledWith(false));
});
