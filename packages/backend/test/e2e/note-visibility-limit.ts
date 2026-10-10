/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll, describe, expect, test } from 'vitest';
import type * as Misskey from 'cherrypick-js';
import { api, role, signup } from '../utils.js';

describe('Voluntary note visibility limit', () => {
	let root: Misskey.entities.SignupResponse;
	let user: Misskey.entities.SignupResponse;
	let other: Misskey.entities.SignupResponse;

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		user = await signup({ username: 'visibilitylimit' });
		other = await signup({ username: 'other' });
	});

	test('defaults to none and is only exposed to the account owner', async () => {
		const me = await api('i', {}, user);
		expect(me.body.noteVisibilityLimit).toBe('none');
		const profile = await api('users/show', { userId: user.id }, other);
		expect(profile.body).not.toHaveProperty('noteVisibilityLimit');
	});

	test.each([
		{ limit: 'none', expected: ['public', 'home', 'followers', 'specified'] },
		{ limit: 'home', expected: ['home', 'home', 'followers', 'specified'] },
		{ limit: 'followers', expected: ['followers', 'followers', 'followers', 'specified'] },
	] as const)('persists $limit and enforces it on direct API requests', async ({ limit, expected }) => {
		const update = await api('i/update', { noteVisibilityLimit: limit }, user);
		expect(update.status).toBe(200);
		expect(update.body.noteVisibilityLimit).toBe(limit);
		const me = await api('i', {}, user);
		expect(me.body.noteVisibilityLimit).toBe(limit);
		const visibilities = ['public', 'home', 'followers', 'specified'] as const;
		for (const [index, visibility] of visibilities.entries()) {
			const res = await api('notes/create', { text: 'limited note', visibility, visibleUserIds: [other.id] }, user);
			expect(res.status).toBe(200);
			expect(res.body.createdNote.visibility).toBe(expected[index]);
		}
	});

	test('applies to replies and renotes without changing existing notes', async () => {
		const original = await api('notes/create', { text: 'original', visibility: 'public' }, other);
		await api('i/update', { noteVisibilityLimit: 'followers' }, user);
		for (const reference of [{ replyId: original.body.createdNote.id }, { renoteId: original.body.createdNote.id }]) {
			const res = await api('notes/create', { ...reference, text: 'limited', visibility: 'public' }, user);
			expect(res.status).toBe(200);
			expect(res.body.createdNote.visibility).toBe('followers');
		}
		const unchanged = await api('notes/show', { noteId: original.body.createdNote.id }, other);
		expect(unchanged.body.visibility).toBe('public');
	});

	test('rejects invalid limits', async () => {
		const res = await api('i/update', { noteVisibilityLimit: 'public' as never }, user);
		expect(res.status).toBe(400);
	});

	test('removing the personal limit does not override role policy', async () => {
		const restrictedRole = await role(root, {}, { canPublicNote: { useDefault: false, priority: 1, value: false } });
		const assigned = await api('admin/roles/assign', { roleId: restrictedRole.id, userId: user.id }, root);
		expect(assigned.status).toBe(204);
		await api('i/update', { noteVisibilityLimit: 'none' }, user);
		const res = await api('notes/create', { text: 'role limited', visibility: 'public' }, user);
		expect(res.status).toBe(200);
		expect(res.body.createdNote.visibility).toBe('home');
		await api('i/update', { noteVisibilityLimit: 'followers' }, user);
		const stricter = await api('notes/create', { text: 'personal limited', visibility: 'public' }, user);
		expect(stricter.status).toBe(200);
		expect(stricter.body.createdNote.visibility).toBe('followers');
	});
});
