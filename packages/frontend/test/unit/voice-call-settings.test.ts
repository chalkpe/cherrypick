/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	popupMenu: vi.fn(),
	canSelectAudioOutput: vi.fn(),
}));

vi.mock('@/os.js', () => ({ popupMenu: mocks.popupMenu }));
vi.mock('@/i18n.js', () => ({
	i18n: { ts: { _voiceCall: new Proxy({}, { get: (_, key) => String(key) }) } },
}));
vi.mock('@/preferences.js', () => ({ prefer: { model: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { policies: { canScreenShare: false } } }));
vi.mock('@/utility/voice-call.js', () => ({
	activeAudioDeviceId: vi.fn(),
	canSelectAudioOutput: mocks.canSelectAudioOutput,
	canShareScreen: () => false,
	selectAudioDevice: vi.fn(),
}));

import { openVoiceCallSettings } from '@/utility/voice-call-settings.js';

const texts = () => (mocks.popupMenu.mock.calls[0][0] as Array<{ text?: string }>).map(item => item.text);
const click = () => ({ currentTarget: document.body, target: document.body }) as unknown as MouseEvent;

describe('voice call settings menu', () => {
	beforeEach(() => {
		mocks.popupMenu.mockReset();
		mocks.canSelectAudioOutput.mockReset();
	});

	test('shows the speaker item where the output device can be chosen', async () => {
		mocks.canSelectAudioOutput.mockResolvedValue(true);

		await openVoiceCallSettings(click());

		expect(texts()).toContain('outputDevice');
	});

	test('hides the speaker item where the output device cannot be chosen', async () => {
		mocks.canSelectAudioOutput.mockResolvedValue(false);

		await openVoiceCallSettings(click());

		expect(texts()).toContain('inputDevice');
		expect(texts()).not.toContain('outputDevice');
	});

	test('opens the menu at the element that was clicked', async () => {
		mocks.canSelectAudioOutput.mockResolvedValue(true);
		const target = document.createElement('button');
		const event = { currentTarget: target, target } as unknown as MouseEvent;

		const opening = openVoiceCallSettings(event);
		Object.defineProperty(event, 'currentTarget', { value: null });
		await opening;

		expect(mocks.popupMenu.mock.calls[0][1]).toBe(target);
	});
});
