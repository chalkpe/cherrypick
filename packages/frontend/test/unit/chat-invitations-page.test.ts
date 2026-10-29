/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/vue';

const invitation = vi.hoisted(() => ({
	id: 'i1',
	createdAt: '2026-10-27T13:14:35.725Z',
	roomId: 'room1',
	room: {
		id: 'room1',
		name: 'room 1',
		description: '',
		ownerId: 'owner',
		owner: { id: 'owner', username: 'owner', host: null },
	},
	userId: 'me',
}));

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(async () => [invitation]),
}));
vi.mock('@/router.js', () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/os.js', () => ({
	apiWithDialog: vi.fn(async () => ({})),
}));

import XInvitations from '@/pages/chat/home.invitations.vue';

const stubs = {
	MkFolder: { template: '<div><slot name="icon"/><slot name="label"/><slot name="suffix"/><slot name="footer"/><slot/></div>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\', $event)"><slot/></button>' },
	MkAvatar: true,
	MkUserName: true,
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
	MkResult: true,
	MkLoading: true,
};

afterEach(cleanup);

test('offers only join and reject actions for an invitation', async () => {
	render(XInvitations, { global: { stubs } });

	await screen.findByText('room 1');

	expect(screen.getAllByRole('button')).toHaveLength(2);
});
