/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';

vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({ _weather: {} }, { get: (t: any, k) => t[k] ?? String(k) }) } }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: () => null, getItemAsJson: () => null } }));
vi.mock('@/store.js', () => ({ store: { s: {}, r: {} } }));
vi.mock('@/utility/chart-vline.js', () => ({ chartVLine: () => ({}) }));
vi.mock('chart.js', () => ({ Chart: Object.assign(class { destroy() {} }, { register: () => {} }), registerables: [] }));

import MkWeather from '@/components/MkWeather.vue';
import WidgetWeather from '@/widgets/WidgetWeather.vue';

describe('天気ウィジェットの位置情報', () => {
	const getCurrentPosition = vi.fn();
	const requested: string[] = [];
	let originalWindowFetch: typeof window.fetch;

	beforeEach(() => {
		requested.length = 0;
		getCurrentPosition.mockReset();
		vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
		const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
			requested.push(input instanceof Request ? input.url : String(input));
			return new Response('', { status: 500 });
		});
		vi.stubGlobal('fetch', fetchSpy);
		originalWindowFetch = window.fetch;
		window.fetch = fetchSpy as typeof window.fetch;
	});

	afterEach(() => {
		cleanup();
		window.fetch = originalWindowFetch;
		vi.unstubAllGlobals();
	});

	test('外部サービスへ送る座標は小数第2位に丸める', async () => {
		render(MkWeather, { props: { latitude: 37.56612345, longtitude: 126.97849876 } });

		await vi.waitFor(() => {
			expect(requested.some(u => u.startsWith('https://nominatim.openstreetmap.org/'))).toBe(true);
			expect(requested.some(u => u.startsWith('https://api.open-meteo.com/'))).toBe(true);
		});

		const nominatim = new URL(requested.find(u => u.startsWith('https://nominatim.openstreetmap.org/'))!);
		expect(nominatim.searchParams.get('lat')).toBe('37.57');
		expect(nominatim.searchParams.get('lon')).toBe('126.98');

		const meteo = new URL(requested.find(u => u.startsWith('https://api.open-meteo.com/'))!);
		expect(meteo.searchParams.get('latitude')).toBe('37.57');
		expect(meteo.searchParams.get('longitude')).toBe('126.98');
	});

	test('現在地の使用を指定していない場合は位置情報の権限を要求しない', async () => {
		render(MkWeather, { props: { latitude: 37.566, longtitude: 126.9784 } });
		await vi.waitFor(() => expect(requested.length).toBeGreaterThan(0));

		expect(getCurrentPosition).not.toHaveBeenCalled();
	});

	test('設定を保存していないウィジェットは従来の既定値どおり位置情報を取得する', async () => {
		render(WidgetWeather, { props: { widget: { name: 'weather', id: 'w1', data: {} } } as any });
		await vi.waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
	});

	test('現在地の使用を無効にしたウィジェットは位置情報の権限を要求しない', async () => {
		render(WidgetWeather, { props: { widget: { name: 'weather', id: 'w1', data: { useCurrentLocation: false } } } as any });
		await vi.waitFor(() => expect(requested.length).toBeGreaterThan(0));

		expect(getCurrentPosition).not.toHaveBeenCalled();
	});

	test('現在地の使用を有効にした既存のウィジェットは従来どおり位置情報を取得する', async () => {
		render(WidgetWeather, { props: { widget: { name: 'weather', id: 'w1', data: { useCurrentLocation: true } } } as any });
		await vi.waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
	});
});
