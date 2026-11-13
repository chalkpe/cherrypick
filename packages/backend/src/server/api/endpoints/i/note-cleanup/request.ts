/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteCleanupService } from '@/core/NoteCleanupService.js';
import { ruleIdsProperty } from './schema.js';

import { cleanupBusyError, rethrowCleanupError } from './errors.js';

export const meta = {
	tags: ['account'], requireCredential: true, kind: 'write:account', secure: true,
	limit: { duration: 60000, max: 10 },
	errors: { cleanupBusy: { ...cleanupBusyError, id: 'c2d6520f-1bd5-4ca6-8182-b0b44fdf06a5' }, invalidCleanup: { message: 'Invalid note cleanup request.', code: 'INVALID_CLEANUP', id: 'bba4f532-68a1-4c1e-9d11-0bc7b9c5e050' } },
	res: { type: 'object', properties: { queued: { type: 'boolean', optional: false, nullable: false }, jobId: { type: 'string', optional: false, nullable: false } } },
} as const;

export const paramDef = { type: 'object', properties: { ruleIds: ruleIdsProperty }, required: ['ruleIds'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: NoteCleanupService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await service.request(me.id, ps.ruleIds); } catch (error) {
				rethrowCleanupError(error, meta.errors.invalidCleanup, meta.errors.cleanupBusy);
			}
		});
	}
}
