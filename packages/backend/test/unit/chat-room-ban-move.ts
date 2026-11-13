/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { MockResolver } from '../misc/mock-resolver.js';
import type { IActor, IObject } from '@/core/activitypub/type.js';
import type { ChatRoomBansRepository, ChatRoomsRepository, MiChatRoom, MiMeta, UsersRepository } from '@/models/_.js';
import type { MiRemoteUser, MiUser } from '@/models/User.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { QueueService } from '@/core/QueueService.js';
import { DI } from '@/di-symbols.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';

type Actor = IActor & { id: string };

// 다른 서버에서 확인한 계정 이전이 재참여 금지를 잇는지를, 실제 DB와 이전 처리 경로 전체로 확인한다.
// 원격 문서는 MockResolver가 돌려주고, 장애는 시험이 명시적으로 넣는다.
describe('chat room bans across remote account moves', () => {
	let app: TestingModule;
	let db: DataSource;
	let idService: IdService;
	let personService: ApPersonService;
	let inboxService: ApInboxService;
	let banService: ChatRoomBanService;
	let queueService: QueueService;
	let usersRepository: UsersRepository;
	let chatRoomsRepository: ChatRoomsRepository;
	let chatRoomBansRepository: ChatRoomBansRepository;
	let resolver: MockResolver;
	let owner: MiUser;

	function actor(alsoKnownAs: string[] = []): Actor {
		const preferredUsername = secureRndstr(8);
		const id = `https://${preferredUsername.toLowerCase()}.test/users/${preferredUsername.toLowerCase()}`;
		return {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Person',
			preferredUsername,
			inbox: `${id}/inbox`,
			outbox: `${id}/outbox`,
			alsoKnownAs,
		};
	}

	/** from이 to로 이전한 뒤 원격 서버가 내보이는 계정 문서. */
	function movedTo(from: Actor, to: Actor): Actor {
		return { ...from, movedTo: to.id };
	}

	/** 원격 서버가 지금 내보이는 계정 문서를 바꾼다. */
	function publish(document: Actor): void {
		resolver.register(document.id, document);
	}

	async function known(document: Actor): Promise<MiRemoteUser> {
		publish(document);
		return await personService.createPerson(document.id, resolver);
	}

	async function bannedIn(room: MiChatRoom, document: Actor): Promise<MiRemoteUser> {
		const user = await known(document);
		await db.transaction(manager => banService.ban(manager, room.id, user.id));
		return user;
	}

	async function createRoom(): Promise<MiChatRoom> {
		const id = idService.gen();
		await chatRoomsRepository.insert({ id, name: id, ownerId: owner.id });
		return chatRoomsRepository.findOneByOrFail({ id });
	}

	function moveActivity(from: Actor, to: Actor): IObject {
		return { id: `${from.id}/moves/${secureRndstr(8)}`, type: 'Move', actor: from.id, object: from.id, target: to.id } as IObject;
	}

	/** 그룹 호스트가 Move를 받은 것처럼 inbox 처리 경로로 넘긴다. 실패하면 inbox 작업은 큐의 재시도를 받는다. */
	async function receiveMove(from: Actor, to: Actor): Promise<unknown> {
		const sender = await usersRepository.findOneByOrFail({ uri: from.id }) as MiRemoteUser;
		return await inboxService.performActivity(sender, moveActivity(from, to), resolver);
	}

	async function userOf(document: Actor): Promise<MiUser | null> {
		return await usersRepository.findOneBy({ uri: document.id });
	}

	async function isBanned(room: MiChatRoom, document: Actor): Promise<boolean> {
		const user = await userOf(document);
		return user != null && await banService.isBanned(room.id, user.id);
	}

	/** 이 그룹에 남은 금지를 막는 일회용 장애. 장애 주입용 fixture이며 시험이 끝나면 지운다. */
	async function failBanWritesFor(userId: MiUser['id']): Promise<() => Promise<void>> {
		const name = `chat_move_ban_fault_${secureRndstr(12).toLowerCase()}`;
		await db.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId" = '${userId}' THEN RAISE EXCEPTION 'injected ban write failure' USING ERRCODE = '40001'; END IF; RETURN NEW; END; $$`);
		await db.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON "chat_room_ban" FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
		return async () => {
			await db.query(`DROP TRIGGER IF EXISTS "${name}" ON "chat_room_ban"`);
			await db.query(`DROP FUNCTION IF EXISTS "${name}"()`);
		};
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(DI.meta).useValue({
				blockedHosts: [],
				silencedHosts: [],
				sensitiveWords: [],
				prohibitedWords: [],
				cacheRemoteFiles: true,
				cacheRemoteSensitiveFiles: true,
			} as unknown as MiMeta)
			.compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		idService = app.get(IdService);
		personService = app.get(ApPersonService);
		inboxService = app.get(ApInboxService);
		banService = app.get(ChatRoomBanService);
		queueService = app.get(QueueService);
		usersRepository = app.get(DI.usersRepository);
		chatRoomsRepository = app.get(DI.chatRoomsRepository);
		chatRoomBansRepository = app.get(DI.chatRoomBansRepository);
		resolver = new MockResolver(await app.resolve(LoggerService));
	});

	beforeEach(async () => {
		resolver.clear();
		// 이전 대상 계정을 다시 읽는 경로도 원격 서버 대신 MockResolver의 문서를 읽게 한다.
		const resolverService = app.get(ApResolverService);
		void resolverService.createResolver;
		vi.spyOn(resolverService, 'createResolver').mockResolvedValue(resolver);
		// 처음 보는 원격 서버의 정보를 실제로 가져오지 않는다.
		const instanceMetadata = app.get(FetchInstanceMetadataService);
		void instanceMetadata.fetchInstanceMetadata;
		vi.spyOn(instanceMetadata, 'fetchInstanceMetadata').mockResolvedValue();
		const id = idService.gen();
		await usersRepository.insert({ id, username: id, usernameLower: id });
		owner = await usersRepository.findOneByOrFail({ id });
	});

	afterAll(async () => {
		await app.close();
	});

	test('a Move whose ban write failed fails the inbox job, and its retry carries only the ban', async () => {
		const room = await createRoom();
		const first = actor();
		const next = actor([first.id]);
		await bannedIn(room, first);
		const nextUser = await known(next);
		void queueService.createFollowJob;
		const relationCarries = vi.spyOn(queueService, 'createFollowJob');
		publish(movedTo(first, next));
		const restore = await failBanWritesFor(nextUser.id);

		try {
			await expect(receiveMove(first, next)).rejects.toThrow('injected ban write failure');
		} finally {
			await restore();
		}
		expect(await isBanned(room, next)).toBe(false);
		await receiveMove(first, next);

		expect(await isBanned(room, next)).toBe(true);
		expect(await isBanned(room, first)).toBe(true);
		expect(relationCarries).toHaveBeenCalledTimes(1);
	});

	test('a pardon stays when the same move arrives again', async () => {
		const room = await createRoom();
		const first = actor();
		const next = actor([first.id]);
		await bannedIn(room, first);
		await known(next);
		publish(movedTo(first, next));
		await receiveMove(first, next);
		const nextUser = await userOf(next);
		await banService.pardon(room.id, nextUser!.id);

		await receiveMove(first, next);
		await personService.updatePerson(first.id, resolver, movedTo(first, next), [], { throwOnBanCarryFailure: true });

		expect(await isBanned(room, next)).toBe(false);
		expect(await isBanned(room, first)).toBe(true);
	});

	test('a Move whose new account could not be fetched is retried when bans are waiting', async () => {
		const room = await createRoom();
		const first = actor();
		const next = actor([first.id]);
		await bannedIn(room, first);
		publish(movedTo(first, next));

		await expect(receiveMove(first, next)).rejects.toThrow();
		publish(next);
		await receiveMove(first, next);

		expect(await isBanned(room, next)).toBe(true);
	});

	test('a failed move of an account without bans finishes as before', async () => {
		const first = actor();
		const next = actor([first.id]);
		await known(first);
		publish(movedTo(first, next));

		expect(await receiveMove(first, next)).toBe('skip: nothing to do');
		expect(await userOf(next)).toBeNull();
	});

	test('a ban reaches an account whose own move this server processed first', async () => {
		const room = await createRoom();
		const first = actor();
		const middle = actor([first.id]);
		const last = actor([middle.id]);
		await bannedIn(room, first);
		await known(middle);
		await known(last);
		// 중간 계정의 이전이 먼저 도착해 처리된다. 이때 중간 계정에는 아직 금지가 없다.
		await personService.updatePerson(middle.id, resolver, movedTo(middle, last), [], { throwOnBanCarryFailure: true });
		publish(movedTo(middle, last));
		publish(movedTo(first, middle));

		await receiveMove(first, middle);

		expect(await isBanned(room, middle)).toBe(true);
		expect(await isBanned(room, last)).toBe(true);
	});

	test('a ban passes through a middle account this server first sees after it moved on', async () => {
		const room = await createRoom();
		const first = actor();
		const middle = actor([first.id]);
		const last = actor([middle.id]);
		await bannedIn(room, first);
		publish(movedTo(middle, last));
		publish(last);
		publish(movedTo(first, middle));

		await receiveMove(first, middle);

		expect(await isBanned(room, middle)).toBe(true);
		expect(await isBanned(room, last)).toBe(true);
	});

	test('a ban reaches the end of a chain whose recorded part ends in an account first seen after it moved on', async () => {
		const room = await createRoom();
		const first = actor();
		const second = actor([first.id]);
		const third = actor([second.id]);
		const fourth = actor([third.id]);
		await bannedIn(room, first);
		await known(second);
		publish(movedTo(third, fourth));
		publish(fourth);
		// 두 번째 계정의 이전이 먼저 처리되며 세 번째 계정을 처음 만난다. 세 번째 계정은 이미 네 번째 계정으로 이전한 뒤다.
		await personService.updatePerson(second.id, resolver, movedTo(second, third));
		publish(movedTo(second, third));
		publish(movedTo(first, second));

		await receiveMove(first, second);

		for (const account of [second, third, fourth]) expect(await isBanned(room, account)).toBe(true);
	});

	test('a claimed move that the new account does not confirm carries nothing', async () => {
		const room = await createRoom();
		const first = actor();
		const stranger = actor();
		await bannedIn(room, first);
		await known(stranger);
		publish(movedTo(first, stranger));

		await receiveMove(first, stranger);
		await personService.updatePerson(first.id, resolver, movedTo(first, stranger), [], { throwOnBanCarryFailure: true });

		expect(await isBanned(room, stranger)).toBe(false);
		expect(await chatRoomBansRepository.countBy({ roomId: room.id })).toBe(1);
	});
});
