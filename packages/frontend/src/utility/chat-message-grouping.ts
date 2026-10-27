/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 同じ送信者のメッセージをひとまとまりにする間隔の上限 (ちょうどこの時間までは含む)
export const CHAT_MESSAGE_GROUPING_INTERVAL = 17 * 60 * 1000;

export type ChatMessageGroupPosition = {
	// まとまりの最初のメッセージか (アバターと名前、吹き出しの尻尾を出す)
	first: boolean;
	// まとまりの最後のメッセージか (メニューボタンと時刻を出す)
	last: boolean;
};

type GroupableTimelineItem = {
	type: 'item';
	data: { fromUserId: string; createdAt: string; };
} | {
	type: 'date';
};

function continuesGroup(prev: GroupableTimelineItem | undefined, next: GroupableTimelineItem | undefined): boolean {
	// 日付の区切りをまたいではまとめない
	if (prev?.type !== 'item' || next?.type !== 'item') return false;
	if (prev.data.fromUserId !== next.data.fromUserId) return false;
	return Date.parse(next.data.createdAt) - Date.parse(prev.data.createdAt) <= CHAT_MESSAGE_GROUPING_INTERVAL;
}

/**
 * 表示順 (古い順) に並んだタイムラインの各メッセージについて、まとまりの中での位置を返す。
 * 返り値は items と同じ並びで、日付の区切りの位置には null が入る。
 */
export function getChatMessageGroupPositions(items: readonly GroupableTimelineItem[]): (ChatMessageGroupPosition | null)[] {
	return items.map((item, i) => {
		if (item.type !== 'item') return null;
		return {
			first: !continuesGroup(items[i - 1], item),
			last: !continuesGroup(item, items[i + 1]),
		};
	});
}
