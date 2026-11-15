/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 받은 글이 쓴 시각으로 인정받는 범위. 전달이 늦어져도 이 기간 안에는 도착한다고 본다. */
export const CHAT_RECEIVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 연합으로 받은 글의 정렬 시각. 상대가 보낸 쓴 시각을 도착 시각 이전 7일 안으로 제한해
 * 비정상적으로 먼 과거의 값이 대화 순서·페이지 나눔을 깨지 못하게 한다.
 * 쓴 시각이 없거나 도착 시각보다 미래이면 도착 시각을 쓴다.
 */
export function chatReceivedTime(published: Date | null | undefined, now: number): number {
	if (published == null) return now;
	const time = published.getTime();
	if (!Number.isFinite(time)) return now;
	return Math.min(now, Math.max(now - CHAT_RECEIVED_MAX_AGE_MS, time));
}
