/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, MiChatRoom, UsersRepository } from '@/models/_.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { chatRoomUriForOwner } from '@/core/activitypub/misc/chat-payloads.js';
import { UserEntityService } from './UserEntityService.js';

@Injectable()
export class ChatRoomIconEntityService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.usersRepository) private usersRepository: UsersRepository,
		@Inject(DI.driveFilesRepository) private driveFilesRepository: DriveFilesRepository,
		private userEntityService: UserEntityService,
		private avatarDecorationService: AvatarDecorationService,
	) {}

	public getIdenticonUrl(roomUri: string): string {
		// 프로필과 같은 길이를 써서 서버 주소가 길어도 identicon 경로가 라우터 한도를 넘지 않게 한다.
		return this.userEntityService.getIdenticonUrl({ username: createHash('sha256').update(roomUri).digest('hex').slice(0, 20), host: new URL(roomUri).host });
	}

	/**
	 * @param ownerHint 이미 패킹한 소유자. 로컬 소유자이거나 그룹 URI가 있으면 기본 그림을 만들려고 소유자를 다시 읽지 않는다.
	 */
	public async pack(room: MiChatRoom, checkFile = false, ownerHint?: { host: string | null } | null) {
		const ownerKnown = room.owner != null || room.uri != null || (ownerHint != null && ownerHint.host == null);
		const owner = room.owner ?? (!ownerKnown && room.ownerId != null ? await this.usersRepository.findOneBy({ id: room.ownerId }) : null);
		let uri = chatRoomUriForOwner(room, owner, this.config.url);
		try {
			new URL(uri);
		} catch {
			uri = `${this.config.url}/chat/rooms/${room.id}`;
		}
		const present = room.iconId != null && (!checkFile || await this.driveFilesRepository.existsBy({ id: room.iconId }));
		return {
			iconId: present ? room.iconId : null,
			iconUrl: (present ? room.iconUrl : null) ?? this.getIdenticonUrl(uri),
			iconBlurhash: present ? room.iconBlurhash : null,
			iconDecorations: await this.avatarDecorationService.pack(room.iconDecorations ?? []),
		};
	}

	public async packDeletedRoom(info: Record<string, any>) {
		const room = info.room;
		if (room == null || typeof room !== 'object' || typeof room.id !== 'string' || typeof room.name !== 'string') return info;
		const icon = await this.pack(room, true);
		const owner = room.ownerId != null ? await this.usersRepository.findOneBy({ id: room.ownerId }) : null;
		let host = owner?.host ?? room.owner?.host ?? null;
		if (host == null && typeof room.uri === 'string') {
			try {
				const authority = new URL(room.uri).host;
				if (authority !== this.config.host) host = authority;
			} catch { /* 이전 기록에 유효한 URI가 없으면 로컬 기본 그림을 사용한다. */ }
		}
		return { ...info, room: { ...room, ...icon, owner: { host } } };
	}
}
