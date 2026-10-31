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

/**
 * 読み上げやツールチップに使う名前。カスタム絵文字の :shortcode: はそのまま読まれても意味をなさないので除く。
 * 絵文字の区切りに使われるゼロ幅の文字も除き、名前が絵文字だけのときはユーザー名にする
 */
export const userNameForLabel = (user: Misskey.entities.User) => {
	return userName(user).replace(/:[\w+-]+(?:@[\w.-]+)?:/g, ' ').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim() || user.username;
};
