/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Misskey from 'cherrypick-js';
import { miLocalStorage } from '@/local-storage.js';

export type ChatChannel = Misskey.entities.ChatRoomChannel;
export type ChatChannelSection = Misskey.entities.ChatRoomChannelSection;

export type SectionGroup = {
	section: ChatChannelSection;
	channels: ChatChannel[];
};

export type ChannelArrangement = {
	ungrouped: ChatChannel[];
	sectionGroups: SectionGroup[];
};

// 화면 순서는 섹션 없는 채널 먼저, 그다음 섹션 순서대로다. 채널 position이 늘 이 순서로 매겨져 온다.
export function groupChannelsBySection(channels: readonly ChatChannel[], sections: readonly ChatChannelSection[]): ChannelArrangement {
	return {
		ungrouped: channels.filter(channel => channel.sectionId == null),
		sectionGroups: sections.map(section => ({ section, channels: channels.filter(channel => channel.sectionId === section.id) })),
	};
}

export type FoldedSectionDisplay = {
	visibleChannels: ChatChannel[];
	hiddenUnread: boolean;
	hiddenNotification: boolean;
};

// 접힌 섹션은 머리글만 남기되 지금 보고 있는 채널은 머리글 아래에 남긴다.
// 숨은 채널의 미읽음은 채널 점과 같은 규칙이다: 알림 대상이 있으면 깜빡이고 나머지는 정적이다.
export function foldedSectionDisplay(channels: readonly ChatChannel[], currentChannelId: string | null | undefined, unreadChannelIds: readonly string[], notificationChannelIds: readonly string[]): FoldedSectionDisplay {
	const hidden = channels.filter(channel => channel.id !== currentChannelId);
	return {
		visibleChannels: currentChannelId == null ? [] : channels.filter(channel => channel.id === currentChannelId),
		hiddenUnread: hidden.some(channel => unreadChannelIds.includes(channel.id)),
		hiddenNotification: hidden.some(channel => notificationChannelIds.includes(channel.id)),
	};
}

// 접힘 상태는 사람마다, 기기마다 저장한다. MkFoldableSection과 같은 ui:folder: 키 방식을 쓴다.
export function sectionFoldKey(accountId: string, sectionId: string): `ui:folder:${string}` {
	return `ui:folder:chat-section:${accountId}:${sectionId}`;
}

export function isSectionExpanded(accountId: string, sectionId: string): boolean {
	return miLocalStorage.getItem(sectionFoldKey(accountId, sectionId)) !== 'f';
}

export function saveSectionExpanded(accountId: string, sectionId: string, expanded: boolean): void {
	miLocalStorage.setItem(sectionFoldKey(accountId, sectionId), expanded ? 't' : 'f');
}

export function arrangePayload(roomId: string, arrangement: ChannelArrangement): Misskey.Endpoints['chat/rooms/channels/arrange']['req'] {
	return {
		roomId,
		ungrouped: arrangement.ungrouped.map(channel => channel.id),
		sections: arrangement.sectionGroups.map(group => ({ sectionId: group.section.id, channelIds: group.channels.map(channel => channel.id) })),
	};
}

export function flattenArrangement(arrangement: ChannelArrangement): ChatChannel[] {
	return [...arrangement.ungrouped, ...arrangement.sectionGroups.flatMap(group => group.channels)];
}
