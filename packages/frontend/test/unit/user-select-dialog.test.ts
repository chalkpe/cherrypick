/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

function renderDialog(props: { includeSelf?: boolean; localOnly?: boolean; multiple?: boolean; unavailableUsers?: Promise<Record<string, string>> } = {}) {
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

describe('a user on this server who has not written a note yet', () => {
	const haru = { id: 'haru', username: 'haru', host: null, name: 'Haru' };
	const remoteHaru = { id: 'remote-haru', username: 'haru', host: 'remote.example', name: 'Remote Haru' };

	function answer(searched: unknown[], found: unknown) {
		mocks.api.mockImplementation(async (endpoint, params) => {
			if (endpoint === 'users/search-by-username-and-host') return searched;
			if (endpoint === 'users/show' && 'username' in params) {
				if (found == null) throw new Error('No such user.');
				return found;
			}
			return [];
		});
	}

	const type = (text: string) => fireEvent.update(screen.getByLabelText(i18n.ts.username), text);

	test('is found by the full username, though the search leaves them out', async () => {
		answer([], haru);
		renderDialog();

		await type('haru');

		expect(await screen.findByText('Haru')).toBeTruthy();
		expect(mocks.api).toHaveBeenCalledWith('users/show', { username: 'haru', host: null });
	});

	test('comes before a user of the same name elsewhere', async () => {
		answer([remoteHaru], haru);
		const { container } = renderDialog();

		await type('haru');

		await screen.findByText('Haru');
		expect(container.textContent!.indexOf('Haru')).toBeLessThan(container.textContent!.indexOf('Remote Haru'));
	});

	test('is not asked for again when the search already found them', async () => {
		answer([haru], haru);
		renderDialog();

		await type('HARU');

		await screen.findByText('Haru');
		expect(mocks.api).not.toHaveBeenCalledWith('users/show', expect.objectContaining({ username: 'HARU' }));
	});

	test('still reads as nobody when no such user exists', async () => {
		answer([], null);
		renderDialog();

		await type('nobody');

		await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('users/show', { username: 'nobody', host: null }));
		expect(await screen.findByText(i18n.ts.noUsers)).toBeTruthy();
	});

	test('is not looked for when another server was named', async () => {
		answer([], haru);
		renderDialog();

		await type('haru@remote.example');

		await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('users/search-by-username-and-host', expect.objectContaining({ host: 'remote.example' })));
		expect(mocks.api).not.toHaveBeenCalledWith('users/show', expect.objectContaining({ username: 'haru' }));
	});
});

describe('pasting a full address into the username field', () => {
	const usernameField = () => screen.getByLabelText(i18n.ts.username) as HTMLInputElement;
	const hostField = () => screen.getByLabelText(i18n.ts.host) as HTMLInputElement;

	test.each(['@sora@remote.example', 'sora@remote.example', ' sora@REMOTE.example '])('splits %s into the two fields', async (pasted) => {
		renderDialog();

		await fireEvent.update(usernameField(), pasted);

		await waitFor(() => expect(usernameField().value).toBe('sora'));
		expect(hostField().value).toBe('remote.example');
		expect(mocks.api).toHaveBeenLastCalledWith('users/search-by-username-and-host', { username: 'sora', host: 'remote.example', limit: 10, detail: false });
	});

	test('leaves what is being typed in place, so that the next letters do not land in the wrong field', async () => {
		renderDialog();

		for (const typed of ['s', 'so', 'so@', 'so@r', 'so@re']) await fireEvent.update(usernameField(), typed);

		expect(usernameField().value).toBe('so@re');
		expect(hostField().value).toBe('');
	});

	test('has no host field to fill when only this server can be searched', async () => {
		renderDialog({ localOnly: true });

		await fireEvent.update(usernameField(), 'sora@remote.example');

		expect(usernameField().value).toBe('sora@remote.example');
	});
});

describe('choosing several people', () => {
	const localBob = { id: 'local-bob', username: 'bob', host: null, name: 'Local Bob' };
	const confirmButton = () => screen.getByRole('button', { name: 'Confirm' });
	const usernameField = () => screen.getByLabelText(i18n.ts.username);
	// 行だけが押された状態を持つ。選んだ人の欄の「外す」ボタンと取り違えない
	const row = (name: RegExp, pressed: boolean) => screen.findByRole('button', { name, pressed });

	beforeEach(() => {
		mocks.api.mockImplementation(async (endpoint, params) => {
			if (endpoint === 'users/search-by-username-and-host') return params.username === 'alice' ? [remoteUser] : params.username === 'bob' ? [localBob] : [];
			if (endpoint === 'users/show' && 'username' in params) throw new Error('No such user');
			if (endpoint === 'users/show' && 'userId' in params) return localBob;
			return [];
		});
	});

	test('keeps who was picked on one server while searching another, and hands them all over', async () => {
		const dialog = renderDialog({ multiple: true });
		expect(confirmButton().hasAttribute('disabled')).toBe(true);

		await fireEvent.update(usernameField(), 'alice@remote.example');
		await fireEvent.click(await row(/Remote Alice/, false));
		expect(confirmButton().hasAttribute('disabled')).toBe(false);

		await fireEvent.update(usernameField(), 'bob');
		await fireEvent.update(screen.getByLabelText(i18n.ts.host), '');
		await fireEvent.click(await row(/Local Bob/, false));
		expect(screen.getByText(i18n.tsx.selectedUsersCount({ n: 2 }))).toBeTruthy();

		await fireEvent.click(confirmButton());

		expect(dialog.emitted().okMultiple).toEqual([[[remoteUser, localBob]]]);
		expect(dialog.emitted().ok).toBeUndefined();
		expect(mocks.store.set).toHaveBeenCalledWith('recentlyUsedUsers', ['local-bob', 'remote']);
	});

	test('shows who was picked even once the search finds someone else, and lets them go from there', async () => {
		renderDialog({ multiple: true });
		await fireEvent.update(usernameField(), 'alice@remote.example');
		await fireEvent.click(await row(/Remote Alice/, false));

		await fireEvent.update(usernameField(), 'bob');
		await row(/Local Bob/, false);
		expect(screen.getByRole('listitem').textContent).toContain('Remote Alice');
		expect(screen.getByRole('listitem').textContent).toContain('@alice@remote.example');

		await fireEvent.click(screen.getByRole('button', { name: i18n.tsx.removeFromSelection({ x: 'Remote Alice' }) }));

		expect(screen.queryByRole('listitem')).toBeNull();
		expect(confirmButton().hasAttribute('disabled')).toBe(true);
	});

	test('lets go of a person pressed a second time, in the row as well', async () => {
		renderDialog({ multiple: true });
		await fireEvent.update(usernameField(), 'alice@remote.example');

		await fireEvent.click(await row(/Remote Alice/, false));
		await fireEvent.click(await row(/Remote Alice/, true));

		await row(/Remote Alice/, false);
		expect(screen.queryByRole('listitem')).toBeNull();
	});

	test('does not take a double click for done, as the single choice does', async () => {
		const dialog = renderDialog({ multiple: true });
		await fireEvent.update(usernameField(), 'alice@remote.example');
		const person = await row(/Remote Alice/, false);

		await fireEvent.click(person);
		await fireEvent.dblClick(person);

		expect(dialog.emitted().okMultiple).toBeUndefined();
	});

	test('does not ask the server about each person again, since their id is all that is needed', async () => {
		renderDialog({ multiple: true });
		await fireEvent.update(usernameField(), 'alice@remote.example');
		await fireEvent.click(await row(/Remote Alice/, false));
		mocks.api.mockClear();

		await fireEvent.click(confirmButton());

		expect(mocks.api).not.toHaveBeenCalled();
	});

	test('says why someone cannot be picked, and does not pick them', async () => {
		const dialog = renderDialog({ multiple: true, unavailableUsers: Promise.resolve({ remote: 'already here' }) });
		await nextTick();
		await fireEvent.update(usernameField(), 'alice@remote.example');

		const person = await screen.findByRole('button', { name: /Remote Alice/ });
		await waitFor(() => expect(person.getAttribute('aria-disabled')).toBe('true'));
		expect(person.textContent).toContain('already here');
		await fireEvent.click(person);

		expect(screen.queryByRole('listitem')).toBeNull();
		expect(confirmButton().hasAttribute('disabled')).toBe(true);
		expect(dialog.emitted().okMultiple).toBeUndefined();
	});

	test('lets go of someone picked before the answer about them arrived', async () => {
		const answer = deferred<Record<string, string>>();
		renderDialog({ multiple: true, unavailableUsers: answer.promise });
		await fireEvent.update(usernameField(), 'alice@remote.example');
		await fireEvent.click(await row(/Remote Alice/, false));
		expect(screen.queryByRole('listitem')).not.toBeNull();

		answer.resolve({ remote: 'already here' });

		await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull());
		expect(confirmButton().hasAttribute('disabled')).toBe(true);
	});

	test('still lets people be picked when that answer never comes', async () => {
		renderDialog({ multiple: true, unavailableUsers: Promise.reject(new Error('offline')) });
		await fireEvent.update(usernameField(), 'alice@remote.example');

		await fireEvent.click(await row(/Remote Alice/, false));

		expect(confirmButton().hasAttribute('disabled')).toBe(false);
	});

	// 実際の高さは jsdom では測れないので、ここで見るのは高さを保つための作り。動かないこと自体は実際のブラウザで確かめた
	test('keeps the place of the picked people from the start, so that the rows below stay put', async () => {
		renderDialog({ multiple: true });
		await fireEvent.update(usernameField(), 'alice@remote.example');
		const row = await screen.findByRole('button', { name: /Remote Alice/ });

		expect(screen.getByText(i18n.tsx.selectedUsersCount({ n: 0 }))).toBeTruthy();
		const hint = screen.getByText(i18n.ts.canSelectMultipleUsers);
		const area = hint.parentElement;
		expect(row.querySelector('.ti-check')).not.toBeNull();

		await fireEvent.click(row);

		expect(screen.getByText(i18n.tsx.selectedUsersCount({ n: 1 }))).toBeTruthy();
		expect(screen.queryByText(i18n.ts.canSelectMultipleUsers)).toBeNull();
		expect(screen.getByRole('list').parentElement).toBe(area);
		expect(row.querySelector('.ti-check')).not.toBeNull();
	});

	test('does not change the single choice of every other screen', async () => {
		const dialog = renderDialog();
		await fireEvent.update(usernameField(), 'alice@remote.example');
		expect(screen.queryByText(i18n.ts.canSelectMultipleUsers)).toBeNull();

		await fireEvent.click(await screen.findByRole('button', { name: /Remote Alice/ }));
		expect(screen.queryByRole('listitem')).toBeNull();
		expect(screen.getByRole('button', { name: /Remote Alice/ }).querySelector('.ti-check')).toBeNull();
		await fireEvent.update(usernameField(), 'bob');
		await fireEvent.click(await screen.findByRole('button', { name: /Local Bob/ }));
		await fireEvent.click(confirmButton());

		await waitFor(() => expect(dialog.emitted().ok).toHaveLength(1));
		expect(dialog.emitted().okMultiple).toBeUndefined();
	});
});

describe('while an answer is on its way', () => {
	const bob = { id: 'bob', username: 'bob', host: 'remote.example', name: 'Remote Bob' };
	const usernameField = () => screen.getByLabelText(i18n.ts.username);
	const noUsers = () => screen.queryByText(i18n.ts.noUsers);

	function answerSearchWith(pending: ReturnType<typeof deferred<unknown[]>>) {
		mocks.api.mockImplementation(async (endpoint, params) => {
			if (endpoint === 'users/search-by-username-and-host') return params.username === 'alice' ? [remoteUser] : pending.promise;
			if (endpoint === 'users/show' && 'username' in params) throw new Error('No such user');
			return [];
		});
	}

	test('does not say nobody before the first answer comes, and says so once it does', async () => {
		const pending = deferred<unknown[]>();
		answerSearchWith(pending);
		renderDialog();

		await fireEvent.update(usernameField(), 'nobody@remote.example');
		expect(noUsers()).toBeNull();

		pending.resolve([]);
		expect(await screen.findByText(i18n.ts.noUsers)).toBeTruthy();
	});

	test('keeps the last results until the next answer comes, none of them selected', async () => {
		const pending = deferred<unknown[]>();
		answerSearchWith(pending);
		renderDialog();
		await fireEvent.update(usernameField(), 'alice@remote.example');
		await fireEvent.click(await screen.findByRole('button', { name: /Remote Alice/ }));

		await fireEvent.update(usernameField(), 'bob@remote.example');

		const stale = screen.getByRole('button', { name: /Remote Alice/ });
		expect(stale.getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
		expect(noUsers()).toBeNull();

		pending.resolve([bob]);
		await screen.findByRole('button', { name: /Remote Bob/ });
		expect(screen.queryByRole('button', { name: /Remote Alice/ })).toBeNull();
	});

	test('someone pressed in the last results does not stay chosen once they are gone from the answer', async () => {
		const pending = deferred<unknown[]>();
		answerSearchWith(pending);
		renderDialog();
		await fireEvent.update(usernameField(), 'alice@remote.example');
		const person = await screen.findByRole('button', { name: /Remote Alice/ });
		await fireEvent.update(usernameField(), 'bob@remote.example');

		await fireEvent.click(person);
		expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(false);
		pending.resolve([bob]);
		await screen.findByRole('button', { name: /Remote Bob/ });

		expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
	});

	test('an empty answer replaces the last results', async () => {
		const pending = deferred<unknown[]>();
		answerSearchWith(pending);
		renderDialog();
		await fireEvent.update(usernameField(), 'alice@remote.example');
		await screen.findByRole('button', { name: /Remote Alice/ });

		await fireEvent.update(usernameField(), 'bob@remote.example');
		pending.resolve([]);

		expect(await screen.findByText(i18n.ts.noUsers)).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Remote Alice/ })).toBeNull();
	});

	test('a failed search says nobody, rather than waiting for ever', async () => {
		mocks.api.mockImplementation(async endpoint => {
			if (endpoint === 'users/search-by-username-and-host') throw new Error('offline');
			return [];
		});
		renderDialog();

		await fireEvent.update(usernameField(), 'alice@remote.example');

		expect(await screen.findByText(i18n.ts.noUsers)).toBeTruthy();
	});

	test('keeps the last results while the lookup is on its way, too', async () => {
		const lookup = deferred<typeof remoteUser>();
		mocks.api.mockImplementation(async (endpoint, params) => {
			if (endpoint === 'users/search-by-username-and-host') return [otherUser];
			return 'userIds' in params ? [] : lookup.promise;
		});
		renderDialog();
		await fireEvent.update(usernameField(), 'alice@remote.example');
		await screen.findByRole('button', { name: /Remote Bob/ });

		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.lookup }));

		expect(screen.queryByRole('button', { name: /Remote Bob/ })).not.toBeNull();
		expect(noUsers()).toBeNull();

		lookup.resolve(remoteUser);
		await screen.findByRole('button', { name: /Remote Alice/ });
		expect(screen.queryByRole('button', { name: /Remote Bob/ })).toBeNull();
	});
});
