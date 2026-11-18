/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, Suspense } from 'vue';
import DriveSettings from '@/pages/settings/drive.vue';
import { i18n } from '@/i18n.js';

// 실제 $i처럼 반응형 객체로 둬서 다른 곳에서 값이 바뀌는 상황을 흉내 낸다.
const mocks = vi.hoisted(async () => {
	const { reactive } = await import('vue');
	return {
		api: vi.fn(),
		alert: vi.fn(),
		updateAccount: vi.fn(),
		me: reactive({ id: 'viewer', alwaysMarkNsfw: false, autoSensitive: false, autoDeleteNoteFiles: false, policies: { watermarkAvailable: false, alwaysMarkNsfw: false } }),
	};
});

vi.mock('@/os.js', async () => ({ alert: (await mocks).alert, confirm: vi.fn(), popup: vi.fn(), apiWithDialog: vi.fn() }));
vi.mock('@/utility/misskey-api.js', async () => ({ misskeyApi: (await mocks).api }));
vi.mock('@/i.js', async () => {
	const { me } = await mocks;
	return { $i: me, ensureSignin: () => me };
});
vi.mock('@/accounts.js', async () => {
	const { me } = await mocks;
	const { updateAccount } = await mocks;
	return { updateCurrentAccount: (data: Record<string, unknown>) => updateAccount(data) };
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

// 대기 중인 프로미스 연쇄가 모두 처리되도록 마이크로태스크를 충분히 비운다.
async function flushPromises() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

// 서버가 오류를 돌려줄 때 misskeyApi가 거부하는 값의 실제 모양(Error가 아닌 일반 객체)
const serverError = { message: 'Rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED', id: 'rate-limit' };

async function mountPage(initial: { autoDeleteNoteFiles?: boolean; roleForcedNsfw?: boolean } = {}) {
	const { api, alert, me, updateAccount } = await mocks;
	// 실제 갱신 함수처럼 현재 계정 정보 객체에 값을 써 넣는다.
	updateAccount.mockReset().mockImplementation((data: Record<string, unknown>) => { Object.assign(me, data); });
	me.autoDeleteNoteFiles = initial.autoDeleteNoteFiles ?? false;
	me.alwaysMarkNsfw = false;
	me.autoSensitive = false;
	me.policies.alwaysMarkNsfw = initial.roleForcedNsfw ?? false;
	alert.mockReset();
	api.mockReset().mockImplementation(async (path: string) => (path === 'drive' ? { usage: 0, capacity: 1 } : undefined));
	const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(DriveSettings) }) });
	const view = render(Host, { global: { stubs: { PageWithHeader: { template: '<div><slot /></div>' } } } });
	await vi.waitFor(() => expect(view.getByText(i18n.ts.autoDeleteNoteFiles)).not.toBeNull());
	return { view, api, alert, me, updateAccount };
}

function switchOf(view: ReturnType<typeof render>, label: string) {
	return view.getByText(label).closest('div')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

// 화면에 그려지는 스위치의 켜짐 상태. 접근성 옵션이 없는 스위치는 체크박스에 값이 반영되지 않는다.
function shownOn(view: ReturnType<typeof render>, label: string) {
	const toggle = view.getByText(label).closest('div')!.querySelector('[data-testid="switch-toggle"]')!;
	return /buttonChecked/.test(toggle.className);
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
		if (path === 'i/update') throw serverError;
		return { usage: 0, capacity: 1 };
	});

	await fireEvent.click(view.getByText(i18n.ts.autoDeleteNoteFiles));

	await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text: serverError.message })));
	await vi.waitFor(() => expect(shownOn(view, i18n.ts.autoDeleteNoteFiles)).toBe(false));
});

test('다른 스위치를 저장하는 요청에는 이 옵션의 값이 실리지 않는다', async () => {
	const { view, api } = await mountPage();
	// 이 화면에서 옵션을 켠 뒤, 이 옵션이 켜진 채로 다른 스위치를 저장하는 상황을 만든다.
	await fireEvent.click(view.getByText(i18n.ts.autoDeleteNoteFiles));
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));
	api.mockClear();

	await fireEvent.click(view.getByText(i18n.ts.alwaysMarkSensitive));

	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('i/update', { alwaysMarkNsfw: true }));
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

test('열람 주의 스위치를 켜는 저장이 실패하면 꺼진 상태로 돌아간다', async () => {
	const { view, api, alert } = await mountPage();
	api.mockImplementation(async (path: string) => {
		if (path === 'i/update') throw serverError;
		return { usage: 0, capacity: 1 };
	});

	await fireEvent.click(view.getByText(i18n.ts.alwaysMarkSensitive));

	await vi.waitFor(() => expect(alert).toHaveBeenCalled());
	// 화면 갱신이 끝난 뒤의 상태를 확인한다.
	await flushPromises();
	await nextTick();
	expect(shownOn(view, i18n.ts.alwaysMarkSensitive)).toBe(false);
});

test('자동 민감 판정 스위치의 저장 실패는 열람 주의 스위치 모양을 바꾸지 않고 자기 값만 되돌린다', async () => {
	const { view, api, alert } = await mountPage();
	api.mockImplementation(async (path: string) => {
		if (path === 'i/update') throw serverError;
		return { usage: 0, capacity: 1 };
	});

	await fireEvent.click(view.getByText(i18n.ts.enableAutoSensitive));

	await vi.waitFor(() => expect(alert).toHaveBeenCalled());
	// 화면 갱신이 끝난 뒤의 상태를 확인한다.
	await flushPromises();
	await nextTick();
	expect(shownOn(view, i18n.ts.enableAutoSensitive)).toBe(false);
	expect(shownOn(view, i18n.ts.alwaysMarkSensitive)).toBe(false);
});

test('자동 민감 판정 스위치는 자기 값만 저장한다', async () => {
	const { view, api } = await mountPage();

	await fireEvent.click(view.getByText(i18n.ts.enableAutoSensitive));

	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('i/update', { autoSensitive: true }));
	expect(api.mock.calls.filter(c => c[0] === 'i/update')).toHaveLength(1);
});

test('역할로 열람 주의가 강제된 계정은 열람 주의 스위치가 켜진 채 잠기고 요청을 보내지 않는다', async () => {
	const { view, api } = await mountPage({ roleForcedNsfw: true });

	expect(shownOn(view, i18n.ts.alwaysMarkSensitive)).toBe(true);
	expect(switchOf(view, i18n.ts.alwaysMarkSensitive).disabled).toBe(true);

	await fireEvent.click(view.getByText(i18n.ts.alwaysMarkSensitive));
	await flushPromises();

	expect(api.mock.calls.filter(c => c[0] === 'i/update')).toHaveLength(0);
	expect(shownOn(view, i18n.ts.alwaysMarkSensitive)).toBe(true);
});

test('역할로 열람 주의가 강제된 계정도 자동 민감 판정은 자기 값만 저장한다', async () => {
	const { view, api, alert } = await mountPage({ roleForcedNsfw: true });

	await fireEvent.click(view.getByText(i18n.ts.enableAutoSensitive));

	await vi.waitFor(() => expect(api).toHaveBeenCalledWith('i/update', { autoSensitive: true }));
	await flushPromises();
	expect(alert).not.toHaveBeenCalled();
	expect(shownOn(view, i18n.ts.enableAutoSensitive)).toBe(true);
	expect(shownOn(view, i18n.ts.alwaysMarkSensitive)).toBe(true);
});

test('열람 주의 스위치는 저장하는 동안 잠긴다', async () => {
	const { view, api } = await mountPage();
	let finish!: () => void;
	api.mockImplementation(async (path: string) => {
		if (path !== 'i/update') return { usage: 0, capacity: 1 };
		await new Promise<void>(resolve => { finish = resolve; });
		return undefined;
	});

	await fireEvent.click(view.getByText(i18n.ts.alwaysMarkSensitive));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.alwaysMarkSensitive).disabled).toBe(true));
	finish();
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.alwaysMarkSensitive).disabled).toBe(false));
});

test('자동 민감 판정 스위치는 저장하는 동안 잠긴다', async () => {
	const { view, api } = await mountPage();
	let finish!: () => void;
	api.mockImplementation(async (path: string) => {
		if (path !== 'i/update') return { usage: 0, capacity: 1 };
		await new Promise<void>(resolve => { finish = resolve; });
		return undefined;
	});

	await fireEvent.click(view.getByText(i18n.ts.enableAutoSensitive));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.enableAutoSensitive).disabled).toBe(true));
	finish();
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.enableAutoSensitive).disabled).toBe(false));
});

test('저장하는 동안 늦게 도착한 계정 정보 갱신이 화면 값을 덮지 않는다', async () => {
	const { view, api, me } = await mountPage({ autoDeleteNoteFiles: true });
	const label = view.getByText(i18n.ts.autoDeleteNoteFiles);

	// 첫 저장(끄기)이 성공한다.
	await fireEvent.click(label);
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: false }));
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));

	// 두 번째 저장(켜기)이 진행 중일 때 첫 저장의 계정 정보 갱신이 늦게 도착한다.
	let finish!: () => void;
	api.mockImplementation(async (path: string) => {
		if (path !== 'i/update') return { usage: 0, capacity: 1 };
		await new Promise<void>(resolve => { finish = resolve; });
		return undefined;
	});
	await fireEvent.click(label);
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));
	me.autoDeleteNoteFiles = false;
	await flushPromises();
	finish();

	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));
	expect(shownOn(view, i18n.ts.autoDeleteNoteFiles)).toBe(true);
});

test('열람 주의와 자동 민감 판정 스위치의 저장 실패도 서버 오류 객체의 메시지를 알린다', async () => {
	const { view, api, alert } = await mountPage();
	api.mockImplementation(async (path: string) => {
		if (path === 'i/update') throw serverError;
		return { usage: 0, capacity: 1 };
	});

	await fireEvent.click(view.getByText(i18n.ts.alwaysMarkSensitive));
	await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ text: 'Rate limit exceeded.' })));
	alert.mockClear();
	await vi.waitFor(() => expect(switchOf(view, i18n.ts.enableAutoSensitive).disabled).toBe(false));

	await fireEvent.click(view.getByText(i18n.ts.enableAutoSensitive));
	await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.objectContaining({ text: 'Rate limit exceeded.' })));
});

test('역할로 잠긴 열람 주의 스위치는 체크박스도 켜져 있고 잠긴 이유가 보인다', async () => {
	const { view } = await mountPage({ roleForcedNsfw: true });

	expect(switchOf(view, i18n.ts.alwaysMarkSensitive).checked).toBe(true);
	expect(view.getByText(i18n.ts.alwaysMarkSensitiveLockedByRole)).not.toBeNull();
});

test('역할로 잠기지 않은 계정에는 잠긴 이유가 보이지 않고 체크박스가 화면 상태를 따른다', async () => {
	const { view } = await mountPage();

	expect(view.queryByText(i18n.ts.alwaysMarkSensitiveLockedByRole)).toBeNull();
	expect(switchOf(view, i18n.ts.alwaysMarkSensitive).checked).toBe(false);
	expect(switchOf(view, i18n.ts.enableAutoSensitive).checked).toBe(false);
});

test('저장에 성공하면 계정 정보 갱신 이벤트가 없어도 현재 계정 정보의 값이 바뀐다', async () => {
	const { view, api, me } = await mountPage();
	expect(me.autoDeleteNoteFiles).toBe(false);

	await fireEvent.click(view.getByText(i18n.ts.autoDeleteNoteFiles));
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));

	await vi.waitFor(() => expect(me.autoDeleteNoteFiles).toBe(true));
});

test('저장 성공 뒤 화면을 다시 만들어도 스위치가 저장한 값으로 보인다', async () => {
	const first = await mountPage();
	await fireEvent.click(first.view.getByText(i18n.ts.autoDeleteNoteFiles));
	await vi.waitFor(() => expect(first.api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));
	await vi.waitFor(() => expect(switchOf(first.view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));
	first.view.unmount();

	// 계정 정보를 초기화하지 않고 같은 값으로 다시 연다.
	const { api, me } = await mocks;
	api.mockReset().mockImplementation(async (path: string) => (path === 'drive' ? { usage: 0, capacity: 1 } : undefined));
	const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(DriveSettings) }) });
	const view = render(Host, { global: { stubs: { PageWithHeader: { template: '<div><slot /></div>' } } } });
	await vi.waitFor(() => expect(view.getByText(i18n.ts.autoDeleteNoteFiles)).not.toBeNull());

	expect(me.autoDeleteNoteFiles).toBe(true);
	expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).checked).toBe(true);
});

test('저장에 성공한 뒤 현재 계정 정보 갱신이 실패해도 저장 실패로 알리지 않고 요청한 값을 유지한다', async () => {
	const { view, api, alert, updateAccount } = await mountPage();
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	updateAccount.mockImplementation(() => { throw new Error('storage failed'); });

	await fireEvent.click(view.getByText(i18n.ts.autoDeleteNoteFiles));
	await vi.waitFor(() => expect(api).toHaveBeenLastCalledWith('i/update', { autoDeleteNoteFiles: true }));

	await vi.waitFor(() => expect(switchOf(view, i18n.ts.autoDeleteNoteFiles).disabled).toBe(false));
	await flushPromises();
	await nextTick();
	expect(alert).not.toHaveBeenCalled();
	expect(shownOn(view, i18n.ts.autoDeleteNoteFiles)).toBe(true);
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});
