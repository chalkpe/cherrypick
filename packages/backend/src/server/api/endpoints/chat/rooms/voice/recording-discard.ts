/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RecordingStorageService } from '@/core/RecordingStorageService.js';
import { ApiError } from '@/server/api/error.js';

// 한도 초과로 임시 보관된 최종 녹화를 이용자가 버리면 바로 지운다. 본인 것이 아니면 존재를 알리지 않는다.
export const meta = {
	tags: ['chat'],
	description: 'Discard a temporarily kept recording download owned by the caller. Already gone is treated as success.',

	requireCredential: true,

	kind: 'write:drive',

	limit: {
		duration: 60_000,
		max: 30,
	},

	errors: {
		noSuchDownload: {
			message: 'No such recording download.',
			code: 'NO_SUCH_DOWNLOAD',
			id: 'ea5fbf5f-34ec-4032-9917-2d2134819e18',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
	},
	required: ['id'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recordingStorage: RecordingStorageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const download = await this.recordingStorage.getDownload(ps.id);
			if (download == null) return;
			if (download.userId !== me.id) throw new ApiError(meta.errors.noSuchDownload);
			await this.recordingStorage.removeDownload(ps.id);
		});
	}
}
