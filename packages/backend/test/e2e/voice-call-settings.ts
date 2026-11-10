/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type * as Misskey from 'cherrypick-js';
import { api, signup } from '../utils.js';

describe('administrator call settings', () => {
	let admin: Misskey.entities.SignupResponse;
	let user: Misskey.entities.SignupResponse;
	let original: { voiceCallMaxParticipants: number; voiceCallLivekitSource: 'yaml' | 'custom' | 'disabled'; voiceCallLivekitUrl: string | null; voiceCallLivekitApiKey: string | null; voiceCallCloudflareTurnKeyId: string | null } | undefined;

	beforeAll(async () => {
		admin = await signup({ username: 'calladmin' });
		user = await signup({ username: 'calluser' });
	});

	beforeEach(async () => {
		original = undefined;
		const initial = await api('admin/meta', {}, admin);
		expect(initial.status).toBe(200);
		// The API never returns secret values, so a test must not overwrite existing secrets it cannot restore.
		expect(initial.body.voiceCallLivekitApiSecretSet).toBe(false);
		expect(initial.body.voiceCallCloudflareTurnApiTokenSet).toBe(false);
		original = initial.body;
	});

	afterEach(async () => {
		if (!original) return;
		const restored = await api('admin/update-meta', {
			voiceCallMaxParticipants: original.voiceCallMaxParticipants,
			voiceCallLivekitSource: original.voiceCallLivekitSource,
			voiceCallLivekitUrl: original.voiceCallLivekitUrl,
			voiceCallLivekitApiKey: original.voiceCallLivekitApiKey,
			voiceCallLivekitApiSecret: null,
			voiceCallCloudflareTurnKeyId: original.voiceCallCloudflareTurnKeyId,
			voiceCallCloudflareTurnApiToken: null,
		}, admin);
		expect(restored.status).toBe(204);
	});

	test('only administrators can read or change settings, and responses do not reveal secrets', async () => {
		const initial = await api('admin/meta', {}, admin);
		expect(initial.status).toBe(200);
		expect(initial.body.voiceCallMaxParticipants).toBe(10);

		expect((await api('admin/meta', {}, user)).status).toBe(403);
		expect((await api('admin/update-meta', { voiceCallMaxParticipants: 25 }, user)).status).toBe(403);

		for (const value of [0, 52, 10.5]) {
			expect((await api('admin/update-meta', { voiceCallMaxParticipants: value }, admin)).status).toBe(400);
		}

		const secret = 'test-livekit-secret-01234567890123456789';
		const turnToken = 'test-turn-secret-01234567890123456789';
		const saved = await api('admin/update-meta', {
			voiceCallMaxParticipants: 25,
			voiceCallLivekitSource: 'custom',
			voiceCallLivekitUrl: 'http://livekit.test:7880',
			voiceCallLivekitApiKey: 'test-key',
			voiceCallLivekitApiSecret: secret,
			voiceCallCloudflareTurnApiToken: turnToken,
		}, admin);
		expect(saved.status).toBe(204);

		const settings = await api('admin/meta', {}, admin);
		expect(settings.body).toMatchObject({ voiceCallMaxParticipants: 25, voiceCallLivekitApiSecretSet: true, voiceCallCloudflareTurnApiTokenSet: true });
		expect(JSON.stringify(settings.body)).not.toContain(secret);
		expect(JSON.stringify(settings.body)).not.toContain(turnToken);
		const publicMeta = await api('meta', { detail: true });
		expect(JSON.stringify(publicMeta.body)).not.toContain(secret);
		expect(JSON.stringify(publicMeta.body)).not.toContain(turnToken);
	});

	test('concurrent LiveKit updates cannot leave custom settings incomplete', async () => {
		for (let attempt = 0; attempt < 10; attempt++) {
			const prepared = await api('admin/update-meta', {
				voiceCallLivekitSource: 'yaml',
				voiceCallLivekitUrl: 'http://livekit.test:7880',
				voiceCallLivekitApiKey: 'test-key',
				voiceCallLivekitApiSecret: 'test-secret',
			}, admin);
			expect(prepared.status).toBe(204);

			const results = await Promise.all([
				api('admin/update-meta', { voiceCallLivekitSource: 'custom' }, admin),
				api('admin/update-meta', { voiceCallLivekitApiSecret: null }, admin),
			]);
			expect(results.map(result => result.status).sort()).toEqual([204, 400]);
			const settings = await api('admin/meta', {}, admin);
			expect(settings.body.voiceCallLivekitSource !== 'custom' || settings.body.voiceCallLivekitApiSecretSet).toBe(true);
		}
	});
});
