/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { RecordingStorageService } from '@/core/RecordingStorageService.js';

// 변환 응답을 잃었을 때 복구 UI가 실제 남은 자료를 참조하도록, requestId로 이전 변환 결과를 조회한다.
// 변환을 다시 실행하지 않고 기억된 결과(드라이브 최종 파일 또는 임시 내려받기)만 돌려준다.
export const meta = {
	tags: ['chat'],
	description: 'Look up the result of an earlier recording conversion by requestId without converting again. Returns null when nothing is remembered.',

	requireCredential: true,

	kind: 'read:drive',

	limit: {
		duration: 60_000,
		max: 60,
	},

	res: {
		type: 'object',
		optional: false, nullable: true,
		properties: {
			file: {
				type: 'object',
				optional: false, nullable: true,
				ref: 'DriveFile',
			},
			download: {
				type: 'object',
				optional: false, nullable: true,
				properties: {
					id: { type: 'string', optional: false, nullable: false },
					name: { type: 'string', optional: false, nullable: false },
					size: { type: 'number', optional: false, nullable: false },
					reason: { type: 'string', optional: false, nullable: false, enum: ['tooLarge', 'noFreeSpace'] },
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		requestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
	},
	required: ['requestId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private driveFileEntityService: DriveFileEntityService,
		private recordingStorage: RecordingStorageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const result = await this.recordingStorage.getResult(me.id, ps.requestId);
			if (result == null) return null;
			if (result.fileId != null) {
				const file = await this.driveFilesRepository.findOneBy({ id: result.fileId, userId: me.id });
				if (file != null) return { file: await this.driveFileEntityService.pack(file, { self: true }), download: null };
				return null;
			}
			if (result.download != null) {
				const download = await this.recordingStorage.getDownload(result.download.id);
				if (download != null && download.userId === me.id && fs.existsSync(download.path)) {
					return { file: null, download: { id: download.id, name: download.name, size: download.size, reason: result.download.reason } };
				}
			}
			return null;
		});
	}
}
