/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiDriveFile } from '@/models/DriveFile.js';

export function avatarFileError(file: Pick<MiDriveFile, 'userId' | 'type' | 'isSensitive'> | null, userId: string): 'noSuchAvatar' | 'avatarNotAnImage' | 'avatarIsSensitive' | null {
	if (file == null || file.userId !== userId) return 'noSuchAvatar';
	if (!file.type.startsWith('image/')) return 'avatarNotAnImage';
	if (file.isSensitive) return 'avatarIsSensitive';
	return null;
}
