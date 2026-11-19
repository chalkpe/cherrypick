/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { AntennasRepository, UserGroupsRepository, UserGroupJoiningsRepository, UserGroupInvitationsRepository } from '@/models/_.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['groups'],

	requireCredential: true,

	kind: 'write:user-groups',

	description: 'Delete an existing group.',

	errors: {
		noSuchGroup: {
			message: 'No such group.',
			code: 'NO_SUCH_GROUP',
			id: '63dbd64c-cd77-413f-8e08-61781e210b38',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		groupId: { type: 'string', format: 'misskey:id' },
	},
	required: ['groupId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.userGroupsRepository)
		private userGroupsRepository: UserGroupsRepository,

		@Inject(DI.userGroupJoiningsRepository)
		private userGroupJoiningsRepository: UserGroupJoiningsRepository,

		@Inject(DI.userGroupInvitationsRepository)
		private userGroupInvitationsRepository: UserGroupInvitationsRepository,

		@Inject(DI.antennasRepository)
		private antennasRepository: AntennasRepository,

		private globalEventService: GlobalEventService,
		private notificationService: NotificationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const userGroup = await this.userGroupsRepository.findOneBy({
				id: ps.groupId,
				userId: me.id,
			});

			if (userGroup == null) {
				throw new ApiError(meta.errors.noSuchGroup);
			}

			// グループの削除で一緒に消える加入行・招待を、削除の前に控えておく
			const joinings = await this.userGroupJoiningsRepository.findBy({ userGroupId: userGroup.id });
			const antennas = joinings.length > 0 ? await this.antennasRepository.findBy({ userGroupJoiningId: In(joinings.map(x => x.id)) }) : [];
			const invitations = await this.userGroupInvitationsRepository.findBy({ userGroupId: userGroup.id });

			await this.userGroupsRepository.delete(userGroup.id);

			for (const antenna of antennas) {
				this.globalEventService.publishInternalEvent('antennaDeleted', antenna);
			}

			for (const invitation of invitations) {
				await this.notificationService.deleteUserGroupInvitation(invitation.userId, invitation.id);
			}
		});
	}
}
