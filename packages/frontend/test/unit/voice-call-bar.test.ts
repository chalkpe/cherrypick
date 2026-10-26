/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import { nextTick, unref } from 'vue';

const mocks = vi.hoisted(() => ({
	popupMenu: vi.fn(),
	setMicEnabled: vi.fn(),
	inUse: { audioinput: undefined as string | undefined, audiooutput: undefined as string | undefined },
}));

vi.mock('@/os.js', () => ({ popupMenu: mocks.popupMenu, claimZIndex: () => 1000 }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: { policies: { canScreenShare: false } } }));
vi.mock('@/utility/voice-call.js', async importOriginal => {
	const actual = await importOriginal<typeof import('@/utility/voice-call.js')>();
	const { reactive } = await import('vue');
	const voiceCall = reactive({ status: 'connected', room: { id: 'r1', name: 'room 1' }, micEnabled: true, deafened: false, audioBlocked: false, screenSharing: false });
	return {
		voiceCall,
		canShareScreen: () => false,
		leaveVoiceCall: vi.fn(),
		resumeAudio: vi.fn(),
		setDeafened: vi.fn(),
		setMicEnabled: mocks.setMicEnabled,
		startScreenShare: vi.fn(),
		stopScreenShare: vi.fn(),
		// 選択の保存と読み出しは本物を使う。ここでは通話を張らないので、本物が 'default' に落ちたときだけ通話中のデバイスを補う
		activeAudioDeviceId: (kind: 'audioinput' | 'audiooutput') => {
			const id = actual.activeAudioDeviceId(kind);
			return id === 'default' ? mocks.inUse[kind] ?? 'default' : id;
		},
		selectAudioDevice: actual.selectAudioDevice,
	};
});

import type { FakePrefer } from './fake-prefer.js';
import { prefer as mockedPrefer } from '@/preferences.js';
import XVoiceCallBar from '@/ui/_common_/voice-call-bar.vue';

const prefer = mockedPrefer as unknown as FakePrefer;

const devices = [
	{ kind: 'audioinput', deviceId: 'default', label: 'Default' },
	{ kind: 'audioinput', deviceId: 'mic-1', label: 'Mic 1' },
	{ kind: 'audioinput', deviceId: 'mic-2', label: 'Mic 2' },
];

async function openMicMenu() {
	render(XVoiceCallBar, { global: { stubs: { MkA: { template: '<a><slot /></a>' } } } });
	await fireEvent.click(screen.getAllByRole('button').find(b => b.getAttribute('aria-label') != null && b.querySelector('.ti-settings'))!);
	const items = mocks.popupMenu.mock.calls[0][0] as any[];
	return await items[0].children() as any[];
}

beforeEach(() => {
	mocks.popupMenu.mockReset();
	mocks.setMicEnabled.mockReset().mockResolvedValue(undefined);
	mocks.inUse.audioinput = undefined;
	prefer.reset({
		'voiceCall.inputDeviceId': null,
		'voiceCall.outputDeviceId': null,
		'voiceCall.echoCancellation': true,
		'voiceCall.noiseSuppression': true,
		'voiceCall.autoGainControl': true,
		'voiceCall.screenShareQuality': 'sharp',
		'voiceCall.screenShareAudio': true,
	});
	Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => devices } });
});

afterEach(() => {
	cleanup();
});

describe('voice call bar device menu', () => {
	test('marks the picked device right away while the menu stays open', async () => {
		mocks.inUse.audioinput = 'mic-1';
		const items = await openMicMenu();
		const mic1 = items.find(i => i.text === 'Mic 1');
		const mic2 = items.find(i => i.text === 'Mic 2');
		expect(unref(mic1.active)).toBe(true);
		expect(unref(mic2.active)).toBe(false);

		mic2.action();
		await nextTick();

		expect(unref(mic2.active)).toBe(true);
		expect(unref(mic1.active)).toBe(false);
	});

	test('marks the device in use when none was picked', async () => {
		mocks.inUse.audioinput = 'mic-2';
		const items = await openMicMenu();
		expect(items.filter(i => unref(i.active)).map(i => i.text)).toEqual(['Mic 2']);
	});

	test('checks nothing when the device in use is not listed', async () => {
		mocks.inUse.audioinput = 'gone';
		const items = await openMicMenu();
		expect(items.some(i => unref(i.active))).toBe(false);
	});
});

describe('voice call bar audio processing', () => {
	test.each([
		'voiceCall.echoCancellation',
		'voiceCall.noiseSuppression',
		'voiceCall.autoGainControl',
	])('turning %s off mid-call reopens the mic so the change applies', async key => {
		render(XVoiceCallBar, { global: { stubs: { MkA: { template: '<a><slot /></a>' } } } });
		await nextTick();

		prefer.commit(key, false);
		await nextTick();
		await Promise.resolve();

		expect(mocks.setMicEnabled.mock.calls).toEqual([[false], [true]]);
	});
});
