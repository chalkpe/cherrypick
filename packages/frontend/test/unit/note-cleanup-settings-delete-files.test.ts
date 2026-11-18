/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import NoteCleanupSettings from '@/pages/settings/note-cleanup.vue';
import I18n from '@/components/global/I18n.vue';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(async () => {
	const { reactive } = await import('vue');
	return {
		list: vi.fn(),
		setKeepDriveFiles: vi.fn(),
		me: reactive({ id: 'viewer', autoDeleteNoteFiles: false }),
	};
});

vi.mock('@/os.js', () => ({ alert: vi.fn() }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i.js', async () => {
	const { me } = await mocks;
	return { $i: me, ensureSignin: () => me };
});
vi.mock('@/utility/note-cleanup-api.js', async () => { const m = await mocks; return { cleanupApi: { list: m.list, setKeepDriveFiles: m.setKeepDriveFiles } }; });
vi.mock('@/components/global/SearchMarker.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));
vi.mock('@/components/MkLoading.vue', () => ({ default: { template: '<div />' } }));

beforeEach(async () => {
	const m = await mocks;
	m.list.mockReset().mockResolvedValue({ rules: [], blocked: false, keepDriveFiles: true });
	m.setKeepDriveFiles.mockReset().mockResolvedValue({ keepDriveFiles: false });
});
afterEach(cleanup);

async function mountPage(autoDeleteNoteFiles: boolean) {
	const m = await mocks;
	m.me.autoDeleteNoteFiles = autoDeleteNoteFiles;
	const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(NoteCleanupSettings) }) });
	const view = render(Host, { global: { components: { I18n }, stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } });
	await vi.waitFor(() => expect(view.getByText(i18n.ts._noteCleanup.keepDriveFiles)).not.toBeNull());
	return { view, ...m };
}

// 드라이브 설정으로 가는 링크(설명이나 안내 안의 링크)
function driveLinks(container: Element) {
	return Array.from(container.querySelectorAll('a[href="/settings/drive"]'));
}

function toggleInput(container: Element) {
	return container.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

test('드라이브 설정에서 첨부 파일을 함께 지우도록 했으면 저장된 값이 켜짐이어도 꺼진 모양으로 잠그고 안내를 보여 준다', async () => {
	const { view, setKeepDriveFiles } = await mountPage(true);

	// 저장된 값(keepDriveFiles)은 true지만 화면에서는 꺼진 모양이어야 한다.
	expect(toggleInput(view.container).checked).toBe(false);
	expect(toggleInput(view.container).disabled).toBe(true);
	expect(driveLinks(view.container)).toHaveLength(1);
	expect(view.container.textContent).not.toContain(i18n.ts._noteCleanup.keepDriveFilesScope.split('{')[0]);
	await fireEvent.click(view.getByText(i18n.ts._noteCleanup.keepDriveFiles));
	expect(setKeepDriveFiles).not.toHaveBeenCalled();
});

test('계정 정보의 옵션이 꺼지면 잠금이 풀리고 저장된 값대로 다시 보인다', async () => {
	const { view, me } = await mountPage(true);
	expect(toggleInput(view.container).disabled).toBe(true);

	me.autoDeleteNoteFiles = false;

	await vi.waitFor(() => expect(toggleInput(view.container).disabled).toBe(false));
	expect(toggleInput(view.container).checked).toBe(true);
	expect(view.container.textContent).not.toContain(i18n.ts._noteCleanup.keepDriveFilesOverridden.split('}').pop()!);
	expect(view.container.textContent).toContain(i18n.ts._noteCleanup.keepDriveFilesScope.split('{')[0]);
});

test('드라이브 설정의 옵션이 꺼져 있으면 저장된 값대로 켜진 스위치이고 안내가 없다', async () => {
	const { view, setKeepDriveFiles } = await mountPage(false);

	expect(toggleInput(view.container).disabled).toBe(false);
	expect(toggleInput(view.container).checked).toBe(true);
	expect(view.container.textContent).not.toContain(i18n.ts._noteCleanup.keepDriveFilesOverridden.split('}').pop()!);

	await fireEvent.click(view.getByText(i18n.ts._noteCleanup.keepDriveFiles));
	await vi.waitFor(() => expect(setKeepDriveFiles).toHaveBeenCalledWith(false));
});

test('옵션이 꺼져 있으면 스위치 설명에 적용 범위와 드라이브 설정 링크가 보인다', async () => {
	const { view } = await mountPage(false);

	const [link, ...rest] = driveLinks(view.container);
	expect(rest).toHaveLength(0);
	expect(link.getAttribute('href')).toBe('/settings/drive');
	expect(link.textContent).toBe(i18n.ts._noteCleanup.driveSettingsLink);
	expect(view.container.textContent).toContain(i18n.ts.autoDeleteNoteFiles);
	expect(view.container.textContent).toContain(i18n.ts._noteCleanup.keepDriveFilesScope.split('{')[0]);
});

test('옵션이 켜져 있으면 안내의 드라이브 설정이 링크다', async () => {
	const { view } = await mountPage(true);

	const links = driveLinks(view.container);
	expect(links).toHaveLength(1);
	expect(links[0].textContent).toBe(i18n.ts._noteCleanup.driveSettingsLink);
	expect(view.container.textContent).toContain(i18n.ts._noteCleanup.keepDriveFilesOverridden.split('}').pop()!);
	expect(view.queryByText(i18n.ts._noteCleanup.keepDriveFilesScope.split('{')[0], { exact: false })).toBeNull();
});
