/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { VoiceRelayConsumerService } from '@/core/VoiceRelayConsumerService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
const text = { type: 'string', optional: false, nullable: false } as const;
const flag = { type: 'boolean', optional: false, nullable: false } as const;
const count = { type: 'number', optional: false, nullable: false } as const;
export const meta = {
	tags: ['admin'],
	prohibitMoved: true,
	limit: { duration: 60_000, max: 30 }, requireCredential: true, requireAdmin: true, kind: 'write:admin:meta',
	errors: { failed: { message: 'Could not apply voice relay settings.', code: 'VOICE_RELAY_REQUEST_FAILED', id: '75cc1ac0-334c-4d1a-a34d-6e55c23595cb' } },
	res: { type: 'object', optional: false, nullable: false, properties: {
		providers: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: { id: text, origin: text, enabled: flag, validated: flag } } },
		capacity: { type: 'object', optional: true, nullable: false, properties: { accepting: flag, maxSlots: count, reservedSlots: count, remainingSlots: count, remainingRooms: count } },
	} },
} as const;
export const paramDef = {
	type: 'object', properties: {
		action: { type: 'string', enum: ['list', 'save-provider', 'remove-provider', 'check-provider'] },
		id: { type: 'string', minLength: 1, maxLength: 128 }, origin: { type: 'string', maxLength: 2048 }, secret: { type: 'string', maxLength: 1024 }, enabled: { type: 'boolean' },
	}, required: ['action'],
} as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private consumer: VoiceRelayConsumerService, private logs: ModerationLogService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				let capacity;
				if (ps.action === 'save-provider') {
					if (!ps.origin) throw new ApiError(meta.errors.failed);
					await consumer.saveProvider({ id: ps.id ?? randomUUID(), origin: ps.origin, secret: ps.secret, enabled: ps.enabled ?? true });
				} else if (ps.action === 'remove-provider') {
					if (!ps.id) throw new ApiError(meta.errors.failed); await consumer.removeProvider(ps.id);
				} else if (ps.action === 'check-provider') {
					if (!ps.id) throw new ApiError(meta.errors.failed); capacity = await consumer.checkProvider(ps.id);
				}
				if (ps.action !== 'list') await this.logs.log(me, 'updateServerSettings', { before: null, after: { voiceRelayAction: ps.action, clientOrProviderId: ps.id ?? null } });
				const providers = (await consumer.allProviders()).filter(p => !p.deleted).map(({ id, origin, enabled, validated }) => ({ id, origin, enabled, validated }));
				return { providers, ...(capacity ? { capacity } : {}) };
			} catch (error) { throw new ApiError(meta.errors.failed); }
		});
	}
}
