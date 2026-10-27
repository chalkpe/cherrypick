/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('@/preferences/manager.js', () => ({ definePreferences: (definitions: unknown) => definitions }));

import { PREF_DEF } from '@/preferences/def.js';

describe('voice call preference account scopes', () => {
	test('keeps host consent and chat side on the account, and audio devices and processing on the device', () => {
		const flags = Object.fromEntries(Object.entries(PREF_DEF).filter(([key]) => key.startsWith('voiceCall.')).map(([key, def]) => [key, def.accountDependent === true]));
		expect(flags).toEqual({
			'voiceCall.acknowledgedRemoteHosts': true,
			'voiceCall.stageChatSide': true,
			'voiceCall.inputDeviceId': false,
			'voiceCall.outputDeviceId': false,
			'voiceCall.echoCancellation': false,
			'voiceCall.noiseSuppression': false,
			'voiceCall.autoGainControl': false,
			'voiceCall.participantVolumes': false,
			'voiceCall.screenShareVolumes': false,
			'voiceCall.screenShareQuality': false,
			'voiceCall.screenShareAudio': false,
		});
	});
});
