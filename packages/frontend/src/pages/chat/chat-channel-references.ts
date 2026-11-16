/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as mfm from 'mfc-js';
import type { ChatRoomChannel } from 'cherrypick-js/entities.js';

export type ChatChannelRef = { channelId: string; start: number; length: number };

export function channelListPath(roomId: string): string {
	return `/chat/room/${encodeURIComponent(roomId)}/channels`;
}

export function channelConversationPath(roomId: string, channelId: string): string {
	return `${channelListPath(roomId)}/${encodeURIComponent(channelId)}`;
}

// DOM의 selectionStart와 서버의 참조 범위는 모두 UTF-16 단위다.
export function rebaseChannelRefs(before: string, after: string, refs: readonly ChatChannelRef[], edit?: { start: number; end: number }): ChatChannelRef[] {
	if (before === after) return refs.map(ref => ({ ...ref }));
	let start = edit?.start ?? 0;
	let end = edit?.end ?? before.length;
	if (edit == null) {
		while (start < before.length && start < after.length && before[start] === after[start]) start++;
		while (end > start && after.length - (before.length - end) > start && before[end - 1] === after[after.length - (before.length - end) - 1]) end--;
	}
	const delta = after.length - before.length;
	return refs.flatMap(ref => {
		if (ref.start + ref.length <= start) return [{ ...ref }];
		if (ref.start >= end) return [{ ...ref, start: ref.start + delta }];
		return [];
	});
}

export function channelReferenceNodes(text: string, refs: readonly ChatChannelRef[], channels: readonly ChatRoomChannel[] | null, roomId: string, deletedLabel: string, baseUrl?: string): mfm.MfmNode[] {
	let prefix = 'CHERRYCHANNELREFERENCE';
	while (text.includes(prefix)) prefix += 'X';
	const replacements = new Map<string, mfm.MfmNode>();
	let source = '';
	let end = 0;
	for (const ref of refs) {
		if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.length) || ref.start < end || ref.length < 2 || ref.start + ref.length > text.length || text[ref.start] !== '#') continue;
		const token = `${prefix}${replacements.size}END`;
		const channel = channels?.find(channel => channel.id === ref.channelId && channel.roomId === roomId);
		const label: mfm.MfmText = { type: 'text', props: { text: channel ? `#${channel.name}` : channels == null ? text.slice(ref.start, ref.start + ref.length) : deletedLabel } };
		replacements.set(token, channel ? { type: 'link', props: { url: baseUrl ? new URL(channelConversationPath(roomId, channel.id), baseUrl).href : channelConversationPath(roomId, channel.id), silent: false }, children: [label] } : label);
		source += text.slice(end, ref.start) + token;
		end = ref.start + ref.length;
	}
	source += text.slice(end);
	const pattern = new RegExp(`(${prefix}\\d+END)`, 'g');
	const transform = (nodes: mfm.MfmNode[]): mfm.MfmNode[] => nodes.flatMap<mfm.MfmNode>(node => {
		if (node.type === 'hashtag') return [{ type: 'text', props: { text: `#${node.props.hashtag}` } }];
		if (Object.values('props' in node ? node.props ?? {} : {}).some(value => typeof value === 'string' && value.includes(prefix))) {
			return mfm.toString(node).split(pattern).filter(Boolean).map<mfm.MfmNode>(part => replacements.get(part) ?? { type: 'text', props: { text: part } });
		}
		if (node.type === 'text') return node.props.text.split(pattern).filter(Boolean).map<mfm.MfmNode>(part => replacements.get(part) ?? { type: 'text', props: { text: part } });
		if (node.children) return [{ ...node, children: transform(node.children) } as mfm.MfmNode];
		return [node];
	});
	return transform(mfm.parse(source));
}
