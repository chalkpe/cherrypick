/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { ChatRoomsRepository, MiChatRoom, UsersRepository } from '@/models/_.js';
import { ChatService } from '@/core/ChatService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { truncate } from '@/misc/truncate.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { parseRemoteChatDate } from './misc/chat-remote-date.js';
import { getApId } from './type.js';
import type { IObject } from './type.js';
import { ApImageService } from './models/ApImageService.js';

type IconUpdate = Partial<Pick<MiChatRoom, 'iconId' | 'iconUrl' | 'iconBlurhash' | 'iconDecorations'>>;

@Injectable()
export class ApChatRoomStateService {
	constructor(
		@Inject(DI.redis) private redisClient: Redis.Redis,
		@Inject(DI.chatRoomsRepository) private chatRoomsRepository: ChatRoomsRepository,
		@Inject(DI.usersRepository) private usersRepository: UsersRepository,
		private chatService: ChatService,
		private roleService: RoleService,
		private userEntityService: UserEntityService,
		private apImageService: ApImageService,
		private driveFileEntityService: DriveFileEntityService,
		private avatarDecorationService: AvatarDecorationService,
	) {}

	// 호출자는 소유자의 활동 또는 그룹 호스트에서 서명 조회한 응답임을 먼저 확인한다.
	public async apply(room: MiChatRoom, object: IObject): Promise<MiChatRoom> {
		const updatedAt = parseRemoteChatDate(object.updated) ?? undefined;
		const olderThan = (current: MiChatRoom) => updatedAt != null && current.lastRemoteUpdatedAt != null && updatedAt < current.lastRemoteUpdatedAt;
		if (olderThan(room)) return room;
		const icon = await this.resolveIcon(room, object);
		const apply = (current: MiChatRoom) => this.chatService.updateRoom(current, {
			name: typeof object.name === 'string' ? truncate(object.name, 256) : current.name,
			description: typeof object.summary === 'string' ? truncate(object.summary, 2048) : current.description,
			isArchived: typeof object._misskey_chatArchived === 'boolean' ? object._misskey_chatArchived : current.isArchived,
			...icon,
		}, { federate: false, remoteUpdatedAt: updatedAt, remoteGroup: object });
		if (!Object.hasOwn(object, 'icon') && !Object.hasOwn(object, '_misskey_chatIconDecorations')) return apply(room);

		// 이미지 다운로드는 잠금 밖에서 한다. 장식 카탈로그는 최신 revision을 확인한 뒤에만 바꾼다.
		const unlock = await acquireApObjectLock(this.redisClient, getApId(object));
		try {
			const current = await this.chatRoomsRepository.findOneBy({ id: room.id });
			if (current == null || current.ownerId !== room.ownerId) return room;
			if (olderThan(current)) return current;
			if (Object.hasOwn(object, '_misskey_chatIconDecorations')) {
				const owner = await this.usersRepository.findOneByOrFail({ id: current.ownerId });
				if (this.userEntityService.isRemoteUser(owner)) {
					const decorations = await this.avatarDecorationService.resolveChatDecorations(owner.host, object._misskey_chatIconDecorations);
					if (decorations !== undefined) icon.iconDecorations = decorations;
				}
			}
			return await apply(current);
		} finally {
			await unlock();
		}
	}

	private async resolveIcon(room: MiChatRoom, object: IObject): Promise<IconUpdate> {
		if (!Object.hasOwn(object, 'icon')) return {};
		const owner = await this.usersRepository.findOneByOrFail({ id: room.ownerId });
		if (!this.userEntityService.isRemoteUser(owner)) return {};
		let icon = object.icon;
		if (Array.isArray(icon)) icon = icon.find(item => item && typeof item === 'object' && item.url) ?? null;
		if (icon == null || (typeof icon === 'object' && icon.url == null)) return { iconId: null, iconUrl: null, iconBlurhash: null };
		if (!(await this.roleService.getUserPolicies(owner.id)).canUpdateBioMedia) return {};
		const file = await this.apImageService.findStoredImage(owner, icon) ?? await this.apImageService.resolveImage(owner, icon).catch(() => null);
		return file != null && file.type.startsWith('image/') ? { iconId: file.id, iconUrl: this.driveFileEntityService.getPublicUrl(file, 'avatar'), iconBlurhash: file.blurhash } : {};
	}
}
