/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({
	meta: {} as Record<string, unknown>,
	apiWithDialog: vi.fn(async () => ({})),
	fetchInstance: vi.fn(),
}));

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(async (endpoint: string) => endpoint === 'admin/meta' ? mocks.meta : { id: 'proxy', description: '' }),
}));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: vi.fn(), popupAsyncWithDialog: vi.fn() }));
vi.mock('@/instance.js', () => ({ fetchInstance: mocks.fetchInstance, instance: {} }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/components/MkInput.vue', () => ({
	default: {
		props: ['modelValue', 'type', 'autocomplete'],
		emits: ['update:modelValue'],
		template: '<label><span><slot name="label" /></span><input :type="type" :autocomplete="autocomplete" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><slot name="caption" /></label>',
	},
}));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div><slot name="label" /></div>' } }));
vi.mock('@/components/MkTextarea.vue', () => ({ default: { template: '<div><slot name="label" /></div>' } }));
vi.mock('@/components/MkRadios.vue', () => ({ default: { template: '<div><slot name="label" /></div>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<p><slot /></p>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><h2><slot name="label" /></h2><slot /><slot name="footer" /></section>' } }));
vi.mock('@/components/MkFormFooter.vue', () => ({ default: { props: ['form'], template: '<button type="button" @click="form.save()">save</button>' } }));
vi.mock('@/components/form/split.vue', () => ({ default: { template: '<div><slot /></div>' } }));

import XSettings from '@/pages/admin/settings.vue';

function adminMeta(overrides: Record<string, unknown> = {}) {
	return {
		pinnedUsers: [],
		urlPreviewSensitiveList: [],
		federationHosts: [],
		deliverSuspendedSoftware: [],
		proxyAccountId: 'proxy',
		voiceCallCloudflareTurnKeyId: null,
		voiceCallCloudflareTurnApiToken: null,
		...overrides,
	};
}

async function renderSettings() {
	const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(XSettings) })]) }), {
		global: {
			directives: { panel: {} },
			stubs: {
				PageWithHeader: { template: '<div><slot /></div>' },
				// 検索の索引を作るプラグインが markerId と children を足す
				SearchMarker: { props: ['markerId', 'children', 'path', 'label', 'icon', 'keywords'], template: '<div><slot :isParentOfTarget="false" /></div>' },
				SearchLabel: { template: '<span><slot /></span>' },
				SearchIcon: { template: '<span><slot /></span>' },
				SearchText: { template: '<span><slot /></span>' },
			},
		},
	});
	await view.findByText(i18n.ts._serverSettings.voiceCallCloudflareTurn);
	return view;
}

beforeEach(() => {
	mocks.meta = adminMeta();
	mocks.apiWithDialog.mockClear();
	mocks.fetchInstance.mockClear();
});
afterEach(cleanup);

test('saves the Cloudflare TURN key id and API token', async () => {
	const view = await renderSettings();

	expect(view.getByText(i18n.ts._serverSettings.voiceCallCloudflareTurnDescription)).toBeTruthy();
	const keyId = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnKeyId, { exact: false }) as HTMLInputElement;
	const apiToken = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnApiToken, { exact: false }) as HTMLInputElement;
	// API トークンは画面に出さず、ブラウザが保存済みのパスワードを入れないようにする
	expect(apiToken.type).toBe('password');
	expect(apiToken.autocomplete).toBe('new-password');

	await fireEvent.update(keyId, 'turn-key-id');
	await fireEvent.update(apiToken, 'turn-api-token');
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));

	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', {
		voiceCallCloudflareTurnKeyId: 'turn-key-id',
		voiceCallCloudflareTurnApiToken: 'turn-api-token',
	});
	expect(mocks.fetchInstance).toHaveBeenCalled();
});

test('shows the saved values and clears them', async () => {
	mocks.meta = adminMeta({ voiceCallCloudflareTurnKeyId: 'saved-key', voiceCallCloudflareTurnApiToken: 'saved-token' });
	const view = await renderSettings();

	const keyId = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnKeyId, { exact: false }) as HTMLInputElement;
	const apiToken = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnApiToken, { exact: false }) as HTMLInputElement;
	expect(keyId.value).toBe('saved-key');
	expect(apiToken.value).toBe('saved-token');

	await fireEvent.update(keyId, '');
	await fireEvent.update(apiToken, '');
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));

	// 空にするとサーバー側で null として保存され、TURN を使わなくなる
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', {
		voiceCallCloudflareTurnKeyId: '',
		voiceCallCloudflareTurnApiToken: '',
	});
});
