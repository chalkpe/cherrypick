/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { compileString } from 'sass-embedded';
import { compileTemplate, parse } from 'vue/compiler-sfc';
import { ModuleKind, transpileModule } from 'typescript';
import type { Browser, Page } from 'playwright';
import type * as Vue from 'vue';

const require = createRequire(import.meta.url);
type ComponentSource = { code: string; classes: Record<string, string> };
let sources: Record<string, ComponentSource>;
let styles: string;

const toCommonJS = (source: string) => transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;

test.beforeAll(async () => {
	sources = {};
	const sheets: string[] = [];
	for (const [name, path] of [
		['histories', 'components/MkChatHistories.vue'],
		['acct', 'components/global/MkAcct.vue'],
		['username', 'components/global/MkUserName.vue'],
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
		sources[name] = {
			code: toCommonJS(compileTemplate({ source: descriptor.template!.content, filename: path, id: name, compilerOptions: { isTS: true } }).code),
			classes,
		};
	}
	styles = sheets.join('\n');
});

// 서버·API 없이 실제 SFC 템플릿과 스타일의 배치만 시험한다. 대화 목록의 데이터는 fixture이며,
// 좁은 칸에서 이름과 계정 주소 중 무엇이 먼저 줄어드는지는 실제 브라우저 배치로 확인한다.
async function mountLayout(browser: Browser, width: number) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await context.route('**/*', route => route.abort());
	const page = await context.newPage();
	await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>
		:root { --MI_THEME-bg: white; --MI_THEME-fg: black; --MI_THEME-divider: gray; --MI_THEME-accent: crimson; --MI_THEME-fgTransparent: gray; }
		${styles}</style><div id="app"></div>`);
	await page.addScriptTag({ path: require.resolve('vue/dist/vue.global.prod.js') });
	await page.evaluate(async ({ sources, width }) => {
		const vue = (window as unknown as { Vue: typeof Vue }).Vue;
		const { createApp, defineComponent, h, ref } = vue;
		const i18n = {
			ts: { you: '나', _chat: { openRoom: '방 열기', noHistory: '기록 없음' } },
			tsx: { _voiceCall: { inCallCount: ({ n }: { n: number }) => `통화 중 ${n}` } },
		};
		const modules: Record<string, unknown> = {
			vue,
			'@/i18n.js': { i18n },
			'@/filters/user.js': { userName: (u: { name?: string | null; username: string }) => u.name ?? u.username },
			'@/preferences.js': { prefer: { r: { deidentifyMutedUsers: ref(false) } } },
			'@@/js/config.js': { host: 'local.example' },
			'punycode.js': { toUnicode: (x: string) => x },
		};
		function evaluate(code: string) {
			const exports: Record<string, any> = {};
			new Function('require', 'exports', code)((id: string) => {
				if (!(id in modules)) throw new Error(`Missing layout dependency: ${id}`);
				return modules[id];
			}, exports);
			return exports;
		}
		function component(name: string) {
			const result = evaluate(sources[name].code);
			const definition = result.default ?? { render: result.render };
			definition.__cssModules = { $style: sources[name].classes };
			return definition;
		}

		// Mfm plain/nowrap은 글자를 그대로 한 줄로 보이므로 배치 시험에서는 같은 모양의 span으로 대신한다
		const Mfm = defineComponent({
			props: { text: { type: String, default: '' } },
			setup: (props: { text: string }) => () => h('span', { style: { whiteSpace: 'nowrap' } }, props.text),
		});
		const Acct = { ...component('acct'), props: ['user', 'detail'], setup: () => ({ host: 'local.example' }) };
		const UserName = { ...component('username'), props: ['user', 'nowrap', 'enableEmojiMenu'], setup: () => ({ i18n, userName: (u: { name?: string | null; username: string }) => u.name ?? u.username, deidentified: false }) };
		const longAcctUser = { id: 'u1', name: '가을', username: 'abcdefghijklmnopqrst', host: 'a.127.0.0.1.nip.io', emojis: {} };
		const shortAcctUser = { id: 'u2', name: '소라', username: 'sora', host: null, emojis: {} };
		const longNameUser = { id: 'u3', name: '아주아주아주아주아주아주아주아주긴이름', username: 'longnameuser', host: 'b.127.0.0.1.nip.io', emojis: {} };
		const message = (text: string) => ({ id: 'm-' + text, text, createdAt: new Date().toISOString(), isRead: false, files: [], emojis: {} });
		const history = ref([
			{ id: 'h1', isMe: false, other: longAcctUser, message: { ...message('짧은 이름과 긴 주소'), toRoomId: null, toRoom: null } },
			{ id: 'h2', isMe: false, other: shortAcctUser, message: { ...message('짧은 주소'), toRoomId: null, toRoom: null } },
			{ id: 'h3', isMe: false, other: longNameUser, message: { ...message('긴 이름과 긴 주소'), toRoomId: null, toRoom: null } },
			{ id: 'h4', isMe: false, other: null, message: { ...message('그룹 미리보기'), toRoomId: 'r1', toRoom: { id: 'r1', name: '아주아주아주아주아주아주아주아주긴그룹이름', owner: { id: 'o1', username: 'owner', host: null }, hasChannels: false }, toRoomChannel: null } },
		]);
		const Histories = {
			...component('histories'),
			setup: () => ({
				history, additionalRooms: ref([]), voiceStates: new Map(), initializing: ref(false),
				i18n, channelListPath: (id: string) => `/chat/room/${id}/channels`,
			}),
		};
		const containerWidth = ref(width);
		const Root = defineComponent({
			setup: () => () => h('div', { style: { containerType: 'inline-size', width: containerWidth.value + 'px' } }, [h(Histories)]),
		});
		const app = createApp(Root);
		const errors: string[] = [];
		app.config.errorHandler = error => { errors.push(String(error)); };
		app.component('Mfm', Mfm);
		app.component('MkAcct', Acct);
		app.component('MkUserName', UserName);
		app.component('MkA', defineComponent({ setup: (_props, { slots }) => () => h('a', { href: '#' }, slots.default?.()) }));
		app.component('MkAvatar', defineComponent({ setup: () => () => h('div') }));
		app.component('MkTime', defineComponent({ setup: () => () => h('span', '지금') }));
		app.component('MkResult', defineComponent({ setup: () => () => null }));
		app.component('MkLoading', defineComponent({ setup: () => () => null }));
		app.mount('#app');
		await vue.nextTick();
		if (errors.length) throw new Error(errors.join('\n'));
		Object.assign(window, { historiesLayout: { containerWidth } });
	}, { sources, width });
	return page;
}

type Truncation = { name: { client: number; scroll: number }; acct: { client: number; scroll: number } };
async function measureRow(page: Page, index: number): Promise<Truncation> {
	return page.evaluate((i) => {
		const rows = document.querySelectorAll('a[class*="message"]');
		const row = rows[i];
		const name = row.querySelector('[class*="messageHeaderName"]') as HTMLElement;
		const acct = row.querySelector('[class*="messageHeaderUsername"]') as HTMLElement;
		const of = (el: HTMLElement | null) => el ? { client: el.clientWidth, scroll: el.scrollWidth } : { client: 0, scroll: 0 };
		return { name: of(name), acct: of(acct) };
	}, index);
}

async function setWidth(page: Page, width: number) {
	await page.evaluate((w) => { (window as any).historiesLayout.containerWidth.value = w; }, width);
	await page.waitForTimeout(100);
}

test('좁은 칸에서 이름이 먼저 보이고 계정 주소가 먼저 줄어든다', async ({ browser }) => {
	const page = await mountLayout(browser, 300);
	try {
		// 짧은 이름 + 긴 주소: 이름은 잘리지 않고 주소가 잘려야 한다
		const narrow = await measureRow(page, 0);
		expect(narrow.name.scroll).toBeLessThanOrEqual(narrow.name.client);
		expect(narrow.acct.scroll).toBeGreaterThan(narrow.acct.client);

		// 긴 이름 + 긴 주소: 주소가 먼저 줄어들고 이름은 남은 칸을 쓴다
		const longName = await measureRow(page, 2);
		expect(longName.acct.scroll).toBeGreaterThan(longName.acct.client);
		expect(longName.name.client).toBeGreaterThan(0);

		// 넓은 칸에서는 둘 다 그대로 보인다
		await setWidth(page, 700);
		const wide = await measureRow(page, 0);
		expect(wide.name.scroll).toBeLessThanOrEqual(wide.name.client);
		expect(wide.acct.scroll).toBeLessThanOrEqual(wide.acct.client);

		// 그룹 줄은 이름 말줄임 기존 동작을 유지한다
		await setWidth(page, 300);
		const group = await measureRow(page, 3);
		expect(group.name.scroll).toBeGreaterThan(group.name.client);
	} finally {
		await page.context().close();
	}
});

test('휴대폰 폭에서도 이름이 먼저 보이고 계정 주소가 먼저 줄어든다', async ({ browser }) => {
	const page = await mountLayout(browser, 335);
	try {
		const row = await measureRow(page, 0);
		expect(row.name.scroll).toBeLessThanOrEqual(row.name.client);
		expect(row.acct.scroll).toBeGreaterThan(row.acct.client);
	} finally {
		await page.context().close();
	}
});
