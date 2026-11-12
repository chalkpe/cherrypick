/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { DriveDeletionService } from '@/core/DriveDeletionService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { deletionResult } from './common.js';
import { meta as executeMeta, paramDef } from './execute.js';

export { paramDef };
export const meta = {
	...executeMeta,
	description: 'Read your deletion outcomes after a lost execute response without deleting another batch. The owner-bound operation expires one hour after preparation or its latest execution update; status requests do not extend it.',
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private driveDeletionService: DriveDeletionService) {
		super(meta, paramDef, async (ps, me) => deletionResult(() => this.driveDeletionService.status(me, ps.operationId)));
	}
}
