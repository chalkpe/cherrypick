/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { MiDriveFolder } from '@/models/DriveFolder.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';
import { IdService } from '@/core/IdService.js';
import { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApiError } from '@/server/api/error.js';
import type { Packed } from '@/misc/json-schema.js';

// 녹화 폴더는 계정에 하나만 기억한다. 처음 녹화할 때 그때 언어 이름으로 만들고 폴더 ID를 기억해,
// 화면 언어를 바꾸거나 폴더 이름을 바꿔도 같은 폴더에 저장한다. 폴더를 지웠으면 다음 녹화 때 새로 만든다.
// 조회·생성·기억을 이용자 단위 DB 잠금 한 구간에서 원자적으로 커밋한다. 잠금은 트랜잭션이 끝날 때까지
// 유지되므로, 임대 만료 뒤늦은 쓰기가 다른 기기의 폴더를 덮어쓰거나 폴더가 둘 생기는 일이 없다.
const FOLDER_LOCK_WAIT_MS = 5_000;
const REGISTRY_SCOPE = ['voiceCall'];
const REGISTRY_KEY = 'recordingFolderId';

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
		@Inject(DI.db)
		private db: DataSource,

		private driveFolderEntityService: DriveFolderEntityService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			let packed: Packed<'DriveFolder'> | null = null;
			let created = false;
			await this.db.transaction(async manager => {
				const deadline = Date.now() + FOLDER_LOCK_WAIT_MS;
				for (;;) {
					const [row] = await manager.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [`chatVoice:recordingFolder:${me.id}`]);
					if (row.locked) break;
					if (Date.now() >= deadline) throw new ApiError(meta.errors.busy);
					await new Promise(resolve => setTimeout(resolve, 100));
				}

				const registry = manager.getRepository(MiRegistryItem);
				const item = await registry.createQueryBuilder('item')
					.where('item.domain IS NULL')
					.andWhere('item.userId = :userId', { userId: me.id })
					.andWhere('item.key = :key', { key: REGISTRY_KEY })
					.andWhere('item.scope = :scope', { scope: REGISTRY_SCOPE })
					.getOne();

				// 기억된 폴더가 있으면 이름·언어가 바뀌어도 그 폴더를 그대로 쓴다.
				const rememberedId = typeof item?.value === 'string' ? item.value : null;
				if (rememberedId != null) {
					const existing = await manager.getRepository(MiDriveFolder).findOneBy({ id: rememberedId, userId: me.id });
					if (existing != null) {
						packed = await this.driveFolderEntityService.pack(existing);
						return;
					}
				}

				// 기억된 폴더가 없거나 지워졌으면 지금 언어 이름으로 새로 만들고 같은 트랜잭션에서 기억한다.
				const folder = {
					id: this.idService.gen(),
					name: ps.name,
					parentId: null,
					userId: me.id,
				};
				await manager.getRepository(MiDriveFolder).insert(folder);
				if (item != null) {
					await registry.update(item.id, { updatedAt: new Date(), value: folder.id as any });
				} else {
					await registry.insert({
						id: this.idService.gen(),
						updatedAt: new Date(),
						userId: me.id,
						domain: null,
						scope: REGISTRY_SCOPE,
						key: REGISTRY_KEY,
						value: folder.id as any,
					});
				}
				packed = await this.driveFolderEntityService.pack(folder as MiDriveFolder);
				created = true;
			});
			if (created) this.globalEventService.publishDriveStream(me.id, 'folderCreated', packed!);
			return packed!;
		});
	}
}
