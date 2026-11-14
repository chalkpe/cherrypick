/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import * as mfm from 'mfc-js';
import { channelConversationPath, channelListPath, rebaseChannelRefs, channelReferenceNodes } from '@/pages/chat/chat-channel-references.js';

describe('selected channel references', () => {
	test('uses UTF-16 ranges and preserves the selected ID when text is inserted before it', () => {
		const before = '😀 #same #same';
		const refs = [{ channelId: 'second', start: 9, length: 5 }];

		expect(rebaseChannelRefs(before, '😀 hello #same #same', refs)).toEqual([{ channelId: 'second', start: 15, length: 5 }]);
		expect(rebaseChannelRefs(before, '😀 #same #changed', refs)).toEqual([]);
	});

	test('does not connect typed names and retains more than sixteen selections', () => {
		expect(rebaseChannelRefs('#same', '#same more', [])).toEqual([]);
		const before = Array.from({ length: 20 }, () => '#x').join(' ');
		const refs = Array.from({ length: 20 }, (_, i) => ({ channelId: `id${i}`, start: i * 3, length: 2 }));

		expect(rebaseChannelRefs(before, before, refs)).toEqual(refs);
	});

	test('keeps a selection after an explicit edit adjacent to an identical name', () => {
		const refs = [{ channelId: 'first', start: 0, length: 2 }];

		expect(rebaseChannelRefs('#x #x', '#x #x #x', refs, { start: 0, end: 0 })).toEqual([{ channelId: 'first', start: 3, length: 2 }]);
	});

	test('renders the current name as plain text inside surrounding MFM and tombstones deleted IDs', () => {
		const refs = [{ channelId: 'live', start: 2, length: 4 }, { channelId: 'gone', start: 7, length: 5 }];
		const nodes = channelReferenceNodes('**#old #gone**', refs, [{ id: 'live', roomId: 'r', name: '[new](https://evil.test)', isLegacy: false }], 'r', 'Deleted channel');

		expect(nodes[0].type).toBe('bold');
		const children = (nodes[0] as mfm.MfmBold).children;
		expect(children[0]).toEqual({ type: 'link', props: { url: '/chat/room/r/channels/live', silent: false }, children: [{ type: 'text', props: { text: '#[new](https://evil.test)' } }] });
		expect(JSON.stringify(nodes)).toContain('Deleted channel');
		expect(JSON.stringify(nodes)).not.toContain('/channels/gone');
	});

	test('keeps unselected names plain and renders selected references inside code without placeholder text', () => {
		const plain = channelReferenceNodes('#typed', [], [], 'r', 'Deleted');
		expect(plain).toEqual([{ type: 'text', props: { text: '#typed' } }]);

		const code = channelReferenceNodes('`#x`', [{ channelId: 'c', start: 1, length: 2 }], [{ id: 'c', roomId: 'r', name: 'Renamed', isLegacy: false }], 'r', 'Deleted');
		expect(JSON.stringify(code)).not.toContain('CHERRYCHANNELREFERENCE');
		expect(JSON.stringify(code)).toContain('/channels/c');
	});

	test('keeps the stored label while the current channel list is still loading', () => {
		const nodes = channelReferenceNodes('😀 #old', [{ channelId: 'c', start: 3, length: 4 }], null, 'r', 'Deleted');

		expect(JSON.stringify(nodes)).toContain('#old');
		expect(JSON.stringify(nodes)).not.toContain('Deleted');
	});

	test('builds stable channel and list addresses', () => {
		expect(channelListPath('r')).toBe('/chat/room/r/channels');
		expect(channelConversationPath('r', 'c')).toBe('/chat/room/r/channels/c');
	});
});
