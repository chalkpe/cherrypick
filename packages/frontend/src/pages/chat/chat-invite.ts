/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'cherrypick-js';
import { acct, userName } from '@@/js/user.js';
import { chatInviteErrorText } from './chat-errors.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';

// ルームの人数の上限を超えないので、参加者はこれで全員読める。招待がこれより多いときは、送ったときにサーバーが断る
const LIST_LIMIT = 100;

// 招待しても断られる人と、その理由
export async function getUninvitableUsers(roomId: string): Promise<Record<string, string>> {
	try {
		const [members, invitations] = await Promise.all([
			misskeyApi('chat/rooms/members', { roomId, limit: LIST_LIMIT }),
			misskeyApi('chat/rooms/invitations/outbox', { roomId, limit: LIST_LIMIT }),
		]);
		return {
			...Object.fromEntries(invitations.map(invitation => [invitation.userId, i18n.ts._chat.alreadyInvited])),
			...Object.fromEntries(members.map(member => [member.userId, i18n.ts._chat.alreadyMember])),
		};
	} catch {
		// 読めなければ誰でも選べるままにする。選べない人はサーバーが断る
		return {};
	}
}

type InviteFailure = { user: Misskey.entities.UserLite; reason: string };

async function sendInvitations(roomId: string, invitees: Misskey.entities.UserLite[]): Promise<InviteFailure[]> {
	const failures: InviteFailure[] = [];
	let limitReason: string | null = null;
	for (const user of invitees) {
		// 回数の制限に当たったら、残りの人にも同じ答えが返る
		if (limitReason != null) {
			failures.push({ user, reason: limitReason });
			continue;
		}
		try {
			await misskeyApi('chat/rooms/invitations/create', { roomId, userId: user.id });
		} catch (err) {
			const reason = chatInviteErrorText(err);
			if ((err as { code?: string } | null)?.code === 'RATE_LIMIT_EXCEEDED') limitReason = reason;
			failures.push({ user, reason });
		}
	}
	return failures;
}

// ダイアログの本文は MFM なので、名前の装飾やメンションとして読まれないようにする
function describeUser(user: Misskey.entities.UserLite): string {
	const account = `@${acct(user)}`;
	return `<plain>${user.name ? `${userName(user)} (${account})` : account}</plain>`;
}

function describeFailures(failures: InviteFailure[]): string[] {
	const usersByReason = new Map<string, Misskey.entities.UserLite[]>();
	for (const { user, reason } of failures) usersByReason.set(reason, [...usersByReason.get(reason) ?? [], user]);
	return [...usersByReason].map(([reason, users]) => `${users.map(describeUser).join(', ')}: ${reason}`);
}

/**
 * 一人ずつ招待し、断られた人だけをまとめて一度知らせる。
 * os.apiWithDialog は要求ごとに窓を開くので使わない。資格情報は misskeyApi が付ける
 * @returns 招待できた人数
 */
export async function inviteUsersToRoom(roomId: string, invitees: Misskey.entities.UserLite[]): Promise<number> {
	if (invitees.length === 0) return 0;

	const failures = await os.promiseDialog(sendInvitations(roomId, invitees), () => {});
	const sent = invitees.length - failures.length;

	if (failures.length === 0) {
		os.success();
		return sent;
	}

	// 閉じるのを待たない。その間も、招待できた人は一覧に出ているようにする
	os.alert({
		type: sent > 0 ? 'warning' : 'error',
		title: i18n.tsx._chat.inviteFailedUsers({ n: failures.length }),
		text: [...(sent > 0 ? [i18n.tsx._chat.inviteSentUsers({ n: sent })] : []), ...describeFailures(failures)].join('\n'),
	});
	return sent;
}
