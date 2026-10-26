/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { IObject } from '../type.js';

// ルームの URI のパス (ルームを持つサーバーが送る `${url}/chat/rooms/${id}` と同じ形)
const ROOM_PATH = /^\/chat\/rooms\/([a-zA-Z0-9]+)$/;

/** 他のサーバーから届いた通話の参加者の現況 (ChatRoomVoiceState) のうち、確かめた中身 */
export type ParsedChatRoomVoiceState = {
	/** room の URI に含まれるルームの id */
	roomId: string;
	/** identity は参加者のユーザーの URI */
	participants: { identity: string; screenSharing: boolean }[];
	/** ホストの時刻 (ミリ秒) */
	updatedAt: number;
};

/** parseChatRoomVoiceState の結果。受け付けないときは inbox のログに残す理由を返す */
export type ChatRoomVoiceStateParseResult =
	| { ok: true; state: ParsedChatRoomVoiceState }
	| { ok: false; reason: string };

/** ルームの URI から、その通話の参加者の現況 (ChatRoomVoiceState) の id を作る。送るときも受け取るときもこの形 */
export function chatRoomVoiceStateIdOf(roomUri: string): string {
	return `${roomUri}/voice`;
}

/**
 * 他のサーバーのルームの持ち主 (actorUri) から届いた ChatRoomVoiceState の形を確かめる。
 * - id と room が文字列で、どちらも送り主と同じサーバー (スキーム・ホスト・ポート) のもの
 * - room が `${origin}/chat/rooms/${id}` の形 (クエリ・フラグメント・認証情報を含まない) で、id がちょうど `${room}/voice`
 * - participants が maxParticipants 人以下で、それぞれ文字列の id と真偽値の screenSharing を持つ
 * - updated が時刻として読める
 * ルームがこのサーバーのミラーで、送り主がその持ち主かどうかは DB を読む側 (ChatVoiceService) が確かめる
 */
export function parseChatRoomVoiceState(actorUri: string, object: IObject, maxParticipants: number): ChatRoomVoiceStateParseResult {
	const state = object as IObject & { room?: unknown; participants?: unknown };
	if (typeof state.id !== 'string' || typeof state.room !== 'string') return refuse('invalid voice state');

	const origin = originOf(actorUri);
	if (origin == null || originOf(state.id) !== origin || originOf(state.room) !== origin) {
		return refuse('voice state is not on the sender\'s server');
	}

	const roomId = roomIdOfUri(state.room);
	if (roomId == null) return refuse('invalid room URI');
	if (state.id !== chatRoomVoiceStateIdOf(state.room)) return refuse('voice state id does not belong to the room');

	const participants = parseParticipants(state.participants, maxParticipants);
	if (participants == null) return refuse('invalid participants');

	const updatedAt = typeof state.updated === 'string' ? Date.parse(state.updated) : NaN;
	if (!Number.isFinite(updatedAt)) return refuse('invalid updated');

	return { ok: true, state: { roomId, participants, updatedAt } };
}

function refuse(reason: string): ChatRoomVoiceStateParseResult {
	return { ok: false, reason };
}

/**
 * URL の出所 (スキーム・ホスト・ポート)。http(s) の URL でなければ null。
 * ホストの比較に UtilityService.extractDbHost を使うと、ポート付きのホストはすべて '' になって区別できない
 */
function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
	} catch {
		return null;
	}
}

/**
 * `${origin}/chat/rooms/${id}` の形のルーム URI から id を取り出す。クエリ・フラグメント・認証情報の付いたものは受け付けない。
 * 空のクエリ (`?`) とフラグメント (`#`) は URL として読むと消えるので、文字列のまま確かめる
 */
function roomIdOfUri(uri: string): string | null {
	if (uri.includes('?') || uri.includes('#')) return null;
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}
	if (url.username !== '' || url.password !== '') return null;
	return ROOM_PATH.exec(url.pathname)?.[1] ?? null;
}

/** ChatRoomVoiceState の participants を確かめる。形が違うか、maxParticipants 人より多ければ null */
function parseParticipants(value: unknown, maxParticipants: number): { identity: string; screenSharing: boolean }[] | null {
	if (!Array.isArray(value) || value.length > maxParticipants) return null;

	const parsed: { identity: string; screenSharing: boolean }[] = [];
	for (const participant of value as unknown[]) {
		if (typeof participant !== 'object' || participant == null) return null;
		const { id, screenSharing } = participant as Record<string, unknown>;
		if (typeof id !== 'string' || typeof screenSharing !== 'boolean') return null;
		parsed.push({ identity: id, screenSharing });
	}
	return parsed;
}
