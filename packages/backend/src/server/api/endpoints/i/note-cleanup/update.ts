/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteCleanupService } from '@/core/NoteCleanupService.js';
import { packedNoteCleanupRuleSchema } from '@/models/json-schema/note-cleanup.js';
import { ruleInputProperties } from './schema.js';

import { cleanupBusyError, rethrowCleanupError } from './errors.js';

export const meta = {
	tags: ['account'], requireCredential: true, kind: 'write:account', secure: true,
	limit: { duration: 60000, max: 60 },
	errors: { cleanupBusy: { ...cleanupBusyError, id: 'f58fa150-0c99-4416-9c72-ae49f6f673a7' }, invalidCleanup: { message: 'Invalid note cleanup request.', code: 'INVALID_CLEANUP', id: 'c6ac9f09-85b7-4a75-ba40-fca6384d3795' } },
	res: { type: 'object', properties: { rule: packedNoteCleanupRuleSchema } },
} as const;

export const paramDef = { type: 'object', properties: { ...ruleInputProperties, ruleId: { type: 'string', format: 'misskey:id' } }, required: ['action', 'condition', 'ruleId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: NoteCleanupService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await service.save(me.id, ps, ps.ruleId); } catch (error) {
				rethrowCleanupError(error, meta.errors.invalidCleanup, meta.errors.cleanupBusy);
			}
		});
	}
}
