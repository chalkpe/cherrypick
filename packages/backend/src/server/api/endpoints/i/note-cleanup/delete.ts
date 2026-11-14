/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteCleanupService } from '@/core/NoteCleanupService.js';

import { cleanupBusyError, rethrowCleanupError } from './errors.js';

export const meta = {
	tags: ['account'], requireCredential: true, kind: 'write:account', secure: true,
	limit: { duration: 60000, max: 60 },
	errors: { cleanupBusy: { ...cleanupBusyError, id: 'ad64353e-fcb0-4061-bdd4-6589cae6244f' }, invalidCleanup: { message: 'Invalid note cleanup request.', code: 'INVALID_CLEANUP', id: '4367d196-e109-4029-b458-a746aaa8e5cb' } },
} as const;

export const paramDef = { type: 'object', properties: { ruleId: { type: 'string', format: 'misskey:id' } }, required: ['ruleId'] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(service: NoteCleanupService) {
		super(meta, paramDef, async (ps, me) => {
			try { await service.remove(me.id, ps.ruleId); } catch (error) {
				rethrowCleanupError(error, meta.errors.invalidCleanup, meta.errors.cleanupBusy);
			}
		});
	}
}
