/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/vue';

const mocks = vi.hoisted(() => ({ stop: vi.fn(), start: vi.fn() }));
vi.mock('@/utility/voice-call.js', () => ({
	voiceCall: { recording: false, recordingStarting: true, recordingAllowed: true, micEnabled: false, deafened: false, audioBlocked: false, screenSharing: false },
	startRecording: mocks.start, stopRecording: mocks.stop,
	leaveVoiceCall: vi.fn(), resumeAudio: vi.fn(), setDeafened: vi.fn(), setMicEnabled: vi.fn(), startScreenShare: vi.fn(), stopScreenShare: vi.fn(),
}));
vi.mock('@/utility/voice-call-settings.js', () => ({ openVoiceCallSettings: vi.fn(), screenShareAvailable: false }));

import Controls from '@/pages/chat/room.voice.controls.vue';
import { i18n } from '@/i18n.js';

test('offers cancellation while recording approval or media acquisition is pending', async () => {
	render(Controls, { global: { directives: { tooltip: () => {} } } });

	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.stopRecording }));

	expect(mocks.stop).toHaveBeenCalledOnce();
	expect(mocks.start).not.toHaveBeenCalled();
});
