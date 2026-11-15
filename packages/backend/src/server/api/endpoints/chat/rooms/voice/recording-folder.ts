/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFoldersRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { RegistryApiService } from '@/core/RegistryApiService.js';
import { ApiError } from '@/server/api/error.js';

// 녹화 폴더는 계정에 하나만 기억한다. 처음 녹화할 때 그때 언어 이름으로 만들고 폴더 ID를 기억해,
// 화면 언어를 바꾸거나 폴더 이름을 바꿔도 같은 폴더에 저장한다. 폴더를 지웠으면 다음 녹화 때 새로 만든다.
// 여러 기기에서 동시에 처음 녹화해도 폴더가 둘 생기지 않도록 이용자별 잠금 안에서 조회·생성·기억을 직렬화한다.
const FOLDER_LOCK_TTL_MS = 10_000;
const FOLDER_LOCK_WAIT_MS = 5_000;
const folderLockKey = (userId: string) => `chatVoice:recordingFolder:${userId}`;
const REGISTRY_SCOPE = ['voiceCall'];
const REGISTRY_KEY = 'recordingFolderId';

const RELEASE_FOLDER_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1
`;

export const meta = {
	tags: ['chat'],
	description: 'Return the account\'s single remembered call-recording folder, creating it on first use. Serialized per user so concurrent first recordings do not create duplicates.',

	requireCredential: true,

	kind: 'write:drive',

	limit: {
		duration: 60_000,
		max: 30,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'DriveFolder',
	},

	errors: {
		busy: {
			message: 'The recordings folder is being prepared. Try again later.',
			code: 'BUSY',
			id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		// 처음 만들 때 쓸 폴더 이름(현재 화면 언어). 이미 기억된 폴더가 있으면 이름과 무관하게 그 폴더를 돌려준다.
		name: { type: 'string', minLength: 1, maxLength: 200 },
	},
	required: ['name'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFoldersRepository)
		private driveFoldersRepository: DriveFoldersRepository,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private driveFolderEntityService: DriveFolderEntityService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
		private registryApiService: RegistryApiService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const token = randomUUID();
			const lockKey = folderLockKey(me.id);
			const deadline = Date.now() + FOLDER_LOCK_WAIT_MS;
			let acquired = false;
			while (Date.now() < deadline) {
				acquired = (await this.redisClient.set(lockKey, token, 'PX', FOLDER_LOCK_TTL_MS, 'NX')) === 'OK';
				if (acquired) break;
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			if (!acquired) throw new ApiError(meta.errors.busy);

			try {
				// 기억된 폴더가 있으면 이름·언어가 바뀌어도 그 폴더를 그대로 쓴다.
				const remembered = await this.registryApiService.getItem(me.id, null, REGISTRY_SCOPE, REGISTRY_KEY);
				const rememberedId = typeof remembered?.value === 'string' ? remembered.value : null;
				if (rememberedId != null) {
					const existing = await this.driveFoldersRepository.findOneBy({ id: rememberedId, userId: me.id });
					if (existing != null) return await this.driveFolderEntityService.pack(existing);
				}

				// 기억된 폴더가 없거나 지워졌으면 지금 언어 이름으로 새로 만들고 다시 기억한다.
				const folder = await this.driveFoldersRepository.insertOne({
					id: this.idService.gen(),
					name: ps.name,
					parentId: null,
					userId: me.id,
				});
				await this.registryApiService.set(me.id, null, REGISTRY_SCOPE, REGISTRY_KEY, folder.id);
				const folderObj = await this.driveFolderEntityService.pack(folder);
				this.globalEventService.publishDriveStream(me.id, 'folderCreated', folderObj);
				return folderObj;
			} finally {
				await this.redisClient.eval(RELEASE_FOLDER_LOCK_SCRIPT, 1, lockKey, token).catch(() => {});
			}
		});
	}
}
