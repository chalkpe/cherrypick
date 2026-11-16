/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive } from 'vue';
import * as Misskey from 'cherrypick-js';
import type { SummalyResult } from '@misskey-dev/summaly';
import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';
import { globalEvents } from '@/events.js';

// 서버가 초대 주소로 확인한 링크에만 /url 응답에 붙는다. /url은 API가 아니라서 SDK에 이 타입이 없다
type ChatInviteIcon = {
	iconUrl: string;
	iconBlurhash: string | null;
	iconDecorations: Misskey.entities.UserLite['avatarDecorations'];
};

export type ChatInviteSummary = ChatInviteIcon & {
	url: string;
	host: string;
	code: string;
	name: string;
	description: string;
	membersCount: number;
	isLocal: boolean;
};

export type SummalyResultWithChatInvite = SummalyResult & { chatInvite?: unknown };

type JoinStatusResponse = Misskey.Endpoints['chat/invite-link/join-status']['res'];
type JoinResultEvent = Parameters<Misskey.Channels['main']['events']['chatInviteJoinResult']>[0];

export type ChatInviteJoinState = {
	// 아직 서버에 묻지 않았으면 null
	status: JoinStatusResponse['status'] | null;
	roomId: string | null;
	reason: JoinStatusResponse['reason'];
	joining: boolean;
	// 참여 성공 뒤 서버가 알려준 최신 인원 수. 아직 없으면 null(캐시된 카드 값을 그대로 표시)
	membersCount: number | null;
	// 이 화면에서 참여 요청을 보내 막 멤버가 됐으면 true. 이미 멤버인 카드와 구분해 인원 수를 갱신할 때 쓴다
	joinedHere: boolean;
};

export type ChatInviteJoinOutcome =
	| { kind: 'ignored' }
	| { kind: 'joined'; roomId: string }
	| { kind: 'pending' }
	| { kind: 'failed'; error: unknown };

export function hasChatInviteIcon(value: unknown): value is ChatInviteIcon {
	if (value == null || typeof value !== 'object') return false;
	const icon = value as Partial<ChatInviteIcon>;
	return typeof icon.iconUrl === 'string' && icon.iconUrl.length > 0
		&& (icon.iconBlurhash === null || typeof icon.iconBlurhash === 'string')
		&& Array.isArray(icon.iconDecorations)
		&& icon.iconDecorations.every(decoration => decoration != null && typeof decoration === 'object'
			&& typeof decoration.id === 'string' && typeof decoration.url === 'string');
}

// 공개 미리보기에는 그룹장 계정이나 그룹 ID가 없다. URL은 아이콘의 표시용 식별자일 뿐 이동에 쓰지 않는다
export function chatInviteAvatar(invite: ChatInviteIcon & { name: string }, inviteUrl: string, ownerHost: string | null) {
	return {
		id: inviteUrl, name: invite.name, iconUrl: invite.iconUrl,
		iconBlurhash: invite.iconBlurhash, iconDecorations: invite.iconDecorations,
		owner: { host: ownerHost },
	};
}

// 모양이 맞지 않으면 초대 카드로 쓰지 않고 일반 링크 카드로 둔다
export function getChatInviteSummary(result: SummalyResultWithChatInvite | null): ChatInviteSummary | null {
	const invite = result?.chatInvite as Partial<ChatInviteSummary> | null | undefined;
	if (invite == null || typeof invite !== 'object') return null;
	if (typeof invite.url !== 'string' || typeof invite.host !== 'string' || typeof invite.code !== 'string') return null;
	if (typeof invite.name !== 'string' || typeof invite.description !== 'string') return null;
	if (typeof invite.membersCount !== 'number' || typeof invite.isLocal !== 'boolean') return null;
	if (!hasChatInviteIcon(invite)) return null;
	return invite as ChatInviteSummary;
}

type Entry = {
	accountId: string;
	url: string;
	state: ChatInviteJoinState;
	// 마지막으로 반영한 답의 순서
	applied: number;
	checking: boolean;
};

// 같은 계정의 같은 초대 주소는 카드가 여러 장이어도 상태 하나를 함께 쓴다
const entries = new Map<string, Entry>();
let sequence = 0;

function entryOf(accountId: string, url: string): Entry {
	const key = `${accountId}\n${url}`;
	let entry = entries.get(key);
	if (entry == null) {
		entry = { accountId, url, state: reactive({ status: null, roomId: null, reason: null, joining: false, membersCount: null, joinedHere: false }), applied: 0, checking: false };
		entries.set(key, entry);
	}
	return entry;
}

// 요청은 보낸 순서, 스트림 결과는 도착한 순서로 줄을 세워 더 늦은 것만 반영한다.
// 늦게 도착한 오래된 답이 그 뒤의 결과를 덮지 않게 한다
function apply(entry: Entry, order: number, next: Pick<ChatInviteJoinState, 'status' | 'roomId' | 'reason'> & { membersCount?: number | null }) {
	if (order <= entry.applied) return;
	entry.applied = order;
	const joinedNow = next.status === 'joined' && entry.state.status !== 'joined';
	if (joinedNow && (entry.state.joining || entry.state.status === 'pending')) entry.state.joinedHere = true;
	entry.state.status = next.status;
	entry.state.roomId = next.roomId;
	entry.state.reason = next.reason;
	// 참여 상태에서 벗어나면 이전 참여의 인원 수 갱신 상태를 비운다. 다음 참여가 새 값을 한 번 받게 한다
	if (next.status !== 'joined') {
		entry.state.joinedHere = false;
		entry.state.membersCount = null;
	}
	// 인원 수는 최신 답이 숫자로 실어 왔을 때만 바꾼다. 요청하지 않은 조회나 참여 결과 이벤트처럼 없는 답은 기존 값을 유지한다
	if (next.membersCount != null) entry.state.membersCount = next.membersCount;
	// 링크로 참여하면 남아 있던 개별 초대도 정리된다. 다른 참여 경로처럼 초대 알림에 알린다
	if (joinedNow && next.roomId != null) globalEvents.emit('chatRoomInvitationHandled', next.roomId, 'joined');
}

/**
 * 지금 로그인한 계정의 참여 상태. 로그인하지 않았으면 null
 */
export function chatInviteJoinState(url: string): ChatInviteJoinState | null {
	if ($i == null) return null;
	return entryOf($i.id, url).state;
}

/**
 * 참여 결과를 서버에 다시 묻는다. 새로고침 뒤나 스트림을 놓쳤을 때 쓴다. 부작용이 없는 조회다
 */
export function refreshChatInviteJoinStatus(url: string, options: { withMembersCount?: boolean } = {}): Promise<void> {
	if ($i == null) return Promise.resolve();
	const accountId = $i.id;
	const entry = entryOf(accountId, url);
	// 참여 요청의 답이 더 새로운 판정이다. 그동안에는 따로 묻지 않는다
	if (entry.state.joining || entry.checking) return Promise.resolve();

	const order = ++sequence;
	entry.checking = true;
	return misskeyApi('chat/invite-link/join-status', options.withMembersCount ? { url, withMembersCount: true } : { url }).then(res => {
		// 그사이 계정이 바뀌었으면 다른 사람의 상태다
		if ($i?.id !== accountId) return;
		apply(entry, order, { status: res.status, roomId: res.roomId, reason: res.reason, membersCount: res.membersCount });
	}, () => {
		// 다음에 카드가 붙거나 스트림이 다시 연결될 때 다시 묻는다
	}).finally(() => {
		entry.checking = false;
	});
}

const MEMBERS_COUNT_RETRIES = 4;
const MEMBERS_COUNT_RETRY_INTERVAL_MS = 1500;

/**
 * 참여한 직후 카드의 인원 수를 발급 서버의 최신 값으로 갱신한다.
 * 다른 서버의 그룹은 이쪽 참여가 확정된 뒤 발급 서버가 멤버로 올리므로, 카드의 값보다 늘 때까지 잠시 간격을 두고 다시 묻는다
 */
export async function refreshChatInviteMembersCount(url: string, shownCount: number): Promise<void> {
	if ($i == null) return;
	const accountId = $i.id;
	for (let attempt = 0; attempt < MEMBERS_COUNT_RETRIES; attempt++) {
		await refreshChatInviteJoinStatus(url, { withMembersCount: true });
		if ($i?.id !== accountId) return;
		const count = entryOf(accountId, url).state.membersCount;
		if (count != null && count > shownCount) return;
		await new Promise(resolve => window.setTimeout(resolve, MEMBERS_COUNT_RETRY_INTERVAL_MS));
	}
}

/**
 * 초대 링크로 참여한다. 같은 계정·주소의 요청이 이미 나가 있으면 새로 보내지 않는다.
 * 캐시된 카드는 옛 정보일 수 있으므로 가입 여부는 서버의 답만 따른다
 */
export async function joinChatInvite(url: string): Promise<ChatInviteJoinOutcome> {
	if ($i == null) return { kind: 'ignored' };
	const accountId = $i.id;
	const entry = entryOf(accountId, url);
	if (entry.state.joining) return { kind: 'ignored' };

	const order = ++sequence;
	entry.state.joining = true;
	try {
		const res = await misskeyApi('chat/invite-link/join', { url });
		if ($i?.id !== accountId) return { kind: 'ignored' };
		if (res.status === 'joined' && res.roomId != null) {
			apply(entry, order, { status: 'joined', roomId: res.roomId, reason: null });
			return { kind: 'joined', roomId: res.roomId };
		}
		apply(entry, order, { status: 'pending', roomId: null, reason: null });
		return { kind: 'pending' };
	} catch (error) {
		if ($i?.id !== accountId) return { kind: 'ignored' };
		return { kind: 'failed', error };
	} finally {
		entry.state.joining = false;
	}
}

function onJoinResult(payload: JoinResultEvent) {
	if ($i == null) return;
	apply(entryOf($i.id, payload.url), ++sequence, { status: payload.status, roomId: payload.roomId, reason: payload.reason });
}

// 끊긴 동안 온 결과는 스트림으로 다시 오지 않는다. 기다리던 참여만 다시 묻는다
function onReconnected() {
	if ($i == null) return;
	for (const entry of entries.values()) {
		if (entry.accountId === $i.id && entry.state.status === 'pending') refreshChatInviteJoinStatus(entry.url);
	}
}

let subscribers = 0;
let connection: Misskey.IChannelConnection<Misskey.Channels['main']> | null = null;

/**
 * 다른 서버 그룹의 참여 결과를 받는다. 보이는 카드가 하나도 없으면 구독을 놓는다
 * @returns 구독을 놓는 함수
 */
export function subscribeChatInviteJoinResults(): () => void {
	const stream = useStream();
	if (subscribers++ === 0) {
		connection = stream.useChannel('main');
		connection.on('chatInviteJoinResult', onJoinResult);
		stream.on('_connected_', onReconnected);
	}

	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--subscribers > 0) return;
		connection?.dispose();
		connection = null;
		stream.off('_connected_', onReconnected);
	};
}
