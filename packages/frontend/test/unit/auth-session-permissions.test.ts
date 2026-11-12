/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import AuthForm from '@/pages/auth.form.vue';
import { i18n } from '@/i18n.js';

vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => {}) }));

afterEach(cleanup);

const registered = ['read:account', 'write:notes'] as const;

function session(permission?: string[]) {
	return { id: 'session', token: 'request', app: { id: 'app', name: 'Scope test', callbackUrl: 'https://client.example/callback', permission: [...registered] }, ...(permission == null ? {} : { permission }) };
}

test('shows the session permissions instead of all registered app permissions', () => {
	const view = render(AuthForm, { props: { session: session(['read:account']) } });
	expect([...view.container.querySelectorAll('li')].map(el => el.textContent)).toEqual([i18n.ts._permissions['read:account']]);
});

test('honors an explicit empty session permission list', () => {
	const view = render(AuthForm, { props: { session: session([]) } });
	expect(view.container.querySelector('ul')).toBeNull();
});

test('keeps legacy sessions on their app permissions', () => {
	const view = render(AuthForm, { props: { session: session() } });
	expect([...view.container.querySelectorAll('li')].map(el => el.textContent)).toEqual(registered.map(p => i18n.ts._permissions[p]));
});
