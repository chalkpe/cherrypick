/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(async () => ({ providers: [] })), livekitSecretSet: false }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.api, confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/instance.js', () => ({ fetchInstance: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async (endpoint: string) => endpoint === 'admin/voice-relay/manage' ? { providers: [] } : { voiceCallMaxParticipants: 10, voiceCallLivekitSource: 'yaml', voiceCallLivekitUrl: null, voiceCallLivekitApiKey: null, voiceCallLivekitApiSecretSet: mocks.livekitSecretSet, voiceCallPreferRelay: null, voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiTokenSet: true }) }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/components/MkInput.vue', () => ({ default: { props: ['modelValue', 'type', 'autocomplete'], emits: ['update:modelValue'], template: '<label><span><slot name="label" /></span><input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><slot name="caption" /></label>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { props: ['modelValue'], emits: ['update:modelValue'], template: '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /><slot /></label>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><h2><slot name="label" /></h2><slot /><slot name="footer" /></section>' } }));
vi.mock('@/components/MkRadios.vue', () => ({ default: { props: ['modelValue', 'options'], emits: ['update:modelValue'], template: '<label><span><slot name="label" /></span><select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>' } }));

afterEach(() => { cleanup(); mocks.api.mockClear(); mocks.livekitSecretSet = false; });

test('provider setup renders address and masked secret without a client ID', async () => {
 const component = (await import('@/pages/admin/voice-relay.vue')).default;
 const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(component) })]) }), { global: { stubs: { PageWithHeader: { template: '<main><slot /></main>' }, SearchMarker: { template: '<div><slot /></div>' } } } });
 await view.findByLabelText(i18n.ts._voiceRelay.origin);
 const rental = view.getByRole('heading', { name: i18n.ts._voiceRelay.title }).closest('section')!;
 expect((within(rental).getByLabelText(i18n.ts._voiceRelay.keyRef, { exact: false }) as HTMLInputElement).type).toBe('password');
});

test('does not expose controls for lending infrastructure', async () => {
 const component = (await import('@/pages/admin/voice-relay.vue')).default;
 const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(component) })]) }), { global: { stubs: { PageWithHeader: { template: '<main><slot /></main>' }, SearchMarker: { template: '<div><slot /></div>' } } } });
 await view.findByLabelText(i18n.ts._voiceRelay.origin);
 const rental = view.getByRole('heading', { name: i18n.ts._voiceRelay.title }).closest('section')!;
 expect(view.getByText(i18n.ts._voiceRelay.capacityDescription)).toBeTruthy();
 expect(within(rental).queryByText(i18n.ts._voiceRelay.capacityDescription)).toBeNull();
 expect(misskeyApi).toHaveBeenCalledWith('admin/voice-relay/manage', { action: 'list' });
});

test('whitespace in the TURN token input keeps the saved token', async () => {
 const component = (await import('@/pages/admin/voice-relay.vue')).default;
 const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(component) })]) }), { global: { stubs: { PageWithHeader: { template: '<main><slot /></main>' }, SearchMarker: { template: '<div><slot /></div>' } } } });
 const input = await view.findByLabelText(i18n.ts._serverSettings.voiceCallCloudflareTurnApiToken, { exact: false });
 const folder = input.closest('label')!.parentElement!.parentElement!;
 mocks.api.mockClear();

 await fireEvent.update(input, '   ');
 await fireEvent.click(within(folder).getByRole('button', { name: i18n.ts.save }));

 await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('admin/update-meta', { voiceCallCloudflareTurnKeyId: '' }));
 expect(within(folder).getByText(i18n.ts._voiceRelay.secretSet)).toBeTruthy();
});

test.each([false, true])('whitespace in the LiveKit secret input keeps saved status %s', async saved => {
 mocks.livekitSecretSet = saved;
 const component = (await import('@/pages/admin/voice-relay.vue')).default;
 const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(component) })]) }), { global: { stubs: { PageWithHeader: { template: '<main><slot /></main>' }, SearchMarker: { template: '<div><slot /></div>' } } } });
 const source = await view.findByLabelText(i18n.ts._voiceRelay.livekitSource, { exact: false });
 await fireEvent.update(source, 'custom');
 const input = await view.findByLabelText(i18n.ts._voiceRelay.livekitSecret, { exact: false });
 const folder = input.closest('label')!.parentElement!.parentElement!;
 mocks.api.mockClear();

 await fireEvent.update(input, '   ');
 await fireEvent.update(source, 'yaml');
 await fireEvent.click(within(folder).getByRole('button', { name: i18n.ts.save }));

 await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('admin/update-meta', {
  voiceCallLivekitSource: 'yaml', voiceCallLivekitUrl: '', voiceCallLivekitApiKey: '', voiceCallPreferRelay: null,
 }));
 expect(Boolean(within(folder).queryByText(i18n.ts._voiceRelay.secretSet))).toBe(saved);
});

test('explicit deletion clears the LiveKit secret', async () => {
 mocks.livekitSecretSet = true;
 const component = (await import('@/pages/admin/voice-relay.vue')).default;
 const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(component) })]) }), { global: { stubs: { PageWithHeader: { template: '<main><slot /></main>' }, SearchMarker: { template: '<div><slot /></div>' } } } });
 const source = await view.findByLabelText(i18n.ts._voiceRelay.livekitSource, { exact: false });
 const folder = source.closest('label')!.parentElement!.parentElement!;
 mocks.api.mockClear();

 await fireEvent.click(within(folder).getByLabelText(i18n.ts._voiceRelay.deleteSecret));
 await fireEvent.click(within(folder).getByRole('button', { name: i18n.ts.save }));

 await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('admin/update-meta', {
  voiceCallLivekitSource: 'yaml', voiceCallLivekitUrl: '', voiceCallLivekitApiKey: '', voiceCallLivekitApiSecret: null, voiceCallPreferRelay: null,
 }));
 expect(within(folder).queryByText(i18n.ts._voiceRelay.secretSet)).toBeNull();
});
