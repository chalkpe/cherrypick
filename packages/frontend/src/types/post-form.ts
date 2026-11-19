/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Misskey from 'cherrypick-js';
import type { PollEditorModelValue } from '@/components/MkPollEditor.vue';
import type { DeleteScheduleEditorModelValue } from '@/components/MkScheduledNoteDelete.vue';
import type { DeliveryTargetEditorModelValue } from '@/components/MkDeliveryTargetEditor.vue';

export interface PostFormProps {
	reply?: Misskey.entities.Note | null;
	renote?: Misskey.entities.Note | null;
	channel?: {
		id: string;
		name: string;
		color: string;
		isSensitive: boolean;
		allowRenoteToExternal: boolean;
		userId: string | null;
	} | null;
	mention?: Misskey.entities.User;
	specified?: Misskey.entities.UserLite;
	initialText?: string;
	initialCw?: string;
	initialVisibility?: (typeof Misskey.noteVisibilities)[number];
	initialFiles?: Misskey.entities.DriveFile[];
	initialLocalOnly?: boolean;
	initialVisibleUsers?: Misskey.entities.UserLite[];
	initialNote?: Misskey.entities.Note;
	instant?: boolean;
	updateMode?: boolean;
}

export type StoredDrafts = {
	[key: string]: {
		updatedAt: string;
		data: {
			text: string;
			useCw: boolean;
			cw: string | null;
			disableRightClick?: boolean;
			saveToDraft?: boolean;
			event?: unknown;
			scheduledNoteDelete?: DeleteScheduleEditorModelValue | null;
			deliveryTargets?: DeliveryTargetEditorModelValue | null;
			visibility: 'public' | 'home' | 'followers' | 'specified';
			localOnly: boolean;
			files: Misskey.entities.DriveFile[];
			attachmentAccountId?: string;
			postAccountId?: string;
			poll: PollEditorModelValue | null;
			visibleUserIds?: string[];
			quoteId: string | null;
			reactionAcceptance: 'likeOnly' | 'likeOnlyForRemote' | 'nonSensitiveOnly' | 'nonSensitiveOnlyForLocalLikeOnlyForRemote' | null;
			scheduledAt: number | null;
		};
	};
};
