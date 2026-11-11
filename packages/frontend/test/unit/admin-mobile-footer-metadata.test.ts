/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, ref, Suspense } from 'vue';
import { installFakeResizeObserver } from './fake-resize-observer.js';
import type { PageMetadata } from '@/page.js';

vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ currentRef: routerRef, replace: () => {} }) }));
const routerRef = ref({ route: { path: '/admin' }, child: { route: { name: 'voice-relay' } } });
vi.mock('@/instance.js', () => ({ instance: { disableRegistration: true, enableEmail: true, maintainerName: 'Test', maintainerEmail: 'test@example.test', inquiryUrl: 'https://example.test' } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: async () => [] }));
vi.mock('@/utility/fetch-releases.js', () => ({ fetchCherrypickReleases: async () => null }));
vi.mock('@/utility/admin-lookup.js', () => ({ lookupUser: () => {}, lookupUserByEmail: () => {}, lookupFile: () => {} }));
vi.mock('@/components/MkSuperMenu.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/os.js', () => ({}));

import Admin from '@/pages/admin/index.vue';
import { definePage, provideMetadataReceiver } from '@/page.js';

installFakeResizeObserver();
afterEach(cleanup);

test('admin forwards the child footer preference and clears it on another settings page', async () => {
	const metadata = ref<PageMetadata | null>(null);
	const childMetadata = ref<PageMetadata>({ title: 'Call settings', mobileFooterInFlow: true });
	const Child = defineComponent({
		setup() {
			definePage(childMetadata);
			return () => h('div', 'Child settings');
		},
	});
	render(defineComponent({
		setup() {
			provideMetadataReceiver(getter => { metadata.value = getter(); });
			return () => h(Suspense, null, { default: () => h(Admin) });
		},
	}), { global: { stubs: { NestedRouterView: Child } } });

	await waitFor(() => expect(metadata.value).toMatchObject({ mobileFooterInFlow: true }));
	childMetadata.value = { title: 'General settings' };
	await waitFor(() => expect(metadata.value).not.toHaveProperty('mobileFooterInFlow', true));
	childMetadata.value = { title: 'Call settings', mobileFooterInFlow: true };
	await waitFor(() => expect(metadata.value).toMatchObject({ mobileFooterInFlow: true }));
});
