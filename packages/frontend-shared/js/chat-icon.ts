/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type ChatIconPreferences = {
	showAvatarDecorations: boolean;
	showRemoteAvatarDecorations: boolean;
	squareAvatars: boolean;
};

export const chatIconPreferencesKey = (userId: string): string => `chatIconPreferences:${userId}`;
