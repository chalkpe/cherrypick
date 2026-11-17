/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { UsedUsernamesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { DI } from '@/di-symbols.js';
import { EmailService } from '@/core/EmailService.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:decline-user',

	errors: {
		notApprovalSignup: {
			message: 'User did not sign up through approval.',
			code: 'NOT_APPROVAL_SIGNUP',
			id: '3c5a9a2e-6f0b-4d2c-8a41-7b1e6d9f2c10',
			httpStatusCode: 400,
		},
		targetIsModerator: {
			message: 'User is a moderator.',
			code: 'TARGET_IS_MODERATOR',
			id: 'b82d4e57-1a93-4c6f-9e08-5d7a3f1c4b26',
			httpStatusCode: 400,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.usedUsernamesRepository)
		private usedUsernamesRepository: UsedUsernamesRepository,

		private moderationLogService: ModerationLogService,
		private emailService: EmailService,
		private deleteAccountService: DeleteAccountService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const user = await this.usersRepository.findOneBy({ id: ps.userId });

			if (user == null || user.isDeleted) {
				throw new Error('user not found or already deleted');
			}

			if (user.approved) {
				throw new Error('user is already approved');
			}

			if (user.host) {
				throw new Error('user is not local');
			}

			// 가입 승인 흐름으로 들어온 계정(signupReason이 채워져 있음)만 거부할 수 있다
			if (user.signupReason == null) {
				throw new ApiError(meta.errors.notApprovalSignup);
			}

			if (await this.roleService.isModerator(user)) {
				throw new ApiError(meta.errors.targetIsModerator);
			}

			const profile = await this.userProfilesRepository.findOneBy({ userId: ps.userId });

			if (profile?.email) {
				this.emailService.sendEmail(profile.email, 'Account Declined / 登録承認されていない / 가입 거부됨',
					'Your Account has been declined.. / アカウントが拒否されました… / 가입 요청한 계정이 거부되었어요..',
					'Your Account has been declined.. / アカウントが拒否されました… / 가입 요청한 계정이 거부되었어요..');
			}

			await this.usedUsernamesRepository.delete({ username: user.username.toLowerCase() });

			await this.deleteAccountService.deleteAccount(user);

			this.moderationLogService.log(me, 'decline', {
				userId: user.id,
				userUsername: user.username,
				userHost: user.host,
			});
		});
	}
}
