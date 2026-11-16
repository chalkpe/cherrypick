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
	const lists = Promise.all([
		misskeyApi('chat/rooms/members', { roomId, limit: LIST_LIMIT }),
		misskeyApi('chat/rooms/invitations/outbox', { roomId, limit: LIST_LIMIT }),
	]);
	// 내보낸 사람 목록을 못 읽어도 고를 수 있을 뿐이고, 보내면 서버가 사유와 함께 거절한다
	const bans = misskeyApi('chat/rooms/bans/list', { roomId, limit: LIST_LIMIT }).catch(() => []);
	try {
		const [members, invitations] = await lists;
		return {
			...Object.fromEntries((await bans).map(ban => [ban.userId, i18n.ts._chat.cannotInviteBannedUser])),
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
	let text = user.name ? `${userName(user)} (${account})` : account;
	// A name can contain the closing tag, including pieces that form it after a replacement.
	while (text.includes('</plain>')) text = text.replaceAll('</plain>', '');
	return `<plain>${text}</plain>`;
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
