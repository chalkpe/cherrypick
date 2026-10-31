/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import StatusEndpoint from '@/server/api/endpoints/chat/rooms/voice/status.js';
import { RemoteVoiceCallError } from '@/core/RemoteVoiceCallService.js';
import { createFixture, KNOWN_USERS } from '../misc/chat-voice-fixture.js';

const user = { id: 'me', host: null } as any;
const report = { roomId: 'r1', sessionId: 'PA_1', micMuted: true, deafened: false };

function fixture(member = true, remote = false) {
	const room = { id: 'r1', ownerId: 'owner', owner: { host: remote ? 'remote.test' : null } };
	const chat = { checkChatAvailability: vi.fn(), findRoomById: vi.fn().mockResolvedValue(room) };
	const local = { reportStatus: vi.fn().mockResolvedValue(true) };
	const host = { reportStatus: vi.fn() };
	const memberships = { exists: vi.fn().mockResolvedValue(member) };
	const endpoint = new StatusEndpoint(chat as any, local as any, host as any, memberships as any);
	return { endpoint, local, host };
}

describe('reported voice status', () => {
	test('updates only the authenticated local user and session', async () => {
		const f = fixture();
		await f.endpoint.exec(report, user, null, null);
		expect(f.local.reportStatus).toHaveBeenCalledWith(user, 'r1', 'PA_1', { micMuted: true, deafened: false });
	});

	test('does not forward reports from nonmembers', async () => {
		const f = fixture(false, true);
		await expect(f.endpoint.exec(report, user, null, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(f.host.reportStatus).not.toHaveBeenCalled();
		expect(f.local.reportStatus).not.toHaveBeenCalled();
	});

	test('forwards a remote room report to its owner', async () => {
		const f = fixture(true, true);
		await f.endpoint.exec(report, user, null, null);
		expect(f.host.reportStatus).toHaveBeenCalledWith(user, expect.anything(), expect.objectContaining({ host: 'remote.test' }), 'PA_1', { micMuted: true, deafened: false });
		expect(f.local.reportStatus).not.toHaveBeenCalled();
	});

	// 持ち主のサーバーに届けられない報告は、通話に入るとき (join) と同じく API のエラーにする。
	// 内部エラー (500) にすると、マイクやスピーカーを切り替えるたびにエラーログが残る
	test.each([
		['unsupported', 'REMOTE_HOST_UNSUPPORTED'],
		['forbidden', 'ACCESS_DENIED'],
		['unreachable', 'REMOTE_HOST_UNREACHABLE'],
	] as const)('answers a report the owner cannot take (%s) with %s instead of an internal error', async (reason, code) => {
		const f = fixture(true, true);
		f.host.reportStatus.mockRejectedValue(new RemoteVoiceCallError(reason));
		await expect(f.endpoint.exec(report, user, null, null)).rejects.toMatchObject({ code });
	});

	test('does not hide unexpected failures of the remote report', async () => {
		const f = fixture(true, true);
		f.host.reportStatus.mockRejectedValue(new Error('redis down'));
		await expect(f.endpoint.exec(report, user, null, null)).rejects.toThrow('redis down');
	});

	test('rejects a missing or replaced participant session', async () => {
		const f = fixture();
		f.local.reportStatus.mockResolvedValue(false);
		await expect(f.endpoint.exec(report, user, null, null)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
	});

	// 断ると決められなかった (読めなかった) 報告を ACCESS_DENIED にすると、クライアントは送り直さず設定が古いまま残る
	test('does not turn an unexpected failure of the local report into ACCESS_DENIED', async () => {
		const f = fixture();
		f.local.reportStatus.mockRejectedValue(new Error('database down'));
		await expect(f.endpoint.exec(report, user, null, null)).rejects.toThrow('database down');
	});

	test('exposes reported settings to room members who are not in the call', async () => {
		const f = createFixture();
		f.liveKitService.listParticipants.mockResolvedValue([{
			identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false, micMuted: true, deafened: false,
		}]);
		try {
			await f.service.refresh('r1');
			expect(await f.service.getStates({ id: 'm1' }, ['r1'])).toMatchObject([{
				participants: [{ identity: 'https://local.test/users/u1', micMuted: true, deafened: false }],
			}]);
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', expect.objectContaining({
				participants: [expect.objectContaining({ micMuted: true, deafened: false })],
			}));
		} finally {
			f.service.onApplicationShutdown();
		}
	});

	test('service checks admission before storing reports and schedules a coalesced refresh', async () => {
		const f = createFixture();
		const me = KNOWN_USERS.find(u => u.id === 'u1')!;
		const setStatus = vi.fn().mockResolvedValue(true);
		Object.assign(f.liveKitService, { setParticipantStatus: setStatus });
		Object.assign(f.usersRepository, { findOneBy: vi.fn().mockResolvedValue(KNOWN_USERS.find(u => u.id === 'owner')) });
		const scheduleRefresh = vi.spyOn(f.service, 'scheduleRefresh').mockImplementation(() => {});
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();
		try {
			await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', report)).resolves.toBe(true);
			expect(setStatus).toHaveBeenCalledWith('r1', 'https://local.test/users/u1', 'PA_1', report);
			expect(scheduleRefresh).toHaveBeenCalledWith('r1');
			expect(refresh).not.toHaveBeenCalled();
			setStatus.mockClear();
			f.nonMembers.add('u1');
			await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', report)).resolves.toBe(false);
			expect(setStatus).not.toHaveBeenCalled();
			expect(scheduleRefresh).toHaveBeenCalledTimes(1);
		} finally {
			f.service.onApplicationShutdown();
		}
	});

	describe('service', () => {
		function serviceFixture() {
			const f = createFixture();
			const me = KNOWN_USERS.find(u => u.id === 'u1')!;
			const setStatus = vi.fn().mockResolvedValue(true);
			Object.assign(f.liveKitService, { setParticipantStatus: setStatus });
			const findOwner = vi.fn().mockResolvedValue(KNOWN_USERS.find(u => u.id === 'owner'));
			Object.assign(f.usersRepository, { findOneBy: findOwner });
			const scheduleRefresh = vi.spyOn(f.service, 'scheduleRefresh').mockImplementation(() => {});
			return { ...f, me, setStatus, findOwner, scheduleRefresh };
		}

		test('rejects a report for an archived room', async () => {
			const f = serviceFixture();
			f.chatRoomsRepository.findOneBy.mockResolvedValueOnce({ id: 'r1', ownerId: 'owner', isArchived: true } as any);
			try {
				await expect(f.service.reportStatus(f.me as any, 'r1', 'PA_1', report)).resolves.toBe(false);
				expect(f.setStatus).not.toHaveBeenCalled();
			} finally {
				f.service.onApplicationShutdown();
			}
		});

		// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーの LiveKit にあるので、このサーバーでは受け付けない
		test('rejects a report for a room owned by another server', async () => {
			const f = serviceFixture();
			f.findOwner.mockResolvedValue(KNOWN_USERS.find(u => u.id === 'remoteOwner'));
			try {
				await expect(f.service.reportStatus(f.me as any, 'r1', 'PA_1', report)).resolves.toBe(false);
				expect(f.setStatus).not.toHaveBeenCalled();
			} finally {
				f.service.onApplicationShutdown();
			}
		});

		test('rejects a report from a session that is no longer connected without refreshing', async () => {
			const f = serviceFixture();
			f.setStatus.mockResolvedValue(false);
			try {
				await expect(f.service.reportStatus(f.me as any, 'r1', 'PA_old', report)).resolves.toBe(false);
				expect(f.scheduleRefresh).not.toHaveBeenCalled();
			} finally {
				f.service.onApplicationShutdown();
			}
		});

		// 断った (false) と答えるとクライアントは送り直さないので、一時的に読めなかっただけなら内部エラーにして送り直させる
		test.each([
			['the room', (f: ReturnType<typeof serviceFixture>) => f.chatRoomsRepository.findOneBy.mockRejectedValueOnce(new Error('database down'))],
			['the role policies', (f: ReturnType<typeof serviceFixture>) => f.roleService.getUserPolicies.mockRejectedValueOnce(new Error('redis down'))],
			['the memberships', (f: ReturnType<typeof serviceFixture>) => f.chatRoomMembershipsRepository.findBy.mockRejectedValueOnce(new Error('database down'))],
		] as const)('fails instead of rejecting when %s cannot be read', async (_label, breakRead) => {
			const f = serviceFixture();
			breakRead(f);
			try {
				await expect(f.service.reportStatus(f.me as any, 'r1', 'PA_1', report)).rejects.toBeInstanceOf(AggregateError);
				expect(f.setStatus).not.toHaveBeenCalled();
			} finally {
				f.service.onApplicationShutdown();
			}
		});

		// 読めたものだけで断れても、読めないものがあるときは同じく内部エラーにする (読めないときにルームがあるかで答えを変えない)
		test('fails instead of rejecting a nonmember while something else cannot be read', async () => {
			const f = serviceFixture();
			f.nonMembers.add('u1');
			f.roleService.getUserPolicies.mockRejectedValueOnce(new Error('redis down'));
			try {
				await expect(f.service.reportStatus(f.me as any, 'r1', 'PA_1', report)).rejects.toBeInstanceOf(AggregateError);
			} finally {
				f.service.onApplicationShutdown();
			}
		});
	});
});
