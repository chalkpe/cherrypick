/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'cherrypick-js';
import { prefer } from '@/preferences.js';

export { acct, userPage } from '@@/js/user.js';

export const userName = (user: Misskey.entities.User) => {
	if (!prefer.s.nicknameEnabled) {
		return user.name ?? user.username;
	}
	return prefer.r.nicknameMap.value[user.id] || user.name || user.username;
};
