/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test } from 'vitest';
import { arrangePayload, flattenArrangement, foldedSectionDisplay, groupChannelsBySection, isSectionExpanded, saveSectionExpanded, sectionFoldKey } from '@/pages/chat/chat-channel-sections.js';

const channels = [
	{ id: 'c1', roomId: 'r', name: 'First', isLegacy: false, sectionId: null },
	{ id: 'c2', roomId: 'r', name: 'Second', isLegacy: false, sectionId: 's1' },
	{ id: 'c3', roomId: 'r', name: 'Third', isLegacy: false, sectionId: 's2' },
	{ id: 'c4', roomId: 'r', name: 'Fourth', isLegacy: false, sectionId: 's1' },
];
const sections = [{ id: 's1', roomId: 'r', name: '운영' }, { id: 's2', roomId: 'r', name: '행사' }];

afterEach(() => window.localStorage.clear());

test('groups channels with ungrouped first and keeps the display order inside each section', () => {
	const { ungrouped, sectionGroups } = groupChannelsBySection(channels, sections);
	expect(ungrouped.map(channel => channel.id)).toEqual(['c1']);
	expect(sectionGroups.map(group => group.section.id)).toEqual(['s1', 's2']);
	expect(sectionGroups[0].channels.map(channel => channel.id)).toEqual(['c2', 'c4']);
	expect(sectionGroups[1].channels.map(channel => channel.id)).toEqual(['c3']);
});

test('keeps empty sections and a flat list when there are no sections', () => {
	const empty = groupChannelsBySection(channels, [{ id: 's3', roomId: 'r', name: '빈 묶음' }]);
	expect(empty.sectionGroups[0].channels).toEqual([]);
	const flatChannels = channels.map(channel => ({ ...channel, sectionId: null }));
	const flat = groupChannelsBySection(flatChannels, []);
	expect(flat.ungrouped.map(channel => channel.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
	expect(flat.sectionGroups).toEqual([]);
});

test('folded sections keep only the current channel visible and report hidden unread state', () => {
	const sectionChannels = [channels[1], channels[3]];
	const withCurrent = foldedSectionDisplay(sectionChannels, 'c2', ['c2', 'c4'], ['c4']);
	expect(withCurrent.visibleChannels.map(channel => channel.id)).toEqual(['c2']);
	expect(withCurrent.hiddenUnread).toBe(true);
	expect(withCurrent.hiddenNotification).toBe(true);

	const withoutCurrent = foldedSectionDisplay(sectionChannels, 'c1', ['c2'], []);
	expect(withoutCurrent.visibleChannels).toEqual([]);
	expect(withoutCurrent.hiddenUnread).toBe(true);
	expect(withoutCurrent.hiddenNotification).toBe(false);

	const read = foldedSectionDisplay(sectionChannels, null, [], []);
	expect(read.visibleChannels).toEqual([]);
	expect(read.hiddenUnread).toBe(false);
	expect(read.hiddenNotification).toBe(false);
});

test('stores fold state per account and section with the folder key convention', () => {
	expect(sectionFoldKey('me', 's1')).toBe('ui:folder:chat-section:me:s1');
	expect(isSectionExpanded('me', 's1')).toBe(true);
	saveSectionExpanded('me', 's1', false);
	expect(window.localStorage.getItem('ui:folder:chat-section:me:s1')).toBe('f');
	expect(isSectionExpanded('me', 's1')).toBe(false);
	expect(isSectionExpanded('other', 's1')).toBe(true);
	expect(isSectionExpanded('me', 's2')).toBe(true);
	saveSectionExpanded('me', 's1', true);
	expect(window.localStorage.getItem('ui:folder:chat-section:me:s1')).toBe('t');
	expect(isSectionExpanded('me', 's1')).toBe(true);
});

test('builds one arrange payload covering every channel and section exactly once', () => {
	const { ungrouped, sectionGroups } = groupChannelsBySection(channels, sections);
	const payload = arrangePayload('r', { ungrouped, sectionGroups });
	expect(payload).toEqual({
		roomId: 'r',
		ungrouped: ['c1'],
		sections: [{ sectionId: 's1', channelIds: ['c2', 'c4'] }, { sectionId: 's2', channelIds: ['c3'] }],
	});
	expect(flattenArrangement({ ungrouped, sectionGroups }).map(channel => channel.id)).toEqual(['c1', 'c2', 'c4', 'c3']);
});
