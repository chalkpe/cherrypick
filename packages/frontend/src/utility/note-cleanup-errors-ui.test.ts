/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' }, ensureSignin: () => ({ id: 'me' }) }));
// 언어별 문구를 확인하도록 호출 시점의 locale을 바꿀 수 있게 한다.
const activeLocale = vi.hoisted(() => ({ current: 'en-US' as 'en-US' | 'ko-KR' | 'ja-JP' }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	const instances = { 'en-US': new I18n(locales['en-US'], false), 'ko-KR': new I18n(locales['ko-KR'], false), 'ja-JP': new I18n(locales['ja-JP'], false) };
	return { i18n: { get ts() { return instances[activeLocale.current].ts; }, get tsx() { return instances[activeLocale.current].tsx; } } };
});
vi.mock('@/os.js', () => ({ confirm: vi.fn(async () => ({ canceled: true })), popupMenu: vi.fn() }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/components/MkFollowButton.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/utility/get-note-summary.js', () => ({ getNoteSummary: () => '' }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {} } }));
vi.mock('@/events.js', () => ({ globalEvents: { on: () => {}, off: () => {} } }));
import MkNotification from '@/components/MkNotification.vue';
import ReferencePicker from '@/pages/settings/note-cleanup/ReferencePicker.vue';
import { canRevealCleanupError, cleanupErrorMessage, cleanupFailure, isCleanupBusyError, isConditionCleanupError } from '@/utility/note-cleanup-errors.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); activeLocale.current = 'en-US'; });

test.each(['en-US', 'ja-JP', 'ko-KR'] as const)('notification links the stopped cleanup to its rule in %s with one result sentence', async language => {
	activeLocale.current = language;
	const { i18n } = await import('@/i18n.js');
	const view = render(MkNotification, { props: { notification: { type: 'noteCleanupProtectionFailed', id: 'n', createdAt: '2026-01-01T00:00:00Z', ruleId: 'r', errorCode: 'MISSING_CLIP' } as never }, global: { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkAvatar: true } } });
	const link = view.getByRole('link');
	expect(link.textContent).toBe(i18n.ts._noteCleanup.notificationBody);
	expect(link.getAttribute('href')).toBe('/settings/note-cleanup/r');
	expect(view.container.textContent).toContain(i18n.ts._noteCleanup.notification);
	expect(view.container.textContent).not.toMatch(/MISSING_CLIP|errorCode|secret/);
});

test.each(['en-US', 'ja-JP', 'ko-KR'] as const)('completion notification reports the deleted count in %s and links to note cleanup', async language => {
	activeLocale.current = language;
	const { i18n } = await import('@/i18n.js');
	const view = render(MkNotification, { props: { notification: { type: 'noteCleanupCompleted', id: 'n', createdAt: '2026-01-01T00:00:00Z', count: 7 } as never }, global: { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkAvatar: true } } });
	const link = view.getByRole('link');
	expect(link.textContent).toBe(i18n.tsx._noteCleanup.completedNotificationBody({ n: 7 }));
	expect(link.getAttribute('href')).toBe('/settings/note-cleanup');
	expect(view.container.textContent).toContain(i18n.ts._noteCleanup.completedNotification);
});

test('channel without description has no empty description line or raw reference ID', async () => {
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: 'secret-channel', name: 'Channel name', description: null }])));
	const view = render(ReferencePicker, { props: { kind: 'channel', modelValue: [] } });
	const checkbox = await view.findByRole('checkbox', { name: 'Channel name' });
	expect(checkbox.parentElement?.parentElement?.querySelectorAll('div').length).toBe(0);
	expect(view.container.textContent).not.toContain('secret-channel');
});

test('reference picker preserves clip name, visibility, missing selection and icon-only removal', async () => {
	vi.stubGlobal('fetch', async (url: string) => url.endsWith('/clips/list') ? new Response(JSON.stringify([{ id: 'visible-id', name: 'My clip', description: null, isPublic: false }])) : new Response(JSON.stringify({ error: { code: 'NO_SUCH_CLIP' } }), { status: 404 }));
	const onUpdate = vi.fn();
	const view = render(ReferencePicker, { props: { kind: 'clip', modelValue: ['missing-id'], 'onUpdate:modelValue': onUpdate } });
	await view.findByRole('checkbox', { name: 'My clip' });
	expect(view.getByText('Private')).toBeTruthy();
	expect(view.getByText('This selection is unavailable. Remove it or choose another item.')).toBeTruthy();
	expect(view.container.textContent).not.toMatch(/missing-id|visible-id/);
	const remove = view.getByRole('button', { name: 'Delete' });
	expect(remove.textContent?.trim()).toBe('');
	expect(remove.querySelector('i.ti.ti-x')).toBeTruthy();
	await fireEvent.click(remove);
	expect(onUpdate).toHaveBeenCalledWith([]);
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

test.each(['en-US', 'ja-JP', 'ko-KR'] as const)('사용자가 고칠 수 없는 코드는 %s에서 재시도 문구로 모인다', async language => {
	activeLocale.current = language;
	const { i18n } = await import('@/i18n.js');
	for (const code of ['TEMPORARY_FAILURE', 'SOMETHING_NEW', '']) {
		expect(cleanupErrorMessage(code)).toBe(i18n.ts._noteCleanup.requestError);
	}
	expect(cleanupErrorMessage('CLEANUP_BUSY')).toBe(i18n.ts._noteCleanup.busyError);
	expect(cleanupErrorMessage('CLEANUP_IN_PROGRESS')).toBe(i18n.ts._noteCleanup.inProgressError);
	expect(cleanupErrorMessage('KEEP_CANNOT_RUN')).toBe(i18n.ts._noteCleanup.keepRunError);
});

test('혼잡 오류는 두 코드 모두 다시 시도 버튼을 두지 않고 조건 공개 대상에서도 제외한다', () => {
	for (const code of ['CLEANUP_BUSY', 'CLEANUP_IN_PROGRESS']) {
		expect(isCleanupBusyError(code)).toBe(true);
		expect(canRevealCleanupError(code, 'condition.children.0')).toBe(false);
	}
	expect(isCleanupBusyError('MISSING_CLIP')).toBe(false);
	expect(canRevealCleanupError('MISSING_CLIP', 'condition.children.0')).toBe(true);
});

test('조건 구역 오류는 조건 관련 코드와 조건 경로만 해당한다', () => {
	for (const code of ['INCOMPLETE', 'LIMIT', 'REFERENCE_LIMIT', 'INVALID_CONDITION', 'MISSING_CLIP', 'INVALID_CLIP', 'MISSING_CHANNEL']) {
		expect(isConditionCleanupError(code, '')).toBe(true);
	}
	// 서버가 조건 경로로 알려주는 오류도 조건 문제로 본다.
	expect(isConditionCleanupError('SOMETHING_NEW', 'condition.children.0')).toBe(true);
	// 혼잡·이름·규칙 개수 한도·미리보기 필요 등은 조건과 무관하다. 규칙 한도는 경로가 condition이어도 제외한다.
	for (const code of ['CLEANUP_BUSY', 'CLEANUP_IN_PROGRESS', 'INVALID_NAME', 'RULE_LIMIT', 'PREVIEW_REQUIRED', 'CONFIRMATION_REQUIRED', 'KEEP_CANNOT_RUN', 'NO_SUCH_RULE', '']) {
		expect(isConditionCleanupError(code, 'condition')).toBe(false);
	}
	expect(canRevealCleanupError('LIMIT', '')).toBe(false);
});

test.each([['en-US', 'busy'], ['ja-JP', '混み合'], ['ko-KR', '몰리']] as const)('진행 중 혼잡 문구는 %s에서 요청 몰림 표현을 쓰지 않는다', async (language, busyWord) => {
	activeLocale.current = language;
	const { i18n } = await import('@/i18n.js');
	const text = cleanupErrorMessage('CLEANUP_IN_PROGRESS');
	expect(text).toBe(i18n.ts._noteCleanup.inProgressError);
	expect(text).not.toContain(busyWord);
	expect(text).not.toBe(i18n.ts._noteCleanup.busyError);
});
