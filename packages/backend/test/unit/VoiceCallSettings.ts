/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import UpdateMeta, { meta as updateMeta } from '@/server/api/endpoints/admin/update-meta.js';
import { meta as adminMeta } from '@/server/api/endpoints/admin/meta.js';

function fixture() {
	const current = { voiceCallLivekitSource: 'custom', voiceCallLivekitUrl: 'http://livekit.test', voiceCallLivekitApiKey: 'key', voiceCallLivekitApiSecret: 'saved-secret' };
	const service = { fetch: vi.fn(async () => current), update: vi.fn(async (set: Record<string, unknown>, validate?: (value: typeof current) => void) => { validate?.(current); return Object.assign(current, set); }) };
	const voiceBackend = { retireEndedDirectRooms: vi.fn(async () => {}) };
	const endpoint = new (UpdateMeta as any)({ resolve: async () => ({ start: vi.fn(), dispose: vi.fn() }) }, {}, service, { log: vi.fn() }, voiceBackend);
	return { endpoint, service, current, voiceBackend };
}

test('call setting endpoints are administrator-only', () => {
	expect(updateMeta.requireAdmin).toBe(true);
	expect(adminMeta.requireAdmin).toBe(true);
});

test('accepts a total call limit from 1 to 51 and rejects other values', async () => {
	const { endpoint, service } = fixture();
	for (const limit of [0, 52, 1.5]) {
		await expect(endpoint.exec({ voiceCallMaxParticipants: limit }, { id: 'admin' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	}
	for (const limit of [1, 10, 25, 51]) {
		await endpoint.exec({ voiceCallMaxParticipants: limit }, { id: 'admin' }, null, null);
		expect(service.update).toHaveBeenLastCalledWith(expect.objectContaining({ voiceCallMaxParticipants: limit }), undefined);
	}
});

test('keeps an omitted LiveKit secret and rejects incomplete or unsafe custom settings', async () => {
	const { endpoint, current } = fixture();
	await endpoint.exec({ voiceCallLivekitUrl: 'https://new-livekit.test' }, { id: 'admin' }, null, null);
	expect(current.voiceCallLivekitApiSecret).toBe('saved-secret');
	await expect(endpoint.exec({ voiceCallLivekitApiSecret: null }, { id: 'admin' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	await expect(endpoint.exec({ voiceCallLivekitUrl: 'https://key:secret@livekit.test' }, { id: 'admin' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
});

test('checks ended direct rooms before disabling LiveKit', async () => {
	const { endpoint, service, voiceBackend } = fixture();

	await endpoint.exec({ voiceCallLivekitSource: 'disabled' }, { id: 'admin' }, null, null);

	expect(voiceBackend.retireEndedDirectRooms).toHaveBeenCalledOnce();
	expect(voiceBackend.retireEndedDirectRooms.mock.invocationCallOrder[0]).toBeLessThan(service.update.mock.invocationCallOrder[0]);
});
