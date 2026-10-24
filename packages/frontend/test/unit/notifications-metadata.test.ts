/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h, inject, nextTick, ref } from 'vue';
import Notifications from '@/pages/notifications.vue';
import { DI } from '@/di.js';
import { i18n } from '@/i18n.js';
import { provideMetadataReceiver } from '@/page.js';

const MetadataHeader = defineComponent({
	setup() {
		const metadata = inject(DI.pageMetadata);
		return () => h('h1', metadata?.value?.title);
	},
});

async function renderNotifications(notification: boolean) {
	const visible = ref(false);
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(getMetadata => {
				document.title = `${getMetadata().title} | Instance`;
			});
			return () => visible.value ? h(Notifications, { notification }) : null;
		},
	});
	const result = render(host, {
		global: { stubs: { PageWithHeader: MetadataHeader } },
	});
	// The asynchronously loaded sidebar can mount after the current page sets its title.
	document.title = 'Timeline | Instance';
	visible.value = true;
	await nextTick();
	return result;
}

describe('notifications page metadata', () => {
	afterEach(() => {
		cleanup();
		document.title = '';
	});

	test('sidebar notifications preserve the current document title and keep local metadata blank', async () => {
		const result = await renderNotifications(true);

		expect(document.title).toBe('Timeline | Instance');
		expect(result.getByRole('heading').textContent).toBe('');
	});

	test('standalone notifications publish their page title', async () => {
		const result = await renderNotifications(false);

		expect(document.title).toBe(`${i18n.ts.notifications} | Instance`);
		expect(result.getByRole('heading').textContent).toBe(i18n.ts.notifications);
	});
});
