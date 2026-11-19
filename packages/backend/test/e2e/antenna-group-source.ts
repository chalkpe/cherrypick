/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { AntennaService } from '@/core/AntennaService.js';
import { IdService } from '@/core/IdService.js';
import { MiAntenna } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import { api, failedApiCall, initTestDb, signup, successfulApiCall } from '../utils.js';
import type { UserToken } from '../utils.js';

type User = Awaited<ReturnType<typeof signup>>;

const antennaParam = {
	caseSensitive: false,
	excludeKeywords: [['']],
	keywords: [['groupword']],
	name: 'group antenna',
	src: 'all' as const,
	userGroupId: null,
	userListId: null,
	users: [''],
	withFile: false,
	withReplies: false,
	excludeBots: false,
};

const noSuchUserGroupOnCreate = { status: 400, code: 'NO_SUCH_USER_GROUP', id: 'aa3c0b9a-8cae-47c0-92ac-202ce5906682' };
const noSuchUserGroupOnUpdate = { status: 400, code: 'NO_SUCH_USER_GROUP', id: '109ed789-b6eb-456e-b8a9-6059d567d385' };

describe('그룹을 원본으로 둔 안테나', () => {
	let alice: User;
	let bob: User;
	let carol: User;
	let db: Awaited<ReturnType<typeof initTestDb>>;
	let app: TestingModule;
	let antennaService: AntennaService;
	let idService: IdService;

	const noteFrom = (user: User, text: string) => ({
		id: 'dummy-note',
		userId: user.id,
		visibility: 'public',
		replyId: null,
		text,
		cw: null,
		fileIds: [],
		channel: null,
	}) as unknown as MiNote;
	const noteUserOf = (user: User) => ({ id: user.id, username: user.username, host: null, isBot: false });

	const createGroup = async (owner: UserToken) => (await successfulApiCall({ endpoint: 'users/groups/create', parameters: { name: 'antenna group' }, user: owner })).id;

	const createGroupAntenna = async (owner: UserToken, userGroupId: string) => (await successfulApiCall({
		endpoint: 'antennas/create',
		parameters: { ...antennaParam, src: 'group', userGroupId },
		user: owner,
	})).id;

	const join = async (owner: UserToken, member: User, userGroupId: string) => {
		await successfulApiCall({ endpoint: 'users/groups/invite', parameters: { groupId: userGroupId, userId: member.id }, user: owner }, { status: 204 });
		let invitation: any;
		await waitUntil(async () => {
			const res = await api('i/notifications', { includeTypes: ['groupInvited'] }, member);
			invitation = (res.body as any[]).find(x => x.type === 'groupInvited');
			return invitation != null;
		});
		assert.ok(invitation, 'invitation notification expected');
		await successfulApiCall({ endpoint: 'users/groups/invitations/accept', parameters: { invitationId: invitation.invitation.id }, user: member });
	};

	const inMemory = async (antennaId: string) => (await antennaService.getAntennas()).some(a => a.id === antennaId);

	const waitUntil = async (cond: () => Promise<boolean>) => {
		for (let i = 0; i < 50; i++) {
			if (await cond()) return true;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return false;
	};

	beforeAll(async () => {
		alice = await signup({ username: 'grpantalice' });
		bob = await signup({ username: 'grpantbob' });
		carol = await signup({ username: 'grpantcarol' });
		db = await initTestDb(true);
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(DI.db).useValue(db)
			.compile();
		await app.init();
		antennaService = app.get(AntennaService);
		idService = app.get(IdService);
		await antennaService.getAntennas();
	});

	afterAll(async () => {
		await app?.close();
		if (db?.isInitialized) await db.destroy();
	}, 30_000);

	test('antennas/create は userGroupId のない group 指定を拒否する', async () => {
		await failedApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam, src: 'group', userGroupId: null }, user: alice }, noSuchUserGroupOnCreate);
		await failedApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam, src: 'group' } as any, user: alice }, noSuchUserGroupOnCreate);
		await failedApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam, src: 'group', userGroupId: '0000000000000000' }, user: alice }, noSuchUserGroupOnCreate);
	});

	test('antennas/update は userGroupId のない group 指定を拒否する', async () => {
		const antenna = await successfulApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam }, user: alice });
		await failedApiCall({ endpoint: 'antennas/update', parameters: { antennaId: antenna.id, src: 'group', userGroupId: null }, user: alice }, noSuchUserGroupOnUpdate);
		await failedApiCall({ endpoint: 'antennas/update', parameters: { antennaId: antenna.id, src: 'group' }, user: alice }, noSuchUserGroupOnUpdate);
		const unchanged = await successfulApiCall({ endpoint: 'antennas/show', parameters: { antennaId: antenna.id }, user: alice });
		assert.strictEqual(unchanged.src, 'all');
	});

	test('有効な group 指定の作成と更新は受け付ける', async () => {
		const groupId = await createGroup(alice);
		const created = await successfulApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam, src: 'group', userGroupId: groupId }, user: alice });
		assert.strictEqual(created.src, 'group');
		assert.strictEqual(created.userGroupId, groupId);
		const updated = await successfulApiCall({ endpoint: 'antennas/update', parameters: { antennaId: created.id, src: 'group', userGroupId: groupId, name: 'renamed' }, user: alice });
		assert.strictEqual(updated.name, 'renamed');
	});

	test('加入行が失われた group アンテナがあっても、他のアンテナにノートが入る', async () => {
		const groupId = await createGroup(alice);
		const groupAntennaId = await createGroupAntenna(alice, groupId);
		const otherAntenna = await successfulApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam, name: 'plain antenna' }, user: carol });
		assert.ok(await waitUntil(async () => await inMemory(groupAntennaId) && await inMemory(otherAntenna.id)));

		// 加入行をDBから直接消し、他のプロセスのメモリ上の一覧だけに group アンテナを残す
		await db.query('DELETE FROM "user_group_joining" WHERE "userGroupId" = $1', [groupId]);
		assert.ok(await inMemory(groupAntennaId));

		const matched = await antennaService.addNoteToAntennas(noteFrom(bob, 'a groupword note'), noteUserOf(bob));
		assert.ok(matched.some(a => a.id === otherAntenna.id));
		assert.ok(!matched.some(a => a.id === groupAntennaId));
	});

	test('userGroupJoiningId が null の group アンテナは判定で例外にならず、一致しない', async () => {
		const antenna = await db.getRepository(MiAntenna).save({
			id: idService.gen(),
			userId: alice.id,
			name: 'orphan group antenna',
			src: 'group',
			userGroupJoiningId: null,
			lastUsedAt: new Date(),
			caseSensitive: false,
			localOnly: false,
			excludeBots: false,
			withReplies: false,
			withFile: false,
			isActive: true,
			excludeNotesInSensitiveChannel: false,
			keywords: [['groupword']],
			excludeKeywords: [['']],
			users: [''],
		} as unknown as MiAntenna);
		const hit = await antennaService.checkHitAntenna(antenna, noteFrom(bob, 'a groupword note'), noteUserOf(bob));
		assert.strictEqual(hit, false);
	});

	test('判定が例外で終わるアンテナがあっても、他のアンテナの配達は続く', async () => {
		const plain = await successfulApiCall({ endpoint: 'antennas/create', parameters: { ...antennaParam, name: 'delivery antenna' }, user: carol });
		assert.ok(await waitUntil(() => inMemory(plain.id)));
		const memory = (antennaService as any).antennas as MiAntenna[];
		const broken = { id: 'broken-antenna', userId: alice.id, src: 'all', keywords: undefined, excludeKeywords: [], users: [], withReplies: true } as unknown as MiAntenna;
		memory.unshift(broken);
		try {
			const matched = await antennaService.addNoteToAntennas(noteFrom(bob, 'a groupword note'), noteUserOf(bob));
			assert.ok(matched.some(a => a.id === plain.id));
			assert.ok(!matched.some(a => a.id === broken.id));
		} finally {
			memory.splice(memory.indexOf(broken), 1);
		}
	});

	test('グループを削除すると、そのグループのアンテナがメモリ上の一覧から外れる', async () => {
		const groupId = await createGroup(alice);
		const antennaId = await createGroupAntenna(alice, groupId);
		assert.ok(await waitUntil(() => inMemory(antennaId)));
		await successfulApiCall({ endpoint: 'users/groups/delete', parameters: { groupId }, user: alice });
		assert.ok(await waitUntil(async () => !await inMemory(antennaId)), 'antenna should leave the in-memory list');
	});

	test('グループを抜けると、その人のアンテナがメモリ上の一覧から外れる', async () => {
		const groupId = await createGroup(alice);
		await join(alice, bob, groupId);
		const antennaId = await createGroupAntenna(bob, groupId);
		const ownerAntennaId = await createGroupAntenna(alice, groupId);
		assert.ok(await waitUntil(async () => await inMemory(antennaId) && await inMemory(ownerAntennaId)));
		await successfulApiCall({ endpoint: 'users/groups/leave', parameters: { groupId }, user: bob });
		assert.ok(await waitUntil(async () => !await inMemory(antennaId)), 'antenna should leave the in-memory list');
		assert.ok(await inMemory(ownerAntennaId));
	});

	test('グループから外されると、その人のアンテナがメモリ上の一覧から外れる', async () => {
		const groupId = await createGroup(alice);
		await join(alice, bob, groupId);
		const antennaId = await createGroupAntenna(bob, groupId);
		assert.ok(await waitUntil(() => inMemory(antennaId)));
		await successfulApiCall({ endpoint: 'users/groups/pull', parameters: { groupId, userId: bob.id }, user: alice });
		assert.ok(await waitUntil(async () => !await inMemory(antennaId)), 'antenna should leave the in-memory list');
	});
});
