/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';

type Scope = 'everyone' | 'followers' | 'following' | 'mutual' | 'none';

function fixture(options: { scope?: Scope; availability?: string; suspended?: boolean; blocked?: boolean; following?: boolean; followedBy?: boolean; approved?: boolean; senderHost?: string | null } = {}) {
	const message = {
		id: 'm1', fromUserId: 'u1', toUserId: 'u2', toRoomId: null,
		fileIds: [] as string[], text: 'old', editedAt: null as Date | null, deletedAt: null as Date | null,
		reactions: [], emojis: [] as string[], dice: null,
	};
	const senderHost = options.senderHost ?? null;
	const users = new Map<string, Record<string, unknown>>([
		['u1', { id: 'u1', host: senderHost, uri: senderHost ? 'https://remote.test/users/u1' : null, inbox: null }],
		['u2', { id: 'u2', host: null, uri: null, inbox: null, chatScope: options.scope ?? 'everyone', isSuspended: options.suspended ?? false }],
	]);
	const chatMessagesRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => id === message.id ? message : null),
		update: vi.fn(async (_where: unknown, patch: Partial<typeof message>) => { Object.assign(message, patch); return { affected: 1 }; }),
	};
	const approvals = options.approved ? [{ userId: 'u2', otherId: 'u1' }] : [];
	const approvalQuery = { where: () => approvalQuery, andWhere: () => approvalQuery, orWhere: () => approvalQuery, take: () => approvalQuery, getMany: async () => approvals };
	const publishChatUserStream = vi.fn();
	const service = Object.assign(Object.create(ChatService.prototype), {
		chatMessagesRepository,
		chatRoomsRepository: { findOneBy: vi.fn() },
		chatApprovalsRepository: { createQueryBuilder: () => approvalQuery },
		driveFilesRepository: { countBy: vi.fn(async () => 0) },
		usersRepository: {
			findOneBy: vi.fn(async ({ id }: { id: string }) => users.get(id) ?? null),
			findOneByOrFail: vi.fn(async ({ id }: { id: string }) => users.get(id)),
			findBy: vi.fn(async ({ id }: { id: { value: string[] } }) => id.value.map(value => users.get(value)).filter(Boolean)),
		},
		roleService: { getUserPolicies: vi.fn(async () => ({ chatAvailability: options.availability ?? 'available' })) },
		userFollowingService: {
			isFollowing: vi.fn(async (follower: string) => follower === 'u1' ? (options.followedBy ?? false) : (options.following ?? false)),
			isMutual: vi.fn(async () => (options.followedBy ?? false) && (options.following ?? false)),
		},
		userBlockingService: { checkBlocked: vi.fn(async () => options.blocked ?? false) },
		globalEventService: { publishChatUserStream },
		queueService: { deliver: vi.fn() },
		apRendererService: { renderChatUpdate: vi.fn().mockReturnValue({ type: 'Update' }), addContext: vi.fn((activity: unknown) => activity) },
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null, isRemoteUser: (user: { host: string | null }) => user.host != null },
		customEmojiService: { populateEmojis: vi.fn(async () => ({})) },
	}) as ChatService;
	return { service, message, chatMessagesRepository, publishChatUserStream, sender: users.get('u1') as never };
}

describe('1:1 쪽지 수정은 새 쪽지를 보낼 때와 같은 수신 확인을 거친다', () => {
	test('받는 사람이 허용 범위를 좁히면 예전 쪽지를 고칠 수 없다', async () => {
		const f = fixture({ scope: 'none' });

		await expect(f.service.updateMessage('u1', 'm1', 'edited')).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(f.chatMessagesRepository.update).not.toHaveBeenCalled();
		expect(f.publishChatUserStream).not.toHaveBeenCalled();
	});

	test.each([
		['followers', { followedBy: false }],
		['following', { following: false }],
		['mutual', { followedBy: true, following: false }],
	] as const)('허용 범위 %s 밖이면 고칠 수 없다', async (scope, extra) => {
		const f = fixture({ scope, ...extra });

		await expect(f.service.updateMessage('u1', 'm1', 'edited')).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(f.chatMessagesRepository.update).not.toHaveBeenCalled();
	});

	test('받는 사람이 읽기 전용이 되었거나 정지되면 고칠 수 없다', async () => {
		for (const extra of [{ availability: 'readonly' }, { availability: 'unavailable' }, { suspended: true }]) {
			const f = fixture(extra);
			await expect(f.service.updateMessage('u1', 'm1', 'edited')).rejects.toBeInstanceOf(ChatMessageAccessError);
			expect(f.chatMessagesRepository.update).not.toHaveBeenCalled();
		}
	});

	test('차단되면 고칠 수 없다', async () => {
		const f = fixture({ blocked: true });

		await expect(f.service.updateMessage('u1', 'm1', 'edited')).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(f.chatMessagesRepository.update).not.toHaveBeenCalled();
	});

	test.each([
		['everyone', {}],
		['followers', { followedBy: true }],
		['following', { following: true }],
		['mutual', { followedBy: true, following: true }],
		['none', { approved: true }],
	] as const)('허용 범위 %s 안이면 수정 전처럼 고친다', async (scope, extra) => {
		const f = fixture({ scope, ...extra });

		const updated = await f.service.updateMessage('u1', 'm1', ' edited ');

		expect(updated.text).toBe('edited');
		expect(f.chatMessagesRepository.update).toHaveBeenCalledTimes(1);
		expect(f.publishChatUserStream).toHaveBeenCalledWith('u1', 'u2', 'updated', expect.objectContaining({ text: 'edited' }));
	});

	test('받는 사람 계정이 없으면 고칠 수 없다', async () => {
		const f = fixture();
		(f.service as never as { usersRepository: { findOneBy: ReturnType<typeof vi.fn> } }).usersRepository.findOneBy.mockResolvedValue(null);

		await expect(f.service.updateMessage('u1', 'm1', 'edited')).rejects.toBeInstanceOf(ChatMessageAccessError);
	});

	test('원격에서 온 수정도 같은 기준을 따른다', async () => {
		const denied = fixture({ scope: 'none', senderHost: 'remote.test' });
		await expect(denied.service.updateRemoteMessage(denied.sender, denied.message as never, 'edited', new Date())).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(denied.chatMessagesRepository.update).not.toHaveBeenCalled();

		const allowed = fixture({ scope: 'followers', followedBy: true, senderHost: 'remote.test' });
		const updated = await allowed.service.updateRemoteMessage(allowed.sender, allowed.message as never, 'edited', new Date());
		expect(updated.text).toBe('edited');
		expect(allowed.chatMessagesRepository.update).toHaveBeenCalledTimes(1);
	});
});
