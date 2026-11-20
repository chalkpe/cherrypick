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
vi.mock('@/components/MkRange.vue', () => ({ default: { template: '<div data-testid="range"></div>' } }));

import XVolume from '@/pages/chat/room.voice.volume.vue';

afterEach(() => {
	cleanup();
	mocks.prepareBoostAudio.mockReset();
});

describe('participant volume slider', () => {
	test.each(['pointerDown', 'pointerUp', 'touchStart', 'touchEnd'] as const)('wakes the amplifier synchronously on %s', async name => {
		const { getByTestId } = render(XVolume, { props: { identity: 'a', audio: 'voice' } });

		await fireEvent[name](getByTestId('range'));

		expect(mocks.prepareBoostAudio).toHaveBeenCalled();
	});
});
