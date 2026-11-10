/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(async () => ({ providers: [] })) }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.api, confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/instance.js', () => ({ fetchInstance: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => ({ voiceCallMaxParticipants: 10, voiceCallLivekitSource: 'yaml', voiceCallLivekitUrl: null, voiceCallLivekitApiKey: null, voiceCallLivekitApiSecretSet: false, voiceCallPreferRelay: null, voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiTokenSet: true })) }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/components/MkInput.vue', () => ({ default: { props: ['modelValue', 'type', 'autocomplete'], emits: ['update:modelValue'], template: '<label><span><slot name="label" /></span><input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><slot name="caption" /></label>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<div><slot name="label" /><slot /><slot name="footer" /></div>' } }));
vi.mock('@/components/MkRadios.vue', () => ({ default: { template: '<div><slot name="label" /></div>' } }));

afterEach(() => { cleanup(); mocks.api.mockClear(); });

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
 expect(view.container.querySelectorAll('h2')).toHaveLength(1);
 expect(mocks.api).toHaveBeenCalledWith('admin/voice-relay/manage', { action: 'list' });
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
