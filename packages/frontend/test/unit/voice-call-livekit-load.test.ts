/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('livekit-client', () => { throw new Error('Failed to fetch dynamically imported module'); });
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/os.js', () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(), actions: vi.fn(), promiseDialog: vi.fn(promise => promise) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/i.js', async importOriginal => ({
	...await importOriginal<typeof import('@/i.js')>(),
	$i: { token: 'test-token', policies: { maxFileSizeMb: 30 } },
}));

import { canSelectAudioOutput } from '@/utility/voice-call.js';

describe('output device selection without livekit', () => {
	test('reports that the output device cannot be selected when livekit cannot be loaded', async () => {
		await expect(canSelectAudioOutput()).resolves.toBe(false);
	});
});
