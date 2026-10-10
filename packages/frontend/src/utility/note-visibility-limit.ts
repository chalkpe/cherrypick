/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities, noteVisibilities } from 'cherrypick-js';

type Visibility = typeof noteVisibilities[number];
export type NoteVisibilityLimit = entities.MeDetailed['noteVisibilityLimit'];

export function getNoteVisibilityLockReason(visibility: Visibility, limit: NoteVisibilityLimit, isSilenced: boolean, isReplyVisibilitySpecified = false): 'role' | 'personal' | 'reply' | null {
	if (visibility === 'public' && isSilenced) return 'role';
	if ((visibility === 'public' && limit !== 'none') || (visibility === 'home' && limit === 'followers')) return 'personal';
	if (visibility !== 'specified' && isReplyVisibilitySpecified) return 'reply';
	return null;
}

export function clampNoteVisibility(visibility: Visibility, limit: NoteVisibilityLimit, isSilenced: boolean): Visibility {
	if ((visibility === 'public' || visibility === 'home') && limit === 'followers') return 'followers';
	if (visibility === 'public' && (isSilenced || limit === 'home')) return 'home';
	return visibility;
}

export function nextNoteVisibility(visibility: Visibility, limit: NoteVisibilityLimit, isSilenced: boolean, isReplyVisibilitySpecified = false): Visibility {
	const allowed = (['public', 'home', 'followers', 'specified'] as const).filter(v => getNoteVisibilityLockReason(v, limit, isSilenced, isReplyVisibilitySpecified) === null);
	return allowed[(allowed.indexOf(visibility) + 1) % allowed.length];
}
