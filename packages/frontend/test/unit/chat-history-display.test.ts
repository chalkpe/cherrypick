/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';

const mocks = vi.hoisted(() => ({
	me: { id: 'me', username: 'me', policies: { chatAvailability: 'available' } },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn().mockResolvedValue([]) }));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn(), contextMenu: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show: vi.fn() } }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));

import XMessage from '@/pages/chat/XMessage.vue';
import { i18n } from '@/i18n.js';
import { getChatMessageGroupPositions } from '@/utility/chat-message-grouping.js';

const stubs = {
	MkAvatar: { props: ['user', 'link'], template: '<a data-testid="avatar" :data-link="String(link)" :data-user="user.id"></a>' },
	MkUserName: { props: ['user'], template: '<span data-testid="user-name">{{ user.username }}</span>' },
	MkA: true,
	MkTime: true,
	MkMediaList: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

function roomMessage(overrides: Record<string, unknown>) {
	return {
		id: 'm1', fromUserId: null, fromUser: null, archivedAuthor: null, unavailableFileCount: 0,
		toRoomId: 'room1', text: 'old message', createdAt: '2020-01-01T00:00:00.000Z', reactions: [], fileIds: [], files: [], emojis: {},
		...overrides,
	} as unknown as Misskey.entities.ChatMessageLiteForRoom;
}

function renderMessage(message: Misskey.entities.ChatMessageLiteForRoom) {
	return render(XMessage, { props: { message: message as never }, global: { stubs, directives: { tooltip: {} } } });
}

afterEach(() => {
	cleanup();
});

describe('계정이 없어진 작성자의 과거 기록', () => {
	test('소유 서버가 보관한 이름과 계정 주소를 글자로만 보이고 프로필로 연결하지 않는다', () => {
		const { container, getByText, queryByTestId } = renderMessage(roomMessage({ archivedAuthor: { name: '지난 이름', username: 'gone', host: 'member.example' } }));

		expect(getByText('지난 이름')).toBeTruthy();
		expect(getByText('@gone@member.example')).toBeTruthy();
		expect(queryByTestId('avatar')).toBeNull();
		expect(container.querySelector('a[href]')).toBeNull();
	});

	test('이 서버의 계정이었으면 서버 없이 계정 이름을 보인다', () => {
		const { getByText } = renderMessage(roomMessage({ archivedAuthor: { name: null, username: 'local-gone', host: null } }));

		expect(getByText('local-gone')).toBeTruthy();
		expect(getByText('@local-gone')).toBeTruthy();
	});

	test('작성자 정보도 없으면 알 수 없는 사용자로 보인다', () => {
		const { getByText } = renderMessage(roomMessage({}));

		expect(getByText(i18n.ts._chat.unknownUser)).toBeTruthy();
	});

	test('계정이 있으면 지금처럼 아바타로 프로필에 연결한다', () => {
		const { getByTestId } = renderMessage(roomMessage({ fromUserId: 'alice', fromUser: { id: 'alice', username: 'alice', host: null } }));

		expect(getByTestId('avatar').getAttribute('data-link')).toBe('true');
	});

	test('받을 수 없었던 첨부가 있으면 글은 보이고 첨부 자리에 더 가져올 수 없다고 알린다', () => {
		const { getByText } = renderMessage(roomMessage({ fromUserId: 'alice', fromUser: { id: 'alice', username: 'alice', host: null }, unavailableFileCount: 2 }));

		expect(getByText('old message')).toBeTruthy();
		expect(getByText(i18n.ts._chat.cannotFetchMoreHistory, { exact: false })).toBeTruthy();
		expect(i18n.ts._chat.cannotFetchMoreHistory).toBeTypeOf('string');
	});

	test('계정이 없어진 작성자의 글은 글마다 작성자를 보이도록 묶지 않는다', () => {
		const item = (id: string, fromUserId: string | null) => ({ type: 'item' as const, data: { id, fromUserId, createdAt: '2020-01-01T00:00:00.000Z' } });

		const positions = getChatMessageGroupPositions([item('a', null), item('b', null), item('c', 'alice'), item('d', 'alice')]);

		expect(positions.map(position => position?.first)).toEqual([true, true, true, false]);
	});
});
