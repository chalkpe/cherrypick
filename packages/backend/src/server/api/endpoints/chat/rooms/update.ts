/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { ChatService, ChatRoomArchivedError } from '@/core/ChatService.js';
import { ApiError } from '@/server/api/error.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import type { DriveFilesRepository, MiChatRoom } from '@/models/_.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { RoleService } from '@/core/RoleService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { avatarDecorationsSchema, normalizeAvatarDecoration, usableAvatarDecorationIds } from '@/core/avatar-decoration.js';
import { avatarFileError } from '@/core/avatar-file.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1hour'),
		max: 30,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'ChatRoom',
	},

	errors: {
		noSuchAvatar: { message: 'No such avatar file.', code: 'NO_SUCH_AVATAR', id: 'b334628c-fdf3-461f-91a7-8317b8f9e552' },
		avatarNotAnImage: { message: 'The file specified as an avatar is not an image.', code: 'AVATAR_NOT_AN_IMAGE', id: '7ce861bf-3302-4007-a7e1-f70134f927c2' },
		avatarIsSensitive: { message: 'The file specified as an avatar is marked as sensitive.', code: 'AVATAR_IS_SENSITIVE', id: 'cf67aeac-f60f-44ac-b08b-040befbc4e84' },
		restrictedByRole: { message: 'This action is restricted by your role.', code: 'RESTRICTED_BY_ROLE', id: 'eb1c651a-cc8f-4fa5-8d7d-e0e7bd3c2faa' },
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'fcdb0f92-bda6-47f9-bd05-343e0e020932',
		},
		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: '8655493b-6d45-4466-95ec-c8c38ddae472',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		name: { type: 'string', maxLength: 256 },
		description: { type: 'string', maxLength: 1024 },
		isArchived: { type: 'boolean' },
		iconId: { type: 'string', format: 'misskey:id', nullable: true },
		iconDecorations: avatarDecorationsSchema,
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatEntityService: ChatEntityService,
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,
		private driveFileEntityService: DriveFileEntityService,
		private roleService: RoleService,
		private avatarDecorationService: AvatarDecorationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			const room = await this.chatService.findMyRoomById(me.id, ps.roomId);
			if (room == null) {
				throw new ApiError(meta.errors.noSuchRoom);
			}
			if (room.isArchived && (ps.iconId !== undefined || ps.iconDecorations !== undefined)) throw new ApiError(meta.errors.roomIsArchived);
			const icon: Partial<Pick<MiChatRoom, 'iconId' | 'iconUrl' | 'iconBlurhash' | 'iconDecorations'>> = {};
			if (ps.iconId) {
				if (!(await this.roleService.getUserPolicies(me.id)).canUpdateBioMedia) throw new ApiError(meta.errors.restrictedByRole);
				const file = await this.driveFilesRepository.findOneBy({ id: ps.iconId });
				const error = avatarFileError(file, me.id);
				if (error != null) throw new ApiError(meta.errors[error]);
				if (file == null) throw new ApiError(meta.errors.noSuchAvatar);
				Object.assign(icon, { iconId: file.id, iconUrl: this.driveFileEntityService.getPublicUrl(file, 'avatar'), iconBlurhash: file.blurhash });
			} else if (ps.iconId === null) {
				Object.assign(icon, { iconId: null, iconUrl: null, iconBlurhash: null });
			}
			if (ps.iconDecorations !== undefined) {
				const policies = await this.roleService.getUserPolicies(me.id);
				if (ps.iconDecorations.length > policies.avatarDecorationLimit) throw new ApiError(meta.errors.restrictedByRole);
				const decorations = await this.avatarDecorationService.getAll(true);
				const roles = await this.roleService.getUserRoles(me.id);
				const allRoles = await this.roleService.getRoles();
				const allowed = usableAvatarDecorationIds(decorations, roles, allRoles);
				icon.iconDecorations = ps.iconDecorations.filter(d => allowed.includes(d.id)).map(normalizeAvatarDecoration);
			}

			// アーカイブ中は読み取り専用。同じリクエストで解除するなら変更できる
			if (room.isArchived && ps.isArchived !== false && (ps.name !== undefined || ps.description !== undefined)) {
				throw new ApiError(meta.errors.roomIsArchived);
			}

			const updated = await this.chatService.updateRoom(room, {
				name: ps.name,
				description: ps.description,
				isArchived: ps.isArchived,
				...icon,
			}).catch(err => {
				if (err instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				throw err;
			});

			return this.chatEntityService.packRoom(updated, me);
		});
	}
}
