/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { compileString } from 'sass-embedded';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { ModuleKind, transpileModule } from 'typescript';
import type { Browser, Page } from 'playwright';
import type * as Vue from 'vue';

const require = createRequire(import.meta.url);
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
type ComponentSource = { code: string; classes: Record<string, string> };
let sources: Record<string, ComponentSource>;
let styles: string;
let metadataCode: string;

const toCommonJS = (source: string) => transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;

test.beforeAll(async () => {
	sources = {};
	const sheets = [compileString(await readFile(resolve('src/style.scss'), 'utf8')).css];
	for (const [name, path, realSetup] of [
		['shell', 'ui/friendly.vue', false],
		['router', 'components/global/RouterView.vue', false],
		['page', 'pages/drive.vue', true],
		['drive', 'components/MkDrive.vue', false],
		['sticky', 'components/global/MkStickyContainer.vue', true],
		['button', 'components/MkButton.vue', true],
		['footer', 'ui/friendly/mobile-footer-menu-friendly.vue', true],
	] as const) {
		const { descriptor } = parse(await readFile(resolve('src', path), 'utf8'));
		const classes: Record<string, string> = {};
		for (const style of descriptor.styles) {
			sheets.push(compileString(style.content).css.replace(/\.([a-zA-Z_][\w-]*)/g, (selector, className: string) => {
				if (className.startsWith('_')) return selector;
				classes[className] = `${name}-${className}`;
				return `.${classes[className]}`;
			}));
		}
		const template = realSetup
			? compileScript(descriptor, { id: name, inlineTemplate: true }).content
			: compileTemplate({ source: descriptor.template!.content, filename: path, id: name, compilerOptions: { isTS: true } }).code;
		sources[name] = { code: toCommonJS(template), classes };
	}
	styles = sheets.join('\n');
	metadataCode = toCommonJS(await readFile(resolve('src/page.ts'), 'utf8'));
});

// 서버·API 없이 실제 SFC 템플릿과 스타일의 배치·메타데이터만 시험한다.
// 드라이브 목록과 동작 결과는 fixture이며 실제 이동·삭제 검증을 대신하지 않는다.
async function mountLayout(browser: Browser, phone: boolean, width: number, height: number) {
	const context = await browser.newContext({
		viewport: { width, height },
		...(phone ? { userAgent: iphoneUA, isMobile: true, hasTouch: true } : {}),
	});
	await context.route('**/*', route => route.abort());
	const page = await context.newPage();
	await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>
		:root { --MI_THEME-bg: white; --MI_THEME-fg: black; --MI_THEME-divider: gray; }
		${styles}</style><div id="app"></div>`);
	await page.addScriptTag({ path: require.resolve('vue/dist/vue.global.prod.js') });
	await page.evaluate(async ({ sources, metadataCode, phone }) => {
		const vue = (window as unknown as { Vue: typeof Vue }).Vue;
		const { createApp, defineComponent, h, ref } = vue;
		const actions: string[] = [];
		const metadata = ref<{ mobileFooterInFlow?: boolean } | null>(null);
		const mainRouter = { currentRoute: ref({ name: 'my-drive' }) };
		const prefer = { s: { animation: false, useBlurEffect: false }, r: { showTitlebar: ref(false) } };
		const listeners = new Map<string, Set<(value: boolean) => void>>();
		const globalEvents = {
			on(name: string, fn: (value: boolean) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
			off(name: string, fn: (value: boolean) => void) { listeners.get(name)?.delete(fn); },
			emit(name: string, value: boolean) { listeners.get(name)?.forEach(fn => fn(value)); },
		};
		const modules: Record<string, unknown> = {
			vue,
			'./di.js': { DI: { pageMetadata: Symbol('pageMetadata'), currentStickyTop: Symbol('top'), currentStickyBottom: Symbol('bottom') } },
			'@/di.js': null,
			'@/i18n.js': { i18n: { ts: { drive: 'Drive', move: 'Move', delete: 'Delete' }, tsx: { _driveDeletion: { selectedCount: ({ count }: { count: number }) => `선택한 파일: ${count}` } } } },
			'@/preferences.js': { prefer },
			'@/router.js': { mainRouter },
			'@/utility/device-kind.js': { deviceKind: phone ? 'smartphone' : 'desktop' },
			'@/utility/is-friendly.js': { isFriendly: () => ref(true) },
			'@/utility/detect-scrolling.js': { detectScrolling: () => {} },
			'@/utility/scroll-to-visibility.js': { scrollToVisibility: () => ({ showEl: ref(false) }) },
			'@/composables/use-scroll-position-keeper.js': { useScrollPositionKeeper: () => {} },
			'@/composables/use-mobile-footer-height.js': { useMobileFooterHeight: () => {} },
			'@/events.js': { globalEvents },
			'@/store.js': { store: { s: { showHomeButtonInNavbar: true, showChatButtonInNavbar: true } } },
			'@/i.js': { $i: { policies: {} } },
			'@/accounts.js': { getAccountMenu: async () => [] },
			'@/os.js': {},
			'@/utility/haptic.js': { haptic: () => {} },
			'@/components/global/MkA.vue': { default: {} },
		};
		modules['@/di.js'] = modules['./di.js'];

		function evaluate(code: string) {
			const exports: Record<string, any> = {};
			new Function('require', 'exports', code)((id: string) => {
				if (!(id in modules)) throw new Error(`Missing layout dependency: ${id}`);
				return modules[id];
			}, exports);
			return exports;
		}

		const pageMetadata = evaluate(metadataCode);
		modules['@/page.js'] = pageMetadata;

		function component(name: string) {
			const result = evaluate(sources[name].code);
			const definition = result.default ?? { render: result.render };
			definition.__cssModules = { $style: sources[name].classes };
			return definition;
		}

		const Button = component('button');
		const Sticky = component('sticky');
		const Footer = component('footer');
		const driveState = {
			folder: ref<{ name: string } | null>(null), hierarchyFolders: [], select: null,
			selectedFolders: [], selectedFiles: ref([{}]), isEditMode: ref(true), isRootSelected: false,
			filesPaginator: { items: ref([{ id: 'file', name: '뜰.png' }]) }, foldersPaginator: { items: ref([]) },
			fetching: false, draghover: false, bulkBusy: false, driveDeletionBusy: false,
			canFetchFolders: false, canFetchFiles: false, shouldBeGroupedByDate: false, shouldEnableInfiniteScroll: false,
			prefer, i18n: (modules['@/i18n.js'] as { i18n: unknown }).i18n,
			moveFilesBulk: () => actions.push('move'), deleteFilesBulk: () => actions.push('delete'),
		};
		const Drive = { ...component('drive'), setup: () => driveState };
		modules['@/components/MkDrive.vue'] = { __esModule: true, default: Drive };
		const DrivePage = component('page');
		const OtherPage = defineComponent({
			setup() { pageMetadata.definePage({ title: 'Home' }); return () => h('div', { class: '_pageScrollable' }, 'Home'); },
		});
		const inDrive = ref(true);
		const RouterView = defineComponent({ setup: () => () => h('div', { class: ['_pageContainer', 'router-root'] }, [h(inDrive.value ? DrivePage : OtherPage)]) });
		const shell = {
			...component('shell'),
			setup() {
				pageMetadata.provideMetadataReceiver((getter: () => typeof metadata.value) => { metadata.value = getter(); });
				const isMobile = ref(phone || innerWidth <= 500);
				addEventListener('resize', () => { isMobile.value = phone || innerWidth <= 500; });
				return { prefer, pageMetadata: metadata, isMobile, deviceKind: phone ? 'smartphone' : 'desktop', showWidgetsSide: false,
					mainRouter, $i: null, enableNavButton: [], enablePostButton: [], shouldSuggestReload: false, shouldSuggestRestoreBackup: false };
			},
		};
		const app = createApp(shell);
		const errors: string[] = [];
		app.config.errorHandler = error => { errors.push(String(error)); };
		const empty = { render: () => null };
		for (const name of ['XCommon', 'XVoiceCallBarSlot', 'XStatusBars', 'XSidebar', 'MkTip', 'MkLoading']) app.component(name, empty);
		app.component('RouterView', RouterView);
		app.component('XMobileFooterMenu', Footer);
		app.component('MkStickyContainer', Sticky);
		app.component('MkButton', Button);
		app.component('XNavFolder', { render: () => h('span', 'Drive') });
		app.component('XFile', { render: () => h('div', '뜰.png') });
		app.directive('anim', {});
		app.directive('appear', {});
		app.mount('#app');
		await vue.nextTick();
		if (errors.length) throw new Error(errors.join('\n'));
		Object.assign(window, { driveLayout: { actions, inDrive, driveState, globalEvents } });
	}, { sources, metadataCode, phone });
	return page;
}

async function checkActions(page: Page) {
	const footer = page.locator('.footer-root');
	const navigationTop = await footer.count() ? (await footer.boundingBox())!.y : page.viewportSize()!.height;
	for (const target of [page.getByRole('status'), page.getByRole('button', { name: /Move/ }), page.getByRole('button', { name: 'Delete' })]) {
		const bounds = (await target.boundingBox())!;
		expect(bounds.y).toBeGreaterThanOrEqual(0);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(navigationTop);
		expect(await target.evaluate(element => {
			const rect = element.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
			return hit === element || element.contains(hit);
		})).toBe(true);
	}
	await page.getByRole('button', { name: /Move/ }).click();
	await page.getByRole('button', { name: 'Delete' }).click();
}

for (const phone of [true, false]) {
	test(`drive actions clear navigation on fresh entry and resizing with phone UA: ${phone}`, async ({ browser }) => {
		const page = await mountLayout(browser, phone, phone ? 390 : 1440, phone ? 844 : 900);
		try {
			if (phone) expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
			for (const [width, height] of [[390, 844], [375, 667], [320, 568], [844, 390], [1440, 900], [375, 667]]) {
				await page.setViewportSize({ width, height });
				await expect(page.locator('.footer-root')).toHaveCount(phone || width <= 500 ? 1 : 0);
				await checkActions(page);
				await page.locator('._pageScrollable').evaluate(element => { element.scrollTop = element.scrollHeight; });
				await checkActions(page);
			}
			const actions = await page.evaluate(() => (window as any).driveLayout.actions);
			expect(actions).toEqual(Array.from({ length: 12 }, () => ['move', 'delete']).flat());
			await page.evaluate(() => {
				const state = (window as any).driveLayout;
				state.driveState.folder.value = { name: '샘' };
				state.driveState.selectedFiles.value = Array.from({ length: 103 }, () => ({}));
			});
			await expect(page.getByRole('status')).toHaveText('선택한 파일: 103');
			await checkActions(page);
			await page.evaluate(() => { (window as any).driveLayout.inDrive.value = false; });
			await expect(page.locator('.footer-root')).toHaveCSS('position', 'fixed');
			await page.evaluate(() => { (window as any).driveLayout.globalEvents.emit('isAtBottom', true); });
			await expect(page.locator('.footer-root')).toHaveCSS('position', 'relative');
		} finally {
			await page.context().close();
		}
	});
}
