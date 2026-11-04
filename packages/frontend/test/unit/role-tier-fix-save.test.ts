/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, onMounted, Suspense } from 'vue';
import RolesEdit from '@/pages/admin/roles.edit.vue';

const mocks = vi.hoisted(() => ({
	actions: vi.fn(),
	apiWithDialog: vi.fn(),
	misskeyApi: vi.fn(),
	push: vi.fn(),
	editedRole: null as Record<string, unknown> | null,
	edit: null as ((patch: Record<string, unknown>) => void) | null,
}));

vi.mock('@/os.js', () => ({ actions: mocks.actions, apiWithDialog: mocks.apiWithDialog }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/cache.js', () => ({ rolesCache: { delete: vi.fn() } }));
vi.mock('@/instance.js', () => ({ instance: { policies: { driveCapacityMb: 1024 } } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/pages/admin/roles.editor.vue', () => ({
	default: defineComponent({
		props: { modelValue: { type: Object, required: true } },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			mocks.edit = (patch) => emit('update:modelValue', { ...props.modelValue, ...patch });
			onMounted(() => {
				if (mocks.editedRole) emit('update:modelValue', { ...props.modelValue, ...mocks.editedRole });
			});
			return () => null;
		},
	}),
}));

const high = {
	id: 'high',
	name: '높음',
	target: 'conditional',
	isPublic: true,
	condFormula: { id: 'high-lower', type: 'notesMoreThanOrEq', value: 50000 },
	policies: {},
};
const low = {
	id: 'low',
	name: '낮음',
	target: 'conditional',
	isPublic: true,
	condFormula: { id: 'low-lower', type: 'notesMoreThanOrEq', value: 30000 },
	policies: { driveCapacityMb: { useDefault: false, priority: 0, value: 20480 } },
};

const cappedLowFormula = {
	id: expect.any(String),
	type: 'and',
	values: [
		{ id: 'low-lower', type: 'notesMoreThanOrEq', value: 30000 },
		{ id: expect.any(String), type: 'notesLessThanOrEq', value: 49999 },
	],
};

function answer(...results: (string | null)[]) {
	for (const result of results) {
		mocks.actions.mockResolvedValueOnce(result == null ? { canceled: true, result: undefined } : { canceled: false, result });
	}
}

async function flush() {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

async function mountPage(id?: string) {
	const view = render(defineComponent({
		render: () => h('div', [h(Suspense, null, { default: () => h(RolesEdit, { id }) })]),
	}), {
		global: {
			components: {
				PageWithHeader: { template: '<div><slot/><slot name="footer"/></div>' },
			},
		},
	});
	const saveButton = await view.findByRole('button');
	await flush();
	return saveButton;
}

async function pressSave(id?: string) {
	await fireEvent.click(await mountPage(id));
	await flush();
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.actions.mockReset();
	mocks.editedRole = null;
	mocks.apiWithDialog.mockResolvedValue({ id: 'created' });
	mocks.misskeyApi.mockImplementation((endpoint: string) => {
		if (endpoint === 'admin/roles/show') return Promise.resolve(structuredClone(high));
		if (endpoint === 'admin/roles/list') return Promise.resolve([structuredClone(high), structuredClone(low)]);
		return Promise.reject(new Error(`unexpected ${endpoint}`));
	});
});

afterEach(() => {
	cleanup();
});

test('조건과 권한을 고치면 저장 중인 역할을 먼저 저장하고 다른 역할을 고친 뒤 이동한다', async () => {
	answer('fix', 'copy');

	await pressSave('high');

	expect(mocks.apiWithDialog.mock.calls).toEqual([
		['admin/roles/update', expect.objectContaining({
			roleId: 'high',
			condFormula: high.condFormula,
			policies: { driveCapacityMb: { useDefault: false, priority: 0, value: 20480 } },
		})],
		['admin/roles/update', { roleId: 'low', condFormula: cappedLowFormula, policies: low.policies }],
	]);
	expect(mocks.push).toHaveBeenCalledWith('/admin/roles/:id', { params: { id: 'high' } });
});

test('새 역할을 만들 때도 다른 역할의 조건을 함께 고친다', async () => {
	mocks.editedRole = { name: '높음', target: 'conditional', isPublic: true, condFormula: high.condFormula, policies: {} };
	mocks.misskeyApi.mockImplementation(() => Promise.resolve([structuredClone(low)]));
	answer('fix', 'skip');

	await pressSave();

	expect(mocks.apiWithDialog.mock.calls).toEqual([
		['admin/roles/create', expect.objectContaining({ name: '높음', condFormula: high.condFormula, policies: {} })],
		['admin/roles/update', { roleId: 'low', condFormula: cappedLowFormula, policies: low.policies }],
	]);
	expect(mocks.push).toHaveBeenCalledWith('/admin/roles/:id', { params: { id: 'created' } });
});

test('저장 버튼을 빠르게 두 번 눌러도 역할을 한 번만 만든다', async () => {
	mocks.editedRole = { name: '높음', target: 'conditional', isPublic: true, condFormula: high.condFormula, policies: {} };
	mocks.misskeyApi.mockImplementation(() => Promise.resolve([]));

	const saveButton = await mountPage();
	await Promise.all([fireEvent.click(saveButton), fireEvent.click(saveButton)]);
	await flush();

	expect(mocks.apiWithDialog).toHaveBeenCalledTimes(1);
});

test('저장에 실패한 뒤에는 다시 저장할 수 있다', async () => {
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));
	mocks.misskeyApi.mockImplementation((endpoint: string) => Promise.resolve(endpoint === 'admin/roles/show' ? structuredClone(high) : []));

	const saveButton = await mountPage('high');
	await fireEvent.click(saveButton);
	await flush();
	await fireEvent.click(saveButton);
	await flush();

	expect(mocks.apiWithDialog).toHaveBeenCalledTimes(2);
});

test('역할 목록을 불러오는 동안 고친 내용도 저장한다', async () => {
	let resolveList: (roles: unknown[]) => void = () => {};
	mocks.misskeyApi.mockImplementation((endpoint: string) => (endpoint === 'admin/roles/show'
		? Promise.resolve(structuredClone(high))
		: new Promise(resolve => { resolveList = resolve; })));
	const editedPolicies = { clipLimit: { useDefault: false, priority: 0, value: 5 } };

	const saveButton = await mountPage('high');
	await fireEvent.click(saveButton);
	await flush();
	mocks.edit?.({ policies: editedPolicies });
	await flush();
	resolveList([]);
	await flush();

	expect(mocks.apiWithDialog.mock.calls).toEqual([
		['admin/roles/update', expect.objectContaining({ roleId: 'high', policies: editedPolicies })],
	]);
});

test('안내창을 닫으면 아무것도 저장하지 않고 편집 화면에 남는다', async () => {
	answer(null);

	await pressSave('high');

	expect(mocks.apiWithDialog).not.toHaveBeenCalled();
	expect(mocks.push).not.toHaveBeenCalled();
});

test('그대로 저장하면 저장 중인 역할만 원래 내용으로 저장한다', async () => {
	answer('saveAsIs');

	await pressSave('high');

	expect(mocks.apiWithDialog.mock.calls).toEqual([
		['admin/roles/update', expect.objectContaining({ roleId: 'high', condFormula: high.condFormula, policies: {} })],
	]);
});

test('역할 목록을 불러오지 못해도 안내 없이 저장한다', async () => {
	mocks.misskeyApi.mockImplementation((endpoint: string) => (endpoint === 'admin/roles/show'
		? Promise.resolve(structuredClone(high))
		: Promise.reject(new Error('failed'))));

	await pressSave('high');

	expect(mocks.actions).not.toHaveBeenCalled();
	expect(mocks.apiWithDialog).toHaveBeenCalledTimes(1);
	expect(mocks.push).toHaveBeenCalledTimes(1);
});

test('저장 중인 역할 저장에 실패하면 다른 역할을 고치지 않고 편집 화면에 남는다', async () => {
	answer('fix', 'skip');
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));

	await pressSave('high');

	expect(mocks.apiWithDialog).toHaveBeenCalledTimes(1);
	expect(mocks.push).not.toHaveBeenCalled();
});

test('다른 역할 수정에 실패해도 저장된 역할 화면으로 이동해 중복 생성을 막는다', async () => {
	mocks.editedRole = { name: '높음', target: 'conditional', isPublic: true, condFormula: high.condFormula, policies: {} };
	mocks.misskeyApi.mockImplementation(() => Promise.resolve([structuredClone(low)]));
	answer('fix', 'skip');
	mocks.apiWithDialog
		.mockResolvedValueOnce({ id: 'created' })
		.mockRejectedValueOnce(new Error('failed'));

	await pressSave();

	expect(mocks.push).toHaveBeenCalledWith('/admin/roles/:id', { params: { id: 'created' } });
});
