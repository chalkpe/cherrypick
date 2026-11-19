/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiMeta } from '@/models/Meta.js';
import type { MiUser } from '@/models/User.js';

export function canViewUserProfile(
	target: Pick<MiUser, 'host' | 'isSuspended'>,
	viewer: { signedIn: boolean; isModerator: boolean },
	visitorVisibility: MiMeta['ugcVisibilityForVisitor'],
): boolean {
	return (!target.isSuspended || viewer.isModerator)
		&& (viewer.signedIn || visitorVisibility !== 'local' || target.host == null);
}
