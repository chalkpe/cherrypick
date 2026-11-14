/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as mfm from 'mfm-js';

// 本物の os と misskeyApi を通し、サーバーへの要求の出口だけを差し替える。
// os や misskeyApi をモックすると、資格情報を消してしまう引数の渡し方を見逃す
const mocks = vi.hoisted(() => {
	const state = {
		me: { id: 'me', username: 'me', token: 'my-token', policies: {} },
		// 招待の相手ごとの答え。無ければ招待できる
		answers: new Map<string, () => Promise<Response>>(),
		lists: { members: '[]', outbox: '[]', bans: '[]' },
		requests: [] as { endpoint: string; body: Record<string, unknown> }[],
	};
	vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
		const endpoint = url.slice(url.indexOf('/api/') + '/api/'.length);
		const body = JSON.parse(init.body);
		state.requests.push({ endpoint, body });
		if (endpoint === 'chat/rooms/invitations/create') return (state.answers.get(body.userId) ?? (async () => new Response('{}', { status: 200 })))();
		if (endpoint === 'chat/rooms/members') return new Response(state.lists.members, { status: 200 });
		if (endpoint === 'chat/rooms/invitations/outbox') return new Response(state.lists.outbox, { status: 200 });
		if (endpoint === 'chat/rooms/bans/list') return new Response(state.lists.bans, { status: 200 });
		return new Response('[]', { status: 200 });
	}));
	return state;
});

vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));

import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { getUninvitableUsers, inviteUsersToRoom } from '@/pages/chat/chat-invite.js';

const sora = { id: 'sora', username: 'sora', host: 'remote.example', name: 'Sora' };
const haru = { id: 'haru', username: 'haru', host: null, name: 'Haru' };
const noName = { id: 'dami', username: 'dami', host: 'remote.example', name: null };
const people = [sora, haru, noName] as unknown as Parameters<typeof inviteUsersToRoom>[1];

const invitationRequests = () => mocks.requests.filter(request => request.endpoint === 'chat/rooms/invitations/create');

function refuses(error: { message: string; code: string; id: string }, status = 400) {
	return async () => new Response(JSON.stringify({ error }), { status });
}

const alreadyMember = { message: 'That user is already a member of this room.', code: 'ALREADY_MEMBER', id: 'a10a39b2-9ecb-4c77-8827-028bc550f977' };
const alreadyInvited = { message: 'That user has already been invited to this room.', code: 'ALREADY_INVITED', id: '20ec0050-1c71-4cd9-b246-67772af61bbf' };
const rateLimit = { message: 'Rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef' };
const banned = { message: 'You removed that user from this room. Pardon them before inviting them again.', code: 'USER_IS_BANNED', id: 'f76f1893-4efa-4c4c-94ea-a7b47a60e056' };

function shownDialog(): { type: string; title?: string; text?: string } | undefined {
	return os.popups.value.map(popup => popup.props as { type: string; title?: string; text?: string }).findLast(props => props.type === 'error' || props.type === 'warning');
}

beforeEach(() => {
	mocks.requests.length = 0;
	mocks.answers.clear();
	mocks.lists.members = '[]';
	mocks.lists.outbox = '[]';
	mocks.lists.bans = '[]';
	os.popups.value = [];
});

afterEach(() => {
	os.popups.value = [];
});

describe('sending invitations', () => {
	test('asks once per person in the order they were picked, each with my credential', async () => {
		const sent = await inviteUsersToRoom('r1', people);

		expect(sent).toBe(3);
		expect(invitationRequests().map(request => request.body)).toEqual([
			{ roomId: 'r1', userId: 'sora', i: 'my-token' },
			{ roomId: 'r1', userId: 'haru', i: 'my-token' },
			{ roomId: 'r1', userId: 'dami', i: 'my-token' },
		]);
		expect(shownDialog()).toBeUndefined();
	});

	test('does nothing without anyone to invite', async () => {
		expect(await inviteUsersToRoom('r1', [])).toBe(0);

		expect(mocks.requests).toEqual([]);
		expect(os.popups.value).toEqual([]);
	});

	test('names only who failed and why, and keeps those who were invited', async () => {
		mocks.answers.set('haru', refuses(alreadyMember));

		const sent = await inviteUsersToRoom('r1', people);

		expect(sent).toBe(2);
		expect(invitationRequests()).toHaveLength(3);
		const dialog = shownDialog()!;
		expect(dialog.type).toBe('warning');
		expect(dialog.title).toBe(i18n.tsx._chat.inviteFailedUsers({ n: 1 }));
		expect(dialog.text).toContain(i18n.tsx._chat.inviteSentUsers({ n: 2 }));
		expect(dialog.text).toContain('Haru (@haru)');
		expect(dialog.text).toContain(i18n.ts._chat.alreadyMember);
		expect(dialog.text).not.toContain('Sora');
		expect(dialog.text).not.toContain('dami');
	});

	test('says so plainly when nobody could be invited, each with their own reason', async () => {
		mocks.answers.set('sora', refuses(alreadyInvited));
		mocks.answers.set('haru', refuses(alreadyMember));
		mocks.answers.set('dami', refuses(alreadyInvited));

		const sent = await inviteUsersToRoom('r1', people);

		expect(sent).toBe(0);
		const dialog = shownDialog()!;
		expect(dialog.type).toBe('error');
		expect(dialog.title).toBe(i18n.tsx._chat.inviteFailedUsers({ n: 3 }));
		expect(dialog.text).not.toContain(i18n.tsx._chat.inviteSentUsers({ n: 0 }));
		const lines = dialog.text!.split('\n');
		expect(lines).toHaveLength(2);
		expect(lines.find(line => line.includes('Haru'))).toContain(i18n.ts._chat.alreadyMember);
		const both = lines.find(line => line.includes('Sora'));
		expect(both).toContain('@dami@remote.example');
		expect(both).toContain(i18n.ts._chat.alreadyInvited);
	});

	test('says a person the owner removed cannot be invited until pardoned', async () => {
		mocks.answers.set('sora', refuses(banned));

		await inviteUsersToRoom('r1', people);

		expect(shownDialog()?.text).toContain(`: ${i18n.ts._chat.cannotInviteBannedUser}`);
	});

	test('at the limit, does not keep asking, and tells everyone left in the language of the screen', async () => {
		mocks.answers.set('haru', refuses(rateLimit, 429));

		const sent = await inviteUsersToRoom('r1', people);

		expect(sent).toBe(1);
		expect(invitationRequests().map(request => request.body.userId)).toEqual(['sora', 'haru']);
		const dialog = shownDialog()!;
		expect(dialog.text).toContain(i18n.ts.cannotPerformTemporaryDescription);
		expect(dialog.text).toContain('Haru (@haru)');
		expect(dialog.text).toContain('@dami@remote.example');
		expect(dialog.text).not.toContain(rateLimit.message);
	});

	test.each<[string, () => Promise<Response>, string]>([
		['the network is gone', async () => { throw new TypeError('Failed to fetch'); }, 'Failed to fetch'],
		['the server answers something unknown', refuses({ message: 'Something new.', code: 'SOMETHING_NEW', id: '00000000-0000-4000-8000-000000000000' }), 'Something new.'],
	])('%s: says it in its own words, not the English it was told', async (_label, answer, english) => {
		mocks.answers.set('sora', answer);

		await inviteUsersToRoom('r1', people);

		const dialog = shownDialog()!;
		expect(dialog.text).toContain(i18n.ts._chat.actionFailed);
		expect(dialog.text).not.toContain(english);
		expect(invitationRequests()).toHaveLength(3);
	});

	test('a person in the message stays plain text, not a mention or a name with effects', async () => {
		mocks.answers.set('sora', refuses(alreadyMember));
		const showy = { ...sora, name: '$[x4 Sora]' } as unknown as typeof people[number];

		await inviteUsersToRoom('r1', [showy]);

		const nodes = mfm.parse(shownDialog()!.text!);
		expect(JSON.stringify(nodes)).not.toContain('"mention"');
		expect(JSON.stringify(nodes)).not.toContain('"fn"');
	});
});

describe('who cannot be invited', () => {
	test('are those already in the room, those already invited and those the owner removed, each with why', async () => {
		mocks.lists.members = JSON.stringify([{ id: 'm1', userId: 'haru' }]);
		mocks.lists.outbox = JSON.stringify([{ id: 'i1', userId: 'sora' }]);
		mocks.lists.bans = JSON.stringify([{ id: 'b1', userId: 'dami' }]);

		expect(await getUninvitableUsers('r1')).toEqual({
			haru: i18n.ts._chat.alreadyMember,
			sora: i18n.ts._chat.alreadyInvited,
			dami: i18n.ts._chat.cannotInviteBannedUser,
		});
		expect(mocks.requests.map(request => [request.endpoint, request.body])).toEqual([
			['chat/rooms/members', { roomId: 'r1', limit: 100, i: 'my-token' }],
			['chat/rooms/invitations/outbox', { roomId: 'r1', limit: 100, i: 'my-token' }],
			['chat/rooms/bans/list', { roomId: 'r1', limit: 100, i: 'my-token' }],
		]);
	});

	test('still know the members and invitations when the removed people cannot be read', async () => {
		mocks.lists.members = JSON.stringify([{ id: 'm1', userId: 'haru' }]);
		mocks.lists.bans = 'not json';

		expect(await getUninvitableUsers('r1')).toEqual({ haru: i18n.ts._chat.alreadyMember });
	});

	test('are nobody as far as we know when that cannot be read, and the server refuses them later', async () => {
		mocks.lists.members = 'not json';

		await expect(getUninvitableUsers('r1')).resolves.toEqual({});
	});
});
