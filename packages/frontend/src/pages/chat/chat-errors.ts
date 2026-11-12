/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ApiWithDialogCustomErrors } from '@/os.js';
import { i18n } from '@/i18n.js';

// API のエラー文は英語のままなので、そのまま画面に出さない
export function chatErrorText(err: unknown): string {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	switch (code) {
		case 'DICE_INVALID': return i18n.ts._chat.diceInvalid;
		case 'DICE_LIMIT': return i18n.ts._chat.diceLimit;
		case 'DICE_BUSY': return i18n.ts._chat.diceBusy;
		case 'NO_SUCH_MESSAGE': return i18n.ts._chat.messageUnavailable;
		case 'NO_SUCH_ROOM': return i18n.ts._chat.roomUnavailable;
		case 'ROOM_IS_ARCHIVED': return i18n.ts._chat.thisRoomIsArchived;
		case 'NO_SUCH_USER':
		case 'RECIPIENT_IS_YOURSELF':
		case 'RECIPIENT_IS_SUSPENDED':
		case 'YOU_HAVE_BEEN_BLOCKED':
		case 'CANNOT_CHAT_WITH_USER':
			return i18n.ts._chat.cannotChatWithUser;
		case 'RATE_LIMIT_EXCEEDED': return i18n.ts.cannotPerformTemporaryDescription;
		default: return i18n.ts._chat.actionFailed;
	}
}

// どのエラーにも当たらないときや通信に失敗したときも、英語をそのまま出さない
const fallback: ApiWithDialogCustomErrors = {
	default: { text: i18n.ts._chat.actionFailed },
};

// 招待に応じたときに返るエラー。os.apiWithDialog はエラー ID で文言を差し替える
export const chatJoinErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'84416476-5ce8-4a2c-b568-9569f1b10733': { text: i18n.ts._chat.roomUnavailable },
	'c60a4f18-d3b2-4e75-9c06-7a1e58d3f2b9': { text: i18n.ts._chat.thisRoomIsArchived },
	'56d5a1da-4d30-4f7d-a931-f62e746533f9': { text: i18n.ts._chat.roomIsFull },
};

// 招待を送ったときに返るエラー
export const chatInviteErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'916f9507-49ba-4e90-b57f-1fd4deaa47a5': { text: i18n.ts._chat.roomUnavailable },
	'b41cd32a-8b2a-4662-ae54-bc5cbb057afa': { text: i18n.ts._chat.thisRoomIsArchived },
	'579fc80c-985c-45d1-b7f2-8022083dfa40': { text: i18n.ts._chat.roomIsFull },
	'88605621-e640-4d2d-a96d-168b598f0c67': { text: i18n.ts._chat.cannotInviteUser },
	'167a1ccf-d9ab-415e-941d-d08f28b2ca07': { text: i18n.ts._chat.cannotInviteUser },
	'c2789971-48e2-41ac-b4f4-1304696987f7': { text: i18n.ts._chat.cannotInviteUser },
	'a10a39b2-9ecb-4c77-8827-028bc550f977': { text: i18n.ts._chat.alreadyMember },
	'20ec0050-1c71-4cd9-b246-67772af61bbf': { text: i18n.ts._chat.alreadyInvited },
	'a3fc0535-5d74-4106-8b78-3f6ee467baca': { text: i18n.ts._chat.cannotInviteUser },
	'9f802721-ad05-411c-806a-e9367ab1facf': { text: i18n.ts._chat.cannotInviteUser },
};

// 招待が断られた理由を、相手ごとに読める文にする
export function chatInviteErrorText(err: unknown): string {
	const { id, code } = (err ?? {}) as { id?: string; code?: string };
	if (code === 'RATE_LIMIT_EXCEEDED') return i18n.ts.cannotPerformTemporaryDescription;
	if (code === 'ROLE_PERMISSION_DENIED') return i18n.ts.permissionDeniedErrorDescription;
	return (id != null ? chatInviteErrors[id]?.text : null) ?? i18n.ts._chat.actionFailed;
}

export const chatLeaveErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'cb7f3179-50e8-4389-8c30-dbe2650a67c9': { text: i18n.ts._chat.roomUnavailable },
};

export const chatKickErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'932260a0-ccf0-4caf-87be-3e9cccd12c2f': { text: i18n.ts._chat.roomUnavailable },
	'b4c87e54-c36a-40f4-99c7-b72032c48482': { text: i18n.ts._chat.memberAlreadyGone },
};

export const chatRoomUpdateErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'fcdb0f92-bda6-47f9-bd05-343e0e020932': { text: i18n.ts._chat.roomUnavailable },
	'8655493b-6d45-4466-95ec-c8c38ddae472': { text: i18n.ts._chat.thisRoomIsArchived },
};

export const chatRoomDeleteErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'd4e3753d-97bf-4a19-ab8e-21080fbc0f4b': { text: i18n.ts._chat.roomUnavailable },
};

export const chatMuteErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'c2cde4eb-8d0f-42f1-8f2f-c4d6bfc8e5df': { text: i18n.ts._chat.roomUnavailable },
};

export const chatNotificationErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'ef41ee7c-5e74-48a0-8126-177a2afec201': { text: i18n.ts._chat.roomUnavailable },
	'ea728d98-6b11-494d-887e-fae0abeec404': { text: i18n.ts._chat.roomUnavailable },
};

export const chatCancelInvitationErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'8c8f38f0-3b7e-4f5e-9c6d-2e3f4a5b6c7d': { text: i18n.ts._chat.invitationGone },
};

export const chatRejectErrors: ApiWithDialogCustomErrors = {
	...fallback,
	'5130557e-5a11-4cfb-9cc5-fe60cda5de0d': { text: i18n.ts._chat.invitationGone },
};
