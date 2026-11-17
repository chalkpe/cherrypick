/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { IdService } from '@/core/IdService.js';
import { MiChatRoom, MiDriveFile, MiUser } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { initTestDb, signup } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

/** DB·Redis와 제품 inbox 처리를 사용한다. 원격 서명 전송은 federation 시험에서 별도로 검증한다. */
describe('그룹 아이콘 갱신 수신', () => {
	let db: Awaited<ReturnType<typeof initTestDb>>;
	let app: TestingModule;

	beforeAll(async () => {
		await signup({ username: 'iconrecvroot' });
		db = await initTestDb(true);
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(DI.db).useValue(db)
			.compile();
		await app.init();
	});

	afterAll(async () => {
		if (app != null) {
			await waitForChatNotificationTurn();
			await app.close();
		}
		if (db?.isInitialized) await db.destroy();
	}, 30_000);

	async function fixture() {
		const ids = app.get(IdService);
		const ownerId = ids.gen();
		const remote = 'https://icon-receive.example';
		await db.getRepository(MiUser).insert({
			id: ownerId, username: ownerId, usernameLower: ownerId.toLowerCase(), host: 'icon-receive.example',
			uri: `${remote}/users/${ownerId}`, inbox: `${remote}/inbox`, lastFetchedAt: new Date(),
		});
		const owner = await db.getRepository(MiUser).findOneByOrFail({ id: ownerId }) as MiRemoteUser;
		const roomId = ids.gen();
		const roomUri = `${remote}/chat/rooms/${roomId}`;
		const iconId = ids.gen();
		await db.getRepository(MiDriveFile).insert({ id: iconId, userId: ownerId, userHost: 'icon-receive.example', md5: 'icon', name: 'icon.png', type: 'image/png', size: 1, storedInternal: false, url: `${remote}/icons/${iconId}.png`, isLink: true });
		const room = await db.getRepository(MiChatRoom).save({ id: roomId, ownerId, uri: roomUri, name: 'initial', iconId, iconUrl: `${remote}/icons/${iconId}.png` });
		return { owner, room, roomUri, iconId };
	}

	type Fixture = Awaited<ReturnType<typeof fixture>>;

	const newer = new Date('2026-11-03T00:00:10.000Z');

	function update(f: Fixture, icon: unknown, updated = newer) {
		const channelUri = `${f.roomUri}/channels/general`;
		return {
			id: `${f.roomUri}#update/${updated.getTime()}`, type: 'Update', actor: f.owner.uri,
			object: {
				id: f.roomUri, type: 'Group', name: 'renamed', attributedTo: f.owner.uri, updated: updated.toISOString(),
				icon,
				_misskey_chatChannels: [{ id: channelUri, name: 'general' }], _misskey_chatLegacyChannel: channelUri,
			},
			published: updated.toISOString(),
		};
	}

	async function storedRoom(f: Fixture) {
		return await db.getRepository(MiChatRoom).findOneByOrFail({ id: f.room.id });
	}

	test.each([
		['끝', (uri: string) => `${uri}\u0000`],
		['앞', (uri: string) => `\u0000${uri}`],
	])('아이콘 주소 %s의 NUL은 아이콘만 무시하고 이름·채널·판번호는 반영한다', async (_, mutate) => {
		const f = await fixture();
		const iconUrl = mutate(`${f.roomUri}/icon.png`);

		const result = await app.get(ApInboxService).performOneActivity(f.owner, update(f, { type: 'Image', url: iconUrl }));

		expect(result).toBe('ok: chat room updated');
		const stored = await storedRoom(f);
		expect(stored.name).toBe('renamed');
		expect(stored.lastRemoteUpdatedAt).toEqual(newer);
		expect(stored.hasChannels).toBe(true);
		expect(stored.iconId).toBe(f.iconId);
		expect(stored.iconUrl).toBe(f.room.iconUrl);
	});

	test('짝 없는 surrogate가 든 아이콘 주소도 아이콘만 무시한다', async () => {
		const f = await fixture();

		const result = await app.get(ApInboxService).performOneActivity(f.owner, update(f, { type: 'Image', url: `${f.roomUri}/icon\ud800.png` }));

		expect(result).toBe('ok: chat room updated');
		const stored = await storedRoom(f);
		expect(stored.name).toBe('renamed');
		expect(stored.iconId).toBe(f.iconId);
	});

	test('올바른 이모지 pair가 든 아이콘 주소는 이미 저장된 파일을 재사용해 아이콘을 바꾼다', async () => {
		const f = await fixture();
		const ids = app.get(IdService);
		const fileId = ids.gen();
		const uri = `${f.roomUri}/icons/🍀.png`;
		await db.getRepository(MiDriveFile).insert({ id: fileId, userId: f.owner.id, userHost: 'icon-receive.example', md5: 'icon', name: 'icon.png', type: 'image/png', size: 1, storedInternal: false, url: uri, uri, isLink: true });

		const result = await app.get(ApInboxService).performOneActivity(f.owner, update(f, { type: 'Image', url: uri }));

		expect(result).toBe('ok: chat room updated');
		const stored = await storedRoom(f);
		expect(stored.iconId).toBe(fileId);
	});

	test('저장할 수 없는 아이콘 주소를 다시 받아도 오류 없이 아이콘은 그대로다', async () => {
		const f = await fixture();
		const icon = { type: 'Image', url: `${f.roomUri}/icon.png\u0000` };
		const inbox = app.get(ApInboxService);

		expect(await inbox.performOneActivity(f.owner, update(f, icon))).toBe('ok: chat room updated');
		const later = new Date(newer.getTime() + 1000);
		expect(await inbox.performOneActivity(f.owner, update(f, icon, later))).toBe('ok: chat room updated');

		const stored = await storedRoom(f);
		expect(stored.lastRemoteUpdatedAt).toEqual(later);
		expect(stored.iconId).toBe(f.iconId);
	});

	test('명시적인 아이콘 해제는 저장 불가 주소의 무시와 달리 아이콘을 비운다', async () => {
		const f = await fixture();

		const result = await app.get(ApInboxService).performOneActivity(f.owner, update(f, null));

		expect(result).toBe('ok: chat room updated');
		const stored = await storedRoom(f);
		expect(stored.iconId).toBeNull();
		expect(stored.iconUrl).toBeNull();
	});
});