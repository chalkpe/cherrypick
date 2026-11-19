/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';

export const accountReauthenticationLimit = {
	key: 'account-reauthentication',
	duration: ms('1hour'),
	max: 10,
} as const;
