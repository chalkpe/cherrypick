/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteCleanupService } from '@/core/NoteCleanupService.js';
import { cleanupDefaultNameSchema, cleanupErrorSchema } from '@/models/json-schema/note-cleanup.js';
import { ruleIdsProperty } from './schema.js';

import { cleanupBusyError, rethrowCleanupError } from './errors.js';

export const meta = {
	tags: ['account'], requireCredential: true, kind: 'read:account',
	limit: { duration: 60000, max: 10 },
	errors: { cleanupBusy: { ...cleanupBusyError, id: '1090e78b-ddc0-4f8d-9ea3-116e5221ab73' }, invalidCleanup: { message: 'Invalid note cleanup request.', code: 'INVALID_CLEANUP', id: '979d5aa6-0f77-46e7-87b4-65cadd72639e' } },
	res: { type: 'object', properties: {
		rules: { type: 'array', optional: false, nullable: false, items: { type: 'object', properties: { id: { type: 'string', optional: false, nullable: false }, name: { type: 'string', optional: false, nullable: false }, defaultName: cleanupDefaultNameSchema, action: { type: 'string', enum: ['keep', 'delete'], optional: false, nullable: false } } } },
		items: { type: 'array', optional: false, nullable: false, items: { type: 'object', properties: {
			noteId: { type: 'string', optional: false, nullable: false }, text: { type: 'string', optional: false, nullable: true }, cw: { type: 'string', optional: false, nullable: true }, createdAt: { type: 'string', optional: false, nullable: false },
			keepRuleIds: { type: 'array', optional: false, nullable: false, items: { type: 'string' } }, deleteRuleIds: { type: 'array', optional: false, nullable: false, items: { type: 'string' } },
			decision: { type: 'string', enum: ['keep', 'delete'], optional: false, nullable: false }, reason: { type: 'string', enum: ['protected', 'unmatched', 'matched', 'blocked'], optional: false, nullable: false },
		} } },
		scanned: { type: 'integer', optional: false, nullable: false }, deleteCount: { type: 'integer', optional: false, nullable: false }, protectedCount: { type: 'integer', optional: false, nullable: false }, nextCursor: { type: 'string', optional: false, nullable: true }, complete: { type: 'boolean', optional: false, nullable: false },
		errors: { type: 'array', optional: false, nullable: false, items: cleanupErrorSchema }, previewToken: { type: 'string', optional: false, nullable: false },
	} },
} as const;

export const paramDef = { type: 'object', properties: { ruleIds: ruleIdsProperty, afterId: { type: 'string', format: 'misskey:id' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }, required: ['ruleIds'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: NoteCleanupService) {
		super(meta, paramDef, async (ps, me) => {
			try { return await service.preview(me.id, ps.ruleIds, ps.afterId, ps.limit); } catch (error) {
				rethrowCleanupError(error, meta.errors.invalidCleanup, meta.errors.cleanupBusy);
			}
		});
	}
}
