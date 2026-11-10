/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import type { Config } from '@/config.js';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';

const yamlConfig = {
	url: 'https://example.test',
	voiceCall: { livekit: { internalUrl: 'http://yaml.test', apiKey: 'yaml-key', apiSecret: 'y'.repeat(32) } },
} as Config;
const relay = { isEnabled: false, hasRetainedCalls: false };

test('keeps the existing YAML LiveKit connection when the administrator has not selected an override', () => {
	const service = new (VoiceBackendService as any)(yamlConfig, relay, {}, { voiceCallLivekitSource: 'yaml' });

	expect(service.getInternalUrl()).toBe('http://yaml.test');
});

test('uses the administrator LiveKit connection when selected', () => {
	const service = new (VoiceBackendService as any)(yamlConfig, relay, {}, {
		voiceCallLivekitSource: 'custom',
		voiceCallLivekitUrl: 'http://custom.test',
		voiceCallLivekitApiKey: 'custom-key',
		voiceCallLivekitApiSecret: 's'.repeat(32),
	});

	expect(service.getInternalUrl()).toBe('http://custom.test');
});
