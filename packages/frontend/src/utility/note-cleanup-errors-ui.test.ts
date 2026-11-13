/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' }, ensureSignin: () => ({ id: 'me' }) }));
// 요약 시험에서 언어별 어순을 확인하도록 호출 시점의 locale을 바꿀 수 있게 한다.
const activeLocale = vi.hoisted(() => ({ current: 'en-US' as 'en-US' | 'ko-KR' | 'ja-JP' }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	const instances = { 'en-US': new I18n(locales['en-US'], false), 'ko-KR': new I18n(locales['ko-KR'], false), 'ja-JP': new I18n(locales['ja-JP'], false) };
	return { i18n: { get ts() { return instances[activeLocale.current].ts; }, get tsx() { return instances[activeLocale.current].tsx; } } };
});
const popupMenu = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => ({ canceled: true })));
vi.mock('@/os.js', () => ({ confirm, popupMenu }));
vi.mock('@/components/MkInput.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })]),
}) }));
vi.mock('@/components/MkSelect.vue', () => ({ default: defineComponent({ props: ['modelValue', 'items'], setup: () => () => h('div') }) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));

vi.mock('@/components/MkReactionIcon.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/components/MkFollowButton.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/utility/get-note-summary.js', () => ({ getNoteSummary: () => '' }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {} } }));
vi.mock('@/events.js', () => ({ globalEvents: { on: () => {}, off: () => {} } }));
import MkNotification from '@/components/MkNotification.vue';
import ReferencePicker from '@/pages/settings/note-cleanup/ReferencePicker.vue';
import { cleanupErrorMessage, cleanupFailure } from '@/utility/note-cleanup-errors.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); activeLocale.current = 'en-US'; });
test.each(['en-US', 'ja-JP', 'ko-KR'] as const)('notification gives temporary pause guidance in %s without asking for rule repairs', language => {
 activeLocale.current = language;
 const view = render(MkNotification, { props: { notification: { type: 'noteCleanupProtectionFailed', id: 'n', createdAt: '2026-01-01T00:00:00Z', ruleId: 'r', errorCode: 'TEMPORARY_FAILURE' } as never }, global: { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkAvatar: true } } });
 expect(view.getByRole('link').textContent).toContain(cleanupErrorMessage('TEMPORARY_FAILURE', 'keep'));
 expect(view.getByRole('link').getAttribute('href')).toBe('/settings/note-cleanup?ruleId=r');
 expect(view.container.textContent).not.toMatch(/TEMPORARY_FAILURE|repair|修正|수정/);
});
test('channel without description has no empty description line or raw reference ID', async () => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: 'secret-channel', name: 'Channel name', description: null }])));
 const view = render(ReferencePicker, { props: { kind: 'channel', modelValue: [] } });
 const checkbox = await view.findByRole('checkbox', { name: 'Channel name' });
 expect(checkbox.parentElement?.parentElement?.querySelectorAll('div').length).toBe(0);
 expect(view.container.textContent).not.toContain('secret-channel');
});
test('reference picker preserves clip name, visibility, missing selection and removal', async () => {
 vi.stubGlobal('fetch', async (url: string) => url.endsWith('/clips/list') ? new Response(JSON.stringify([{ id: 'visible-id', name: 'My clip', description: null, isPublic: false }])) : new Response(JSON.stringify({ error: { code: 'NO_SUCH_CLIP' } }), { status: 404 }));
 const onUpdate = vi.fn();
 const view = render(ReferencePicker, { props: { kind: 'clip', modelValue: ['missing-id'], 'onUpdate:modelValue': onUpdate } });
 await view.findByRole('checkbox', { name: 'My clip' });
 expect(view.getByText('Private')).toBeTruthy();
 expect(view.getByText('This selection is unavailable. Remove it or choose another item.')).toBeTruthy();
 expect(view.container.textContent).not.toMatch(/missing-id|visible-id/);
 await fireEvent.click(view.getByRole('button', { name: 'Delete' }));
 expect(onUpdate).toHaveBeenCalledWith([]);
});

test.each(['en-US', 'ja-JP', 'ko-KR'] as const)('규칙별 임시 오류와 요청 실패 안내를 %s에서 구분한다', language => {
 activeLocale.current = language;
 const keep = cleanupErrorMessage('TEMPORARY_FAILURE', 'keep');
 const deletion = cleanupErrorMessage('TEMPORARY_FAILURE', 'delete');
 const request = cleanupErrorMessage('TEMPORARY_FAILURE');
 expect(new Set([keep, deletion, request]).size).toBe(3);
 expect([keep, deletion, request].join(' ')).not.toMatch(/undefined|TEMPORARY_FAILURE|repair|修正|수정/);
});

// backend endpoint가 보장하는 고정 코드와 조건 경로를 실제 locale로 해석한다.
test.each(['en-US', 'ja-JP', 'ko-KR'] as const)('저장 오류의 코드·조건 경로·참조 ID 비노출을 %s에서 유지한다', async language => {
 activeLocale.current = language;
 const { i18n } = await import('@/i18n.js');
 for (const type of ['clip', 'channel']) {
  const code = type === 'clip' ? 'MISSING_CLIP' : 'MISSING_CHANNEL';
  const response = { code: 'INVALID_CLEANUP', message: 'missing-secret', info: { code, path: 'condition.children.0', referenceId: 'missing-secret' } };
  const failure = cleanupFailure(response);

  expect(failure).toEqual({ code, path: 'condition.children.0' });
  expect(cleanupErrorMessage(failure.code)).toBe(type === 'clip' ? i18n.ts._noteCleanup.missingClipError : i18n.ts._noteCleanup.missingChannelError);
  expect(cleanupErrorMessage(failure.code)).not.toContain('missing-secret');
 }
});
