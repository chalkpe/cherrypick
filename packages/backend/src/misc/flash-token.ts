/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiUser } from '@/models/User.js';

export type FlashToken = {
	permissions: string[];
	userId: MiUser['id'];
};
