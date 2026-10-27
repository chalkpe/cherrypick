/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { Room } from 'livekit-client';

// 他のサーバーの通話では、確かめた ICE サーバーの一覧 (空のこともある) を rtcConfig.iceServers に渡し、
// 他のサーバーの LiveKit が参加時・再接続時に渡す ICE サーバーを使わせない (utility/voice-call.ts)。
// livekit-client がそのように振る舞うことを、本物の RTCEngine で確かめる。livekit-client を上げてこの振る舞いが変われば、ここで気付く
describe('livekit-client keeps an explicit ICE server list', () => {
	const fromServer = { iceServers: [{ urls: ['turn:127.0.0.1:3478?transport=tcp'], username: 'u', credential: 'c' }] };

	function engineWith(iceServers: RTCIceServer[] | undefined) {
		const room = new Room();
		(room as unknown as { maybeCreateEngine(): void }).maybeCreateEngine();
		const engine = (room as unknown as { engine: { rtcConfig: RTCConfiguration; makeRTCConfiguration(response?: unknown): RTCConfiguration } }).engine;
		// Room.connect は rtcConfig を接続の設定から写す
		engine.rtcConfig = iceServers != null ? { iceServers } : {};
		return engine;
	}

	test.each([
		['an empty list', []],
		['a list of its own', [{ urls: ['stun:stun.example:3478'] }]],
	])('uses %s over the one the LiveKit server sends when joining and resuming', (_label, iceServers) => {
		const engine = engineWith(iceServers);

		// 参加 (JoinResponse) と再接続 (ReconnectResponse) のどちらでも、同じ makeRTCConfiguration で決まる
		expect(engine.makeRTCConfiguration(fromServer).iceServers).toEqual(iceServers);
		expect(engine.makeRTCConfiguration({ ...fromServer, clientConfiguration: undefined }).iceServers).toEqual(iceServers);
	});

	test('uses the list the LiveKit server sends when none is given', () => {
		const engine = engineWith(undefined);

		expect(engine.makeRTCConfiguration(fromServer).iceServers).toEqual(fromServer.iceServers);
	});
});
