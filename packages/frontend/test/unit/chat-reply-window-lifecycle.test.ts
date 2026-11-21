/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { render } from '@testing-library/vue';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { useReplyWindowLifecycle } from '@/pages/chat/use-reply-window-lifecycle.js';

function setup() {
	const close = vi.fn();
	const frontmost = ref(true);
	const Page = defineComponent({ setup() { useReplyWindowLifecycle(close, frontmost); return () => h('div', 'page'); } });
	const Other = defineComponent({ setup: () => () => h('div', 'other') });
	const current = ref<'page' | 'other'>('page');
	const Host = defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => h(current.value === 'page' ? Page : Other, { key: current.value }) }) });
	render(Host);
	return { close, frontmost, current };
}

test('KeepAlive로 대화 페이지가 비활성화되면 원문 창을 닫는다', async () => {
	const { close, current } = setup();
	expect(close).not.toHaveBeenCalled();
	current.value = 'other';
	await nextTick();
	expect(close).toHaveBeenCalledTimes(1);
});

test('스택 라우터에서 맨 앞이 아니게 되면 닫고, 맨 앞으로 돌아올 때는 닫지 않는다', async () => {
	const { close, frontmost } = setup();
	frontmost.value = false;
	await nextTick();
	expect(close).toHaveBeenCalledTimes(1);
	frontmost.value = true;
	await nextTick();
	expect(close).toHaveBeenCalledTimes(1);
});
