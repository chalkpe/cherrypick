/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token', policies: {} }, ensureSignin: () => {}, iAmModerator: false }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
vi.mock('@/os.js', () => ({ confirm: async () => ({ canceled: true }) }));
vi.mock('@/pages/_loading_.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/_error_.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/timeline.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
 props: ['disabled'], emits: ['click'],
 setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/pages/settings/note-cleanup/RuleEditor.vue', () => ({ default: defineComponent({ props: ['rule'], setup: (props) => () => h('div', props.rule?.name) }) }));
import Settings from '@/pages/settings/note-cleanup.vue';
import { ROUTE_DEF } from '@/router.definition.js';
import { Nirax } from '@/lib/nirax.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('legacy compatibility slots do not consume the 32 editable rule slots', async () => {
 const rules = Array.from({ length: 32 }, (_, i) => ({ id: String(i), name: `Rule ${i}`, action: 'keep', enabled: true, legacy: i < 2 ? 'age' : null }));
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, migrated: true, blocked: false })));
 const view = render(Settings, { global: { stubs: { SearchMarker: { template: '<div><slot/></div>' }, SearchLabel: { template: '<div><slot/></div>' }, SearchText: { template: '<div><slot/></div>' } } } });
 await waitFor(() => expect(view.getAllByText('Rule 31').length).toBeGreaterThan(0));
 expect((view.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(false);
});

// 신규 계정의 기본 즐겨찾기 보호는 구 API 연결용으로 legacy=favorite를 갖지만 이관된 설정이 아니다
test.each([
	{ label: 'new account default rule linked to the old API', migrated: false, legacy: 'favorite', shown: false },
	{ label: 'actually migrated rule', migrated: true, legacy: 'age', shown: true },
	{ label: 'ordinary rule on a migrated account', migrated: true, legacy: null, shown: false },
	{ label: 'ordinary rule on a new account', migrated: false, legacy: null, shown: false },
])('migrated badge follows the actual migration state: $label', async ({ migrated, legacy, shown }) => {
	const rules = [{ id: 'r', name: 'Target rule', action: 'keep', enabled: true, legacy }];
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, migrated, blocked: false })));
	const view = render(Settings, { global: { stubs: { SearchMarker: { template: '<div><slot/></div>' }, SearchLabel: { template: '<div><slot/></div>' }, SearchText: { template: '<div><slot/></div>' } } } });
	await waitFor(() => expect(view.getAllByText('Target rule').length).toBeGreaterThan(0));
	expect(view.queryAllByText('Migrated setting').length).toBe(shown ? 1 : 0);
});

test('protection notification query selects its exact rule without falling back to a new rule', () => {
 const router = new Nirax(ROUTE_DEF, '/settings/note-cleanup?ruleId=protected-rule', true, defineComponent({}));
 expect(router.current.child?.props.get('ruleId')).toBe('protected-rule');
});

test('목록에서 기본 이름만 영어로 표시하고 같은 한국어 사용자 이름은 보존한다', async () => {
 const rules = [{ id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true }, { id: 'custom', name: '고정한 내 글', defaultName: null, action: 'keep', enabled: true }];
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, migrated: false, blocked: false })));
 const view = render(Settings, { global: { stubs: { SearchMarker: { template: '<div><slot/></div>' }, SearchLabel: { template: '<div><slot/></div>' }, SearchText: { template: '<div><slot/></div>' } } } });
 await view.findByRole('button', { name: 'My pinned notes' });
 expect(view.getByRole('button', { name: '고정한 내 글' })).toBeTruthy();
});

test('blocked page keeps temporary protection failure visible without asking for rule repairs', async () => {
 const rules = [{ id: 'r', name: 'Protection', defaultName: null, action: 'keep', enabled: true, lastError: { code: 'TEMPORARY_FAILURE', path: 'condition', referenceId: 'secret' } }];
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, migrated: false, blocked: true })));
 const view = render(Settings);
 await view.findByText('Temporarily unable to check keep rules. New deletions are paused for safety. Try again later.');
 expect(view.getByRole('alert').textContent).toContain('New deletions are paused');
 expect(view.container.textContent).not.toMatch(/TEMPORARY_FAILURE|secret|Repair the rule/);
});
test('list 503 busy failure keeps reload available with no invalid-input guidance', async () => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'CLEANUP_BUSY' } }), { status: 503 }));
 const view = render(Settings);
 await view.findByText('Note cleanup is busy. Please wait a moment and try again.');
 expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
});

test.each(['keep', 'delete'])('목록은 %s 임시 오류의 실제 영향을 안내한다', async action => {
 const rules = [{ id: 'r', name: 'Failed rule', action, enabled: true, lastError: { code: 'TEMPORARY_FAILURE', path: 'condition' } }];
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, migrated: false, blocked: action === 'keep' })));
 const view = render(Settings, { global: { stubs: { SearchMarker: { template: '<div><slot/></div>' } } } });
 await view.findByText(action === 'keep' ? 'Temporarily unable to check keep rules. New deletions are paused for safety. Try again later.' : 'Temporarily unable to check this delete rule. It is excluded; other delete rules can still apply. Try again later.');
});
