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
	errors: { cleanupBusy: { ...cleanupBusyError, id: 'fe6f9d89-c03f-4081-9880-4bb0d2c9a281' }, invalidCleanup: { message: 'Invalid note cleanup request.', code: 'INVALID_CLEANUP', id: '9f330bc0-e13f-4c58-8065-7ff8a9d950e3' } },
	res: { type: 'object', properties: { rule: packedNoteCleanupRuleSchema } },
} as const;

export const paramDef = { type: 'object', properties: { ...ruleInputProperties }, required: ['name', 'action', 'condition'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: NoteCleanupService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await service.save(me.id, ps); } catch (error) {
				rethrowCleanupError(error, meta.errors.invalidCleanup, meta.errors.cleanupBusy);
			}
		});
	}
}
