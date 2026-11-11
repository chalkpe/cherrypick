/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/vue';
import { defineComponent, h, Suspense, unref } from 'vue';

const session = vi.hoisted(() => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	return { id: 'admin', username: 'admin', token: 'test-token', policies: {} };
});
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: session, ensureSignin: () => session }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));
vi.mock('@/theme.js', () => ({ themeManager: { currentCompiledTheme: { panel: '#ffffff' } } }));

import VoiceRelay from '@/pages/admin/voice-relay.vue';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { provideMetadataReceiver } from '@/page.js';

const provider = { id: 'provider-1', origin: 'https://relay.example', enabled: true, validated: false };
const refusal = { message: 'Could not apply voice relay settings.', code: 'VOICE_RELAY_REQUEST_FAILED', id: '75cc1ac0-334c-4d1a-a34d-6e55c23595cb' };
const requests: { endpoint: string; body: Record<string, unknown> }[] = [];
let failedAction: string | null;
let networkFailure: boolean;
let eventErrors: unknown[];

const stubs = {
	PageWithHeader: { template: '<main><slot/></main>' },
	SearchMarker: { template: '<div><slot/></div>' },
	MkStickyContainer: { template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' },
	MkCondensedLine: { template: '<span><slot/></span>' },
};

function successfulPopup() {
	return os.popups.value.some(popup => unref(popup.props.success) === true);
}

function errorPopup() {
	return os.popups.value.find(popup => popup.props.type === 'error');
}

async function enterPage() {
	const view = render(defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h('div', [h(Suspense, null, { default: () => h(VoiceRelay) })]);
		},
	}), { global: { stubs, directives: { 'adaptive-border': {}, tooltip: {} }, config: { errorHandler: error => eventErrors.push(error) } } });
	await view.findByText(i18n.ts._voiceRelay.title);
	await waitFor(() => expect(requests).toHaveLength(2));
	return view;
}

async function openRental() {
	await enterPage();
	const header = screen.queryByRole('button', { name: i18n.ts._voiceRelay.title });
	if (header) await fireEvent.click(header);
	const origin = await screen.findByText(provider.origin);
	return origin.closest<HTMLElement>('[role="group"], section')!;
}

async function prepareAction(action: string) {
	const rental = await openRental();
	os.popups.value = [];
	if (action === 'save-provider') {
		await fireEvent.update(rental.querySelector('input[type="url"]')!, 'https://new-relay.example');
		await fireEvent.update(rental.querySelector('input[type="password"]')!, 'draft-secret');
	}
	const label = action === 'save-provider' ? i18n.ts.save : action === 'remove-provider' ? i18n.ts.delete : i18n.ts._voiceRelay.check;
	await fireEvent.click(within(rental).getByRole('button', { name: label }));
	if (action === 'remove-provider') {
		const confirmation = os.popups.value.find(popup => popup.props.showCancelButton);
		expect(confirmation?.props.text).toContain(provider.origin);
		confirmation!.events.done!({ canceled: false });
	}
	return rental;
}

beforeEach(() => {
	requests.length = 0;
	failedAction = null;
	networkFailure = false;
	eventErrors = [];
	os.popups.value = [];
	vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const endpoint = String(input).split('/api/')[1];
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests.push({ endpoint, body });
		if ((body.action ?? endpoint) === failedAction) {
			if (networkFailure) throw new TypeError('Failed to fetch');
			return new Response(JSON.stringify({ error: refusal }), { status: 400 });
		}
		if (endpoint === 'admin/meta') {
			return new Response(JSON.stringify({
				voiceCallMaxParticipants: 10, voiceCallLivekitSource: 'yaml', voiceCallLivekitUrl: null,
				voiceCallLivekitApiKey: null, voiceCallLivekitApiSecretSet: false, voiceCallPreferRelay: null,
				voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiTokenSet: false,
			}), { status: 200 });
		}
		if (endpoint === 'admin/voice-relay/manage') {
			const providers = body.action === 'remove-provider' ? [] : body.action === 'save-provider'
				? [{ ...provider, origin: body.origin }] : [provider];
			const capacity = body.action === 'check-provider'
				? { accepting: true, maxSlots: 20, reservedSlots: 3, remainingSlots: 17, remainingRooms: 4 } : undefined;
			return new Response(JSON.stringify({ providers, capacity }), { status: 200 });
		}
		if (endpoint === 'admin/update-meta') return new Response(null, { status: 204 });
		if (endpoint === 'meta') return new Response('{}', { status: 200 });
		throw new Error(`Unexpected request: ${endpoint}`);
	});
});

afterEach(() => {
	cleanup();
	os.popups.value = [];
	vi.restoreAllMocks();
});

test('entering call settings only reads meta and the provider list, without a success check', async () => {
	await enterPage();

	expect(requests).toEqual([
		{ endpoint: 'admin/meta', body: { i: 'test-token' } },
		{ endpoint: 'admin/voice-relay/manage', body: { action: 'list', i: 'test-token' } },
	]);
	expect(successfulPopup()).toBe(false);
	expect(eventErrors).toEqual([]);
});

test.each([false, true])('a failed initial list shows an error (network failure: %s)', async network => {
	failedAction = 'list';
	networkFailure = network;
	await enterPage();
	await waitFor(() => expect(errorPopup()).toBeDefined());

	expect(errorPopup()!.props.text).toContain(network ? 'Failed to fetch' : refusal.message);
	expect(successfulPopup()).toBe(false);
	expect(requests).toHaveLength(2);
	expect(eventErrors).toEqual([]);
});

test('rental folds like the other settings and preserves unsaved input and provider controls', async () => {
	await enterPage();
	const header = screen.getByRole('button', { name: i18n.ts._voiceRelay.title });
	const rental = header.closest<HTMLElement>('[role="group"]')!;
	expect(rental.getAttribute('aria-expanded')).toBe('false');
	expect(header.querySelector('.ti-phone')).not.toBeNull();

	await fireEvent.click(header);
	const origin = rental.querySelector<HTMLInputElement>('input[type="url"]')!;
	const secret = rental.querySelector<HTMLInputElement>('input[type="password"]')!;
	await fireEvent.click(await within(rental).findByRole('button', { name: i18n.ts.edit }));
	await fireEvent.update(origin, 'https://draft.example');
	await fireEvent.update(secret, 'unsaved-secret');
	await fireEvent.click(within(rental).getByText(i18n.ts.enable));

	await fireEvent.click(header);
	await waitFor(() => expect(rental.getAttribute('aria-expanded')).toBe('false'));
	expect(within(rental).queryByRole('button', { name: i18n.ts.save })).toBeNull();
	await fireEvent.click(header);
	await waitFor(() => expect(rental.getAttribute('aria-expanded')).toBe('true'));

	expect(origin.isConnected).toBe(true);
	expect(origin.value).toBe('https://draft.example');
	expect(secret.value).toBe('unsaved-secret');
	expect(within(rental).getByRole('button', { name: i18n.ts.cancel })).toBeTruthy();
	expect(within(rental).getByText(provider.origin)).toBeTruthy();
	expect(requests).toHaveLength(2);

	await fireEvent.click(within(rental).getByRole('button', { name: i18n.ts.save }));
	await waitFor(() => expect(requests.find(request => request.body.action === 'save-provider')?.body).toEqual({
		action: 'save-provider', id: 'provider-1', origin: 'https://draft.example', secret: 'unsaved-secret', enabled: false, i: 'test-token',
	}));
});

test.each(['save-provider', 'check-provider', 'remove-provider'])('%s keeps success feedback after the button is pressed', async action => {
	const rental = await prepareAction(action);
	await waitFor(() => expect(successfulPopup()).toBe(true));
	if (action === 'check-provider') {
		const info = os.popups.value.find(popup => popup.props.type === 'info');
		expect(info?.props.text).toBe(i18n.tsx._voiceRelay.capacity({ reserved: 3, max: 20, remaining: 17 }));
		info!.events.done!();
	}
	await waitFor(() => expect(requests.some(request => request.endpoint === 'meta')).toBe(true));

	expect(requests.filter(request => request.body.action === action)).toEqual([{
		endpoint: 'admin/voice-relay/manage',
		body: action === 'save-provider'
			? { action, origin: 'https://new-relay.example', secret: 'draft-secret', enabled: true, i: 'test-token' }
			: { action, id: 'provider-1', i: 'test-token' },
	}]);
	expect(errorPopup()).toBeUndefined();
	expect(eventErrors).toEqual([]);
	if (action === 'save-provider') {
		expect(rental.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe('');
		expect(within(rental).getByText('https://new-relay.example')).toBeTruthy();
	}
	if (action === 'remove-provider') expect(within(rental).queryByText(provider.origin)).toBeNull();
});

test.each(['save-provider', 'check-provider', 'remove-provider'])('%s keeps error feedback and the current input on failure', async action => {
	failedAction = action;
	const rental = await prepareAction(action);
	await waitFor(() => expect(errorPopup()).toBeDefined());
	await waitFor(() => expect(eventErrors).toHaveLength(1));

	expect(errorPopup()!.props.text).toBe(`${refusal.message}\n${refusal.id}`);
	expect(successfulPopup()).toBe(false);
	expect(within(rental).getByText(provider.origin)).toBeTruthy();
	if (action === 'save-provider') expect(rental.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('draft-secret');
	expect(requests.some(request => request.endpoint === 'meta')).toBe(false);
});

test.each([false, true])('capacity save preserves feedback (failure: %s)', async failed => {
	await enterPage();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceRelay.capacityTitle }));
	const input = await screen.findByRole('spinbutton');
	const capacity = input.closest<HTMLElement>('[role="group"]')!;
	await fireEvent.update(input, '20');
	if (failed) failedAction = 'admin/update-meta';

	await fireEvent.click(await within(capacity).findByRole('button', { name: i18n.ts.save }));
	await waitFor(() => expect(requests.find(request => request.endpoint === 'admin/update-meta')?.body).toEqual({
		voiceCallMaxParticipants: 20, i: 'test-token',
	}));
	await waitFor(() => expect(failed ? !!errorPopup() : successfulPopup()).toBe(true));

	expect((input as HTMLInputElement).value).toBe('20');
	if (failed) {
		expect(successfulPopup()).toBe(false);
		expect(errorPopup()!.props.text).toBe(`${refusal.message}\n${refusal.id}`);
	} else {
		expect(errorPopup()).toBeUndefined();
	}
});
