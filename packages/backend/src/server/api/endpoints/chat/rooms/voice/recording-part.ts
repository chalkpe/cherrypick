/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { FileInfoService } from '@/core/FileInfoService.js';
import { RoleService } from '@/core/RoleService.js';
import { RecordingStorageService, RecordingStorageFullError } from '@/core/RecordingStorageService.js';
import { ApiError } from '@/server/api/error.js';

// 드라이브에 올리지 못한 녹화 조각을 녹화 전용 임시 보관에 올린다.
// 변환 단계에서 이미 드라이브에 올라간 조각과 순서대로 이어 붙여 최종 파일 하나를 만든다.
// 공통 드라이브 업로드를 거치지 않으므로 용량 부족과 무관하게 조각을 받을 수 있다.
export const meta = {
	tags: ['chat'],
	description: 'Upload a recording part into the temporary recording storage, for parts that could not be stored in the drive. The conversion step concatenates these parts with the uploaded ones into a single final file.',

	requireCredential: true,

	kind: 'write:drive',

	limit: {
		duration: 60_000,
		max: 60,
	},

	requireFile: true,

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			id: { type: 'string', optional: false, nullable: false },
			size: { type: 'number', optional: false, nullable: false },
		},
	},

	errors: {
		invalidFileType: {
			message: 'Not a recording file.',
			code: 'INVALID_FILE_TYPE',
			id: 'c6fec696-15de-479f-aec5-0e4f361be76f',
		},
		tooLarge: {
			message: 'The recording part exceeds the maximum file size.',
			code: 'TOO_LARGE',
			id: '6f4860e9-3726-4f2c-9bef-4d812f810018',
			httpStatusCode: 413,
		},
		storageFull: {
			message: 'The temporary recording storage is full.',
			code: 'STORAGE_FULL',
			id: '6ad10fe3-0426-43d5-8932-a15a49a2371c',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.config)
		private config: Config,

		private fileInfoService: FileInfoService,
		private roleService: RoleService,
		private recordingStorage: RecordingStorageService,
	) {
		super(meta, paramDef, async (_ps, me, _token, _flash, file, cleanup) => {
			try {
				const size = fs.statSync(file!.path).size;
				const policies = await this.roleService.getUserPolicies(me.id);
				if (size > Math.min(this.config.maxFileSize, policies.maxFileSizeMb * 1024 * 1024)) throw new ApiError(meta.errors.tooLarge);
				// 드라이브 업로드와 같은 내용 기반 형식 판별을 쓴다. 녹화 형식이 아니면 받지 않는다.
				const type = (await this.fileInfoService.detectType(file!.path)).mime;
				const isRecordingType = type.startsWith('audio/webm') || type.startsWith('audio/mp4') || type.startsWith('video/webm') || type.startsWith('video/mp4');
				if (!isRecordingType) throw new ApiError(meta.errors.invalidFileType);
				let part;
				try {
					part = await this.recordingStorage.storePart(me.id, file!.path, file!.name ?? 'recording', type);
				} catch (error) {
					if (error instanceof RecordingStorageFullError) throw new ApiError(meta.errors.storageFull);
					throw error;
				}
				return { id: part.id, size: part.size };
			} finally {
				cleanup!();
			}
		});
	}
}
