/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/vue';
import { i18n } from '@/i18n.js';
import XRoom from '@/pages/chat/XRoom.vue';

const stubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkAvatar: { props: ['user'], template: '<span class="avatar" :data-user="user.id"></span>' },
};

const room = { id: 'r1', name: 'room 1', description: '', owner: { id: 'owner', username: 'owner' } } as any;
const participant = (id: string) => ({ identity: `https://local.test/users/${id}`, user: { id, username: id }, screenSharing: false }) as any;

afterEach(() => {
	cleanup();
});

describe('room list voice indicator', () => {
	test('shows up to three people in the call and how many more', () => {
		const { container } = render(XRoom, {
			props: { room, voiceState: { roomId: 'r1', participants: ['a', 'b', 'c', 'd'].map(participant) } },
			global: { stubs },
		});

		expect(screen.getByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 4 }))).toBeTruthy();
		const shown = [...container.querySelectorAll('[aria-label] .avatar')].map(el => el.getAttribute('data-user'));
		expect(shown).toEqual(['a', 'b', 'c']);
		expect(screen.getByText('+1')).toBeTruthy();
	});

	test('shows nothing when no one is in the call', () => {
		render(XRoom, { props: { room }, global: { stubs } });

		expect(screen.queryByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 0 }))).toBeNull();
		expect(screen.queryByText('+1')).toBeNull();
	});
});
