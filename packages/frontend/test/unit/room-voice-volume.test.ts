/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';

const mocks = vi.hoisted(() => ({
	prepareBoostAudio: vi.fn(),
	setParticipantVolume: vi.fn(),
}));

vi.mock('@/i18n.js', () => ({ i18n: { ts: { _voiceCall: { voiceVolume: 'voice', screenShareVolume: 'share' } } } }));
vi.mock('@/utility/voice-call.js', () => ({
	participantVolume: () => 1,
	prepareBoostAudio: mocks.prepareBoostAudio,
	setParticipantVolume: mocks.setParticipantVolume,
}));
vi.mock('@/components/MkRange.vue', () => ({ default: { props: ['min', 'max'], template: '<div data-testid="range" :data-min="min" :data-max="max"></div>' } }));

import XVolume from '@/pages/chat/room.voice.volume.vue';

afterEach(() => {
	cleanup();
	mocks.prepareBoostAudio.mockReset();
});

describe('participant volume slider', () => {
	test.each(['pointerDown', 'pointerUp', 'touchStart', 'touchEnd'] as const)('wakes the amplifier within the %s handler itself', name => {
		const { getByTestId } = render(XVolume, { props: { identity: 'a', audio: 'voice' } });

		// 처리기가 끝난 뒤 한 번도 기다리지 않고 확인한다 (사용자 조작 안에서 불려야 한다)
		void fireEvent[name](getByTestId('range'));

		expect(mocks.prepareBoostAudio).toHaveBeenCalledOnce();
	});

	test('lets the slider go from 0% to 200%', () => {
		const { getByTestId } = render(XVolume, { props: { identity: 'a', audio: 'voice' } });

		expect(getByTestId('range').getAttribute('data-min')).toBe('0');
		expect(getByTestId('range').getAttribute('data-max')).toBe('2');
	});
});
