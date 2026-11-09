/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import * as mfm from 'mfc-js';

const fixture = vi.hoisted(() => ({ text: '' }));
vi.mock('@@/js/user.js', () => ({
	acct: (user: { username: string; host: string }) => `${user.username}@${user.host}`,
	userName: (user: { name: string }) => user.name,
}));
vi.mock('@/os.js', () => ({
	promiseDialog: async (result: Promise<unknown>) => result,
	alert: ({ text }: { text: string }) => { fixture.text = text; },
}));
vi.mock('@/i18n.js', () => ({ i18n: {
	ts: { _chat: { actionFailed: 'failed' } },
	tsx: { _chat: { inviteFailedUsers: () => 'failed' } },
} }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: async () => { throw new Error('rejected'); } }));

import { inviteUsersToRoom } from '@/pages/chat/chat-invite.js';

describe('invitation failure dialog names', () => {
	test.each(['Alice', '</plain>$[x4 injected]', '</pla</plain>in>$[x4 injected]', '</PLAIN>$[x4 injected]'])(
		'keeps a display name plain: %s',
		async (name) => {
			const user = { id: 'u1', username: 'alice', host: 'remote.test', name };
			await inviteUsersToRoom('room', [user as never]);

			const parsed = JSON.stringify(mfm.parse(fixture.text));
			expect(parsed).not.toContain('"fn"');
			expect(parsed).not.toContain('"mention"');
			expect(parsed).toContain('alice@remote.test');
		},
	);
});
