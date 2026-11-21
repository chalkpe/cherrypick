/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 그룹 타임라인을 읽을 수 있는 사람. 방장, 멤버십이 있는 멤버, 관리자다.
 * 타임라인 읽기 권한(ChatService.hasPermissionToViewRoomTimeline)과 답장 원문 미리보기(ChatEntityService.loadReplyHints)가
 * 이 함수 하나를 함께 쓴다. 읽기 조건을 바꿀 때는 여기만 고친다.
 */
export function canReadRoomTimeline(room: { id: string; ownerId: string }, userId: string, memberRoomIds: ReadonlySet<string>, isModerator: boolean): boolean {
	return isModerator || room.ownerId === userId || memberRoomIds.has(room.id);
}
