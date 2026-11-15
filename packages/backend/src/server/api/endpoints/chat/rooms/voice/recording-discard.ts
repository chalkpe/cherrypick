/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RecordingStorageService } from '@/core/RecordingStorageService.js';
import { ApiError } from '@/server/api/error.js';

// 한도 초과로 임시 보관된 최종 녹화와 드라이브에 못 올렸던 임시 조각을 이용자가 버리면 바로 지운다.
// 본인 것이 아니면 존재를 알리지 않는다.
export const meta = {
	tags: ['chat'],
	description: 'Discard a temporarily kept recording download and temporary recording parts owned by the caller. Already gone is treated as success.',

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
		noSuchPart: {
			message: 'No such recording part.',
			code: 'NO_SUCH_PART',
			id: 'fda71e77-cf57-4c07-9796-539a98c95831',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', nullable: true, default: null },
		partIds: { type: 'array', items: { type: 'string', format: 'misskey:id' }, maxItems: 512, default: [] },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recordingStorage: RecordingStorageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (ps.id != null) {
				const download = await this.recordingStorage.getDownload(ps.id);
				if (download != null) {
					if (download.userId !== me.id) throw new ApiError(meta.errors.noSuchDownload);
					await this.recordingStorage.removeDownload(ps.id);
				}
			}
			for (const partId of ps.partIds ?? []) {
				const part = await this.recordingStorage.getPart(partId);
				if (part == null) continue;
				if (part.userId !== me.id) throw new ApiError(meta.errors.noSuchPart);
				await this.recordingStorage.removePart(partId);
			}
		});
	}
}
