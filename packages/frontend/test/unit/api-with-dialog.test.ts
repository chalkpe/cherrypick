/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// 本物の os.apiWithDialog と misskeyApi を通し、サーバーへの要求の出口だけを差し替える。
// 画面に出るのは、本物の os.alert が開こうとしたダイアログの中身
const mocks = vi.hoisted(() => {
	const state = {
		me: { id: 'me', username: 'me', token: 'my-token', policies: {} },
		respond: (async () => new Response('{}', { status: 200 })) as () => Promise<Response>,
		bodies: [] as Record<string, unknown>[],
	};
	vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
		state.bodies.push(JSON.parse(init.body));
		return state.respond();
	}));
	return state;
});

vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));

import * as os from '@/os.js';
import { i18n } from '@/i18n.js';

function shownDialog(): { title?: string; text?: string } | undefined {
	return os.popups.value.map(popup => popup.props as { type?: string; title?: string; text?: string }).findLast(props => props.type === 'error');
}

async function failedRequest(customErrors?: os.ApiWithDialogCustomErrors) {
	await expect(os.apiWithDialog('i/update', { name: 'a' }, undefined, customErrors)).rejects.toBeDefined();
	await vi.waitFor(() => expect(shownDialog()).toBeDefined());
	return shownDialog()!;
}

const refusal = { message: 'No such thing.', code: 'NO_SUCH_THING', id: '00000000-0000-4000-8000-000000000000' };

beforeEach(() => {
	mocks.bodies.length = 0;
	os.popups.value = [];
});

afterEach(() => {
	os.popups.value = [];
});

describe('an error that is not an answer from the server', () => {
	const notAnAnswer: [string, () => Promise<Response>][] = [
		['the network is gone', async () => { throw new TypeError('Failed to fetch'); }],
		['the body of a failed response is empty', async () => new Response('', { status: 502 })],
	];

	// develop は err.code.startsWith で止まり、窓を開かなかった。チャットの外の画面はそのまま
	test.each(notAnAnswer)('%s: a screen without words for it opens no window, and the caller still hears of it', async (_label, respond) => {
		mocks.respond = respond;

		await expect(os.apiWithDialog('i/update', { name: 'a' })).rejects.toBeDefined();
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(shownDialog()).toBeUndefined();
	});

	test('a screen with words only for answers of the server opens no window either', async () => {
		mocks.respond = async () => { throw new TypeError('Failed to fetch'); };

		await expect(os.apiWithDialog('i/update', { name: 'a' }, undefined, { [refusal.id]: { text: 'in our own words' } })).rejects.toBeDefined();
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(shownDialog()).toBeUndefined();
	});

	test('a screen with words of its own for any failure uses them', async () => {
		mocks.respond = async () => { throw new TypeError('Failed to fetch'); };

		const dialog = await failedRequest({ default: { text: 'in our own words' } });

		expect(dialog.text).toBe('in our own words');
		expect(dialog.title).toBeUndefined();
	});

	test('a response that is not JSON keeps its own explanation', async () => {
		mocks.respond = async () => new Response('<html>', { status: 502 });

		const dialog = await failedRequest();

		expect(dialog.title).toBe(i18n.ts.gotInvalidResponseError);
		expect(dialog.text).toBe(i18n.ts.gotInvalidResponseErrorDescription);
	});
});

describe('an answer from the server', () => {
	test('without words of the screen, still shows what the server said and its id', async () => {
		mocks.respond = async () => new Response(JSON.stringify({ error: refusal }), { status: 400 });

		const dialog = await failedRequest();

		expect(dialog.text).toBe(`${refusal.message}\n${refusal.id}`);
		expect(dialog.title).toBeUndefined();
	});

	test('with words of the screen for that id, shows them', async () => {
		mocks.respond = async () => new Response(JSON.stringify({ error: refusal }), { status: 400 });

		const dialog = await failedRequest({ [refusal.id]: { text: 'in our own words' } });

		expect(dialog.text).toBe('in our own words');
	});

	test('the request carried my credential', async () => {
		mocks.respond = async () => new Response(JSON.stringify({ error: refusal }), { status: 400 });

		await failedRequest();

		expect(mocks.bodies.at(-1)).toEqual({ name: 'a', i: 'my-token' });
	});
});
