/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { compileString } from 'sass-embedded';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import { transpileModule, ModuleKind } from 'typescript';
import type * as Vue from 'vue';

const require = createRequire(import.meta.url);
let styles: string;
let footerTemplate: string;
let footerClasses: Record<string, string>;

async function loadStyle(path: string, prefix = '') {
	const source = await readFile(resolve('src', path), 'utf8');
	const descriptor = path.endsWith('.vue') ? parse(source).descriptor : null;
	const classes: Record<string, string> = {};
	const css = compileString(descriptor ? descriptor.styles[0].content : source).css.replace(/\.([a-zA-Z_][\w-]*)/g, (selector, name: string) => {
		if (!prefix || name.startsWith('_')) return selector;
		classes[name] = `${prefix}${name}`;
		return `.${classes[name]}`;
	});
	return { css, classes, template: descriptor?.template?.content ?? '' };
}

test.beforeAll(async () => {
	const global = await loadStyle('style.scss');
	const shell = await loadStyle('ui/friendly.vue', 'shell-');
	const router = await loadStyle('components/global/RouterView.vue', 'router-');
	const page = await loadStyle('components/global/PageWithHeader.vue', 'page-');
	const footer = await loadStyle('ui/friendly/mobile-footer-menu-friendly.vue', 'footer-');
	styles = [global.css, shell.css, router.css, page.css, footer.css].join('\n');
	const compiled = compileTemplate({ source: footer.template, filename: 'footer.vue', id: 'footer', compilerOptions: { isTS: true } });
	footerTemplate = transpileModule(compiled.code, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
	footerClasses = footer.classes;
});

async function mountLayout(browser: Browser, narrowFirst: boolean, forceInFlow: boolean, isAtBottom = false) {
	const page = await browser.newPage({ viewport: narrowFirst ? { width: 360, height: 780 } : { width: 1440, height: 900 } });
	await page.route('**/*', route => route.abort());
	await page.setContent(`<style>:root { --MI_THEME-divider: #ccc; }\n${styles}</style><div id="app"></div>`);
	await page.addScriptTag({ path: require.resolve('vue/dist/vue.global.prod.js') });
	await page.evaluate(({ footerTemplate, footerClasses, forceInFlow, isAtBottom }) => {
		const { createApp, defineComponent, ref } = (window as unknown as { Vue: typeof Vue }).Vue;
		const actions: string[] = [];
		const compiled: { render?: Vue.RenderFunction } = {};
		new Function('require', 'exports', footerTemplate)(() => (window as unknown as { Vue: typeof Vue }).Vue, compiled);
		const MobileFooter = defineComponent({
			props: { forceInFlow: Boolean },
			setup: () => ({
				prefer: { s: { animation: false, useBlurEffect: false } },
				store: { s: { showHomeButtonInNavbar: true } },
				mainRouter: { currentRoute: { value: { name: 'voice-relay' } } },
				$i: null, isAtBottom, showEl: false, queuedAheadItemsCount: 0,
				clickHomeButton: () => actions.push('home'),
				clickWidgetButton: () => {}, openAccountMenu: () => {}, closeAccountMenu: () => {},
			}),
			render: compiled.render,
		});
		const app = createApp({
			components: { MobileFooter },
			setup() {
				const narrow = ref(innerWidth <= 500);
				addEventListener('resize', () => { narrow.value = innerWidth <= 500; });
				return { narrow, forceInFlow, save: () => actions.push('save'), cancel: () => actions.push('cancel') };
			},
			// 고정 콘텐츠는 보존된 측정과 같은 scrollHeight 844px을 만든다. 서버/API는 사용하지 않는다.
			template: `<div class="shell-root"><div class="shell-nonTitlebarArea"><div class="shell-contents">
				<div></div><div class="router-root _pageContainer shell-content"><div class="_pageContainer" style="height:100%">
					<div class="_pageScrollable"><div style="height:50px">Call settings</div><div class="page-body">
						<div style="height:738px">Form contents</div><div class="_buttons" style="height:32px;padding-left:22px">
							<button id="save" style="width:100px" @click="save">Save</button><button id="cancel" style="width:100px" @click="cancel">Cancel</button>
						</div><div style="height:24px"></div>
					</div></div>
				</div></div><MobileFooter v-if="narrow" :forceInFlow="forceInFlow"/>
			</div></div></div>`,
		});
		app.config.globalProperties.$style = footerClasses;
		app.mount('#app');
		Object.assign(window, { footerLayoutActions: actions });
	}, { footerTemplate, footerClasses, forceInFlow, isAtBottom });
	return page;
}

async function scrollToBottom(page: Page) {
	await page.locator('._pageScrollable').evaluate(element => { element.scrollTop = element.scrollHeight; });
	await page.mouse.move(180, 450);
	await page.mouse.wheel(0, 2000);
	await page.keyboard.press('End');
	return page.locator('._pageScrollable').evaluate(element => ({
		clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
	}));
}

for (const narrowFirst of [true, false]) {
	test(`voice footer space survives initial narrow: ${narrowFirst} and repeated desktop resizing`, async ({ browser }, testInfo) => {
		const page = await mountLayout(browser, narrowFirst, true);
		try {
			await page.setViewportSize({ width: 360, height: 780 });
			await page.locator(`.${footerClasses.root}`).waitFor();
			const metrics = await scrollToBottom(page);
			await page.screenshot({ path: testInfo.outputPath('footer-layout.png') });
			await writeFile(testInfo.outputPath('scroll-metrics.json'), JSON.stringify(metrics));

			for (const id of ['save', 'cancel']) {
				const button = page.locator(`#${id}`);
				expect.soft(await button.evaluate(element => {
					const bounds = element.getBoundingClientRect();
					const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
					return hit === element || element.contains(hit);
				})).toBe(true);
				const bounds = (await button.boundingBox())!;
				await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
			}
			expect.soft(await page.evaluate(() => (window as unknown as { footerLayoutActions: string[] }).footerLayoutActions)).toEqual(['save', 'cancel']);
			expect(metrics).toEqual({ clientHeight: 729, scrollHeight: 844, scrollTop: 115 });

			await page.setViewportSize({ width: 1440, height: 900 });
			await page.locator(`.${footerClasses.root}`).waitFor({ state: 'detached' });
			expect((await scrollToBottom(page)).clientHeight).toBe(900);
			await page.setViewportSize({ width: 360, height: 780 });
			await page.locator(`.${footerClasses.root}`).waitFor();
			expect((await scrollToBottom(page)).clientHeight).toBe(729);
		} finally {
			await page.close();
		}
	});
}

for (const isAtBottom of [false, true]) {
	test(`other pages retain existing footer flow for bottom state ${isAtBottom}`, async ({ browser }) => {
		const page = await mountLayout(browser, true, false, isAtBottom);
		try {
			const footer = page.locator(`.${footerClasses.root}`);
			expect(await footer.evaluate(element => getComputedStyle(element).position)).toBe(isAtBottom ? 'relative' : 'fixed');
			expect((await scrollToBottom(page)).clientHeight).toBe(isAtBottom ? 729 : 780);
		} finally {
			await page.close();
		}
	});
}
