/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URL } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiNoteDeleteDelivery } from '@/models/NoteDeleteDelivery.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DeliverQueue } from '@/core/QueueModule.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:queue',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'array',
			optional: false, nullable: false,
			prefixItems: [
				{
					type: 'string',
				},
				{
					type: 'number',
				},
			],
			unevaluatedItems: false,
		},
		example: [[
			'example.com',
			12,
		]],
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
		@Inject('queue:deliver') public deliverQueue: DeliverQueue,
		@Inject(DI.db) private db: DataSource,

		private apiLoggerService: ApiLoggerService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const jobs = await this.deliverQueue.getJobs(['delayed']);

			const counts = new Map<string, number>();

			for (const job of jobs) {
				let host: string;
				try {
					const endpoint = 'to' in job.data ? job.data.to : (await this.db.getRepository(MiNoteDeleteDelivery).findOneBy(job.data.noteDeleteDelivery))?.endpoint;
					if (!endpoint) continue;
					host = new URL(endpoint).host;
				} catch (e) {
					this.apiLoggerService.logger.warn(`failed to parse url in ${job.id}: ${e}`);
					this.apiLoggerService.logger.warn(`id: ${job.id}, data: ${JSON.stringify(job.data)}`);
					continue;
				}

				counts.set(host, (counts.get(host) ?? 0) + 1);
			}

			const res = [...counts.entries()].sort((a, b) => b[1] - a[1]);

			return res;
		});
	}
}
