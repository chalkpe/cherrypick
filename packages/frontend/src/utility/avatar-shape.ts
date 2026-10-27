/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Misskey from 'cherrypick-js';
import { prefer } from '@/preferences.js';

/**
 * そのユーザーのアバターを角丸の四角 (丸み 20%) で描くかどうかを返す。MkAvatar はこれで形を決める。
 * アバターを包む枠の角の丸みを、中のアバターの形に合わせるのにも使う
 */
export function isSquareAvatar(user: Pick<Misskey.entities.UserLite, 'setFederationAvatarShape' | 'isSquareAvatars'>): boolean {
	// 相手が選んだ形に合わせる設定で、相手も形を選んでいるときだけ相手の形を使う
	if (prefer.s.setFederationAvatarShape && user.setFederationAvatarShape) return user.isSquareAvatars === true;
	return prefer.s.squareAvatars === true;
}
