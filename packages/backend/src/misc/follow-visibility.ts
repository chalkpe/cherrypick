/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiUserProfile } from '@/models/UserProfile.js';

export function canViewFollowCount(
	visibility: MiUserProfile['followingVisibility'] | MiUserProfile['followersVisibility'],
	viewer: { isOwnerOrModerator: boolean; isFollowing: boolean },
): boolean {
	return visibility === 'public' || viewer.isOwnerOrModerator || (visibility === 'followers' && viewer.isFollowing);
}
