/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { getJsonSchema } from '@/core/chart/core.js';
import PerUserFollowingChart from '@/core/chart/charts/per-user-following.js';
import { schema } from '@/core/chart/charts/entities/per-user-following.js';
import { DI } from '@/di-symbols.js';
import type { FollowingsRepository, MiMeta, UserProfilesRepository } from '@/models/_.js';
import { RoleService } from '@/core/RoleService.js';
import { canViewFollowCount } from '@/misc/follow-visibility.js';
import { canViewUserProfile } from '@/misc/user-profile-visibility.js';

export const meta = {
	tags: ['charts', 'users', 'following'],

	res: getJsonSchema(schema),

	allowGet: true,
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		span: { type: 'string', enum: ['day', 'hour'] },
		limit: { type: 'integer', minimum: 1, maximum: 500, default: 30 },
		offset: { type: 'integer', nullable: true, default: null },
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['span', 'userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private roleService: RoleService,
		private perUserFollowingChart: PerUserFollowingChart,
	) {
		super(meta, paramDef, async (ps, me) => {
			const profile = await this.userProfilesRepository.findOne({
				where: { userId: ps.userId },
				relations: { user: true },
				select: { userId: true, followingVisibility: true, followersVisibility: true, user: { id: true, host: true, isSuspended: true } },
			});
			const isModerator = await this.roleService.isModerator(me);
			const showProfile = profile?.user != null
				&& canViewUserProfile(profile.user, { signedIn: me != null, isModerator }, this.serverSettings.ugcVisibilityForVisitor);
			const isOwnerOrModerator = me?.id === ps.userId || isModerator;
			const needsRelation = showProfile && (profile.followingVisibility === 'followers' || profile.followersVisibility === 'followers');
			const isFollowing = !isOwnerOrModerator && needsRelation && me != null
				&& await this.followingsRepository.existsBy({ followerId: me.id, followeeId: ps.userId });
			const viewer = { isOwnerOrModerator, isFollowing };
			const showFollowing = showProfile && canViewFollowCount(profile.followingVisibility, viewer);
			const showFollowers = showProfile && canViewFollowCount(profile.followersVisibility, viewer);
			const chart = showFollowing || showFollowers
				? await this.perUserFollowingChart.getChart(ps.span, ps.limit, ps.offset ? new Date(ps.offset) : null, ps.userId)
				: null;
			const hidden = { total: [], inc: [], dec: [] };

			return {
				local: {
					followings: showFollowing && chart != null ? chart.local.followings : hidden,
					followers: showFollowers && chart != null ? chart.local.followers : hidden,
				},
				remote: {
					followings: showFollowing && chart != null ? chart.remote.followings : hidden,
					followers: showFollowers && chart != null ? chart.remote.followers : hidden,
				},
			};
		});
	}
}
