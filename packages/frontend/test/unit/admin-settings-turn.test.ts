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
	apiWithDialog: vi.fn(async (endpoint: string) => endpoint === 'admin/voice-relay/manage' ? { providers: [] } : {}),
}));

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => mocks.meta) }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/instance.js', () => ({ fetchInstance: vi.fn() }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/components/MkInput.vue', () => ({ default: { props: ['modelValue', 'type', 'autocomplete'], emits: ['update:modelValue'], template: '<label><span><slot name="label" /></span><input :type="type" :autocomplete="autocomplete" :value="modelValue" @input="$emit(\'update:modelValue\', type === \'number\' ? Number($event.target.value) : $event.target.value)" /><slot name="caption" /></label>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { props: ['modelValue'], emits: ['update:modelValue'], template: '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /><slot /></label>' } }));
vi.mock('@/components/MkRadios.vue', () => ({ default: { props: ['modelValue', 'options'], emits: ['update:modelValue'], template: '<fieldset><legend><slot name="label" /></legend><label v-for="option in options" :key="option.value"><input type="radio" :checked="modelValue === option.value" @change="$emit(\'update:modelValue\', option.value)" />{{ option.label }}</label></fieldset>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<p><slot /></p>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><h2><slot name="label" /></h2><slot /><slot name="footer" /></section>' } }));
vi.mock('@/components/MkFormFooter.vue', () => ({ default: { props: ['form'], template: '<button type="button" @click="form.save()">save</button>' } }));

import XSettings from '@/pages/admin/voice-relay.vue';

async function renderSettings() {
	const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(XSettings) })]) }), {
		global: { stubs: {
			PageWithHeader: { template: '<div><slot /></div>' },
			SearchMarker: { template: '<div><slot /></div>' },
		} },
	});
	await view.findByText(i18n.ts._serverSettings.voiceCallCloudflareTurn);
	return view;
}

beforeEach(() => {
	mocks.meta = { voiceCallMaxParticipants: 10, voiceCallLivekitSource: 'yaml', voiceCallLivekitUrl: null, voiceCallLivekitApiKey: null, voiceCallLivekitApiSecretSet: false, voiceCallPreferRelay: null, voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiTokenSet: false };
	mocks.apiWithDialog.mockClear();
});
afterEach(cleanup);

test('saves the Cloudflare TURN key ID and masked token in call settings', async () => {
	const view = await renderSettings();
	const keyId = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnKeyId, { exact: false }) as HTMLInputElement;
	const token = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnApiToken, { exact: false }) as HTMLInputElement;

	expect(token.type).toBe('password');
	expect(token.autocomplete).toBe('new-password');
	await fireEvent.update(keyId, 'turn-key-id');
	await fireEvent.update(token, 'turn-api-token');
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));

	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', { voiceCallCloudflareTurnKeyId: 'turn-key-id', voiceCallCloudflareTurnApiToken: 'turn-api-token' });
});

test('keeps a saved TURN token when left blank and deletes it only when requested', async () => {
	mocks.meta.voiceCallCloudflareTurnKeyId = 'saved-key';
	mocks.meta.voiceCallCloudflareTurnApiTokenSet = true;
	const view = await renderSettings();
	const keyId = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnKeyId, { exact: false }) as HTMLInputElement;
	const token = view.getByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnApiToken, { exact: false }) as HTMLInputElement;

	expect(token.value).toBe('');
	await fireEvent.update(keyId, 'new-key');
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', { voiceCallCloudflareTurnKeyId: 'new-key' });

	await fireEvent.click(view.getByLabelText(i18n.ts._voiceRelay.deleteSecret));
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', { voiceCallCloudflareTurnKeyId: 'new-key', voiceCallCloudflareTurnApiToken: null });
});

test('updates the total number of call participants', async () => {
	const view = await renderSettings();
	const limit = view.getByLabelText(i18n.ts._voiceRelay.capacityTitle, { exact: false }) as HTMLInputElement;
	expect(limit.value).toBe('10');
	await fireEvent.update(limit, '25');
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));

	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', { voiceCallMaxParticipants: 25 });
});

test('saves an administrator-provided LiveKit connection with a masked secret', async () => {
	const view = await renderSettings();
	await fireEvent.click(view.getByLabelText(i18n.ts._voiceRelay.sourceCustom));
	const url = view.getByLabelText(i18n.ts._voiceRelay.livekitUrl, { exact: false });
	const key = view.getByLabelText(i18n.ts._voiceRelay.livekitKey, { exact: false });
	const secret = view.getByLabelText(i18n.ts._voiceRelay.livekitSecret, { exact: false }) as HTMLInputElement;
	expect(secret.type).toBe('password');
	await fireEvent.update(url, 'https://livekit.test');
	await fireEvent.update(key, 'key');
	await fireEvent.update(secret, 'test-secret');
	await fireEvent.click(await view.findByRole('button', { name: 'save' }));

	expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/update-meta', {
		voiceCallLivekitSource: 'custom', voiceCallLivekitUrl: 'https://livekit.test', voiceCallLivekitApiKey: 'key', voiceCallLivekitApiSecret: 'test-secret', voiceCallPreferRelay: null,
	});
});
