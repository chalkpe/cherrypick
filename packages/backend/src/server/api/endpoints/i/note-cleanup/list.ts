/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteCleanupService } from '@/core/NoteCleanupService.js';
import { packedNoteCleanupRuleSchema } from '@/models/json-schema/note-cleanup.js';

import { cleanupBusyError, rethrowCleanupError } from './errors.js';

export const meta = {
	tags: ['account'], requireCredential: true, kind: 'read:account',
	limit: { duration: 60000, max: 60 },
	errors: { cleanupBusy: { ...cleanupBusyError, id: 'a9266652-f942-4021-8677-2ca26e50c344' }, invalidCleanup: { message: 'Invalid note cleanup request.', code: 'INVALID_CLEANUP', id: 'b06bddcb-7004-4800-bf8f-d9b99cdb6e23' } },
	res: { type: 'object', properties: { rules: { type: 'array', items: packedNoteCleanupRuleSchema, optional: false, nullable: false }, blocked: { type: 'boolean', optional: false, nullable: false } } },
} as const;

export const paramDef = { type: 'object', properties: {}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: NoteCleanupService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await service.list(me.id); } catch (error) {
				rethrowCleanupError(error, meta.errors.invalidCleanup, meta.errors.cleanupBusy);
			}
		});
	}
}
