/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
	instance: { federation: 'all' },
	store: { s: { recentlyUsedUsers: [] as string[] }, set: vi.fn() },
	me: { id: 'me', policies: { canSearchNotes: true } },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));
vi.mock('@/store.js', () => ({ store: mocks.store }));
vi.mock('@/i.js', () => ({ $i: mocks.me }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import MkUserSelectDialog from '@/components/MkUserSelectDialog.vue';
import { i18n } from '@/i18n.js';

const remoteUser = { id: 'remote', username: 'alice', host: 'remote.example', name: 'Remote Alice' };
const otherUser = { id: 'other', username: 'bob', host: 'remote.example', name: 'Remote Bob' };
const stubs = {
	MkModalWindow: {
		props: ['okButtonDisabled'], emits: ['click', 'ok', 'close', 'closed'], methods: { close: vi.fn() },
		template: '<div><slot/><button :disabled="okButtonDisabled" @click="$emit(\'ok\')">Confirm</button></div>',
	},
	MkInput: {
		props: ['modelValue'], emits: ['update:modelValue'],
		template: '<label><slot name="label"/><input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/></label>',
	},
	FormSplit: { template: '<div><slot/></div>' },
	MkButton: {
		props: ['disabled', 'wait'], emits: ['click'],
		template: '<button :disabled="disabled || wait" @click="$emit(\'click\', $event)"><slot/></button>',
	},
	MkAvatar: true,
	MkUserName: { props: ['user'], template: '<span>{{ user.name }}</span>' },
	MkAcct: { props: ['user'], template: '<span>@{{ user.username }}@{{ user.host }}</span>' },
};

function renderDialog(props: { includeSelf?: boolean; localOnly?: boolean } = {}) {
	return render(MkUserSelectDialog, { props, global: { stubs } });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.instance.federation = 'all';
	mocks.store.s.recentlyUsedUsers = [];
	mocks.api.mockImplementation(async (endpoint, params) => {
		if (endpoint === 'users/show' && !('userIds' in params)) return remoteUser;
		return [];
	});
});
afterEach(cleanup);

test('parses a full account and resolves an unknown remote user only on explicit lookup', async () => {
	const dialog = renderDialog();
	await fireEvent.update(screen.getByLabelText(i18n.ts.username), ' @alice@REMOTE.EXAMPLE ');
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('users/search-by-username-and-host', {
		username: 'alice', host: 'remote.example', limit: 10, detail: false,
	}));
	expect(mocks.api).not.toHaveBeenCalledWith('users/show', expect.objectContaining({ username: 'alice' }));

	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));
	const result = await screen.findByRole('button', { name: /Remote Alice/ });
	expect(mocks.api).toHaveBeenCalledWith('users/show', { username: 'alice', host: 'remote.example' });
	await fireEvent.click(result);
	await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
	await waitFor(() => expect(dialog.emitted().ok).toEqual([[remoteUser]]));
	expect(mocks.store.set).toHaveBeenCalledWith('recentlyUsedUsers', ['remote']);
});

test('resolves a remote account entered in separate username and host fields', async () => {
	renderDialog();
	await fireEvent.update(screen.getByLabelText(i18n.ts.username), 'alice');
	await fireEvent.update(screen.getByLabelText(i18n.ts.host), 'REMOTE.EXAMPLE');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));
	await screen.findByRole('button', { name: /Remote Alice/ });
	expect(mocks.api).toHaveBeenCalledWith('users/show', { username: 'alice', host: 'remote.example' });
});

test('ignores an older prefix search after explicit lookup resolves', async () => {
	const pendingSearch = deferred<typeof remoteUser[]>();
	mocks.api.mockImplementation(async (endpoint, params) => {
		if (endpoint === 'users/search-by-username-and-host') return pendingSearch.promise;
		return 'userIds' in params ? [] : remoteUser;
	});
	renderDialog();
	await fireEvent.update(screen.getByLabelText(i18n.ts.username), 'alice@remote.example');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));
	await screen.findByRole('button', { name: /Remote Alice/ });
	pendingSearch.resolve([]);
	await nextTick();
	await nextTick();
	expect(screen.queryByRole('button', { name: /Remote Alice/ })).not.toBeNull();
});

test('ignores an older lookup after the query changes', async () => {
	const pendingLookup = deferred<typeof remoteUser>();
	mocks.api.mockImplementation(async (endpoint, params) => {
		if (endpoint === 'users/search-by-username-and-host') return params.username === 'bob' ? [otherUser] : [];
		return 'userIds' in params ? [] : pendingLookup.promise;
	});
	renderDialog();
	const input = screen.getByLabelText(i18n.ts.username);
	await fireEvent.update(input, 'alice@remote.example');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));
	await fireEvent.update(input, 'bob@remote.example');
	await screen.findByRole('button', { name: /Remote Bob/ });
	pendingLookup.resolve(remoteUser);
	await nextTick();
	await nextTick();
	expect(screen.queryByRole('button', { name: /Remote Alice/ })).toBeNull();
	expect(screen.queryByRole('button', { name: /Remote Bob/ })).not.toBeNull();
});

test('clears the selected user as soon as the query changes', async () => {
	mocks.api.mockImplementation(async endpoint => endpoint === 'users/search-by-username-and-host' ? [remoteUser] : []);
	renderDialog();
	const input = screen.getByLabelText(i18n.ts.username);
	await fireEvent.update(input, 'alice');
	await fireEvent.click(await screen.findByText('Remote Alice'));
	expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(false);
	await fireEvent.update(input, 'bob');
	expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
});

test('shows no users when explicit lookup fails', async () => {
	mocks.api.mockImplementation(async (endpoint, params) => {
		if (endpoint === 'users/show' && !('userIds' in params)) throw new Error('No such user');
		return [];
	});
	renderDialog();
	await fireEvent.update(screen.getByLabelText(i18n.ts.username), 'missing@remote.example');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));
	await waitFor(() => expect(screen.getByRole('button', { name: i18n.ts.lookup }).hasAttribute('disabled')).toBe(false));
	expect(screen.queryByText(i18n.ts.noUsers)).not.toBeNull();
	expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
});

test.each([false, true])('respects includeSelf=%s when resolving an account', async includeSelf => {
	mocks.api.mockImplementation(async (endpoint, params) => {
		if (endpoint === 'users/show' && !('userIds' in params)) return { ...remoteUser, id: mocks.me.id };
		return [];
	});
	renderDialog({ includeSelf });
	await fireEvent.update(screen.getByLabelText(i18n.ts.username), 'alice@remote.example');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));
	await waitFor(() => expect(screen.getByRole('button', { name: i18n.ts.lookup }).hasAttribute('disabled')).toBe(false));
	expect(screen.queryByRole('button', { name: /Remote Alice/ }) !== null).toBe(includeSelf);
});

test.each(['localOnly', 'federationNone'])('does not resolve a remote account with %s', async restriction => {
	if (restriction === 'federationNone') mocks.instance.federation = 'none';
	renderDialog({ localOnly: restriction === 'localOnly' });
	await fireEvent.update(screen.getByLabelText(i18n.ts.username), '@alice@remote.example');
	expect(screen.queryByRole('button', { name: i18n.ts.lookup })).toBeNull();
	expect(mocks.api).not.toHaveBeenCalledWith('users/show', expect.objectContaining({ username: 'alice' }));
	expect(mocks.api).not.toHaveBeenCalledWith('users/search-by-username-and-host', expect.objectContaining({ host: 'remote.example' }));
});
