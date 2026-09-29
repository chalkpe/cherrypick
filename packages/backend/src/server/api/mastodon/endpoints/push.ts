/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { AuthenticateService } from '@/server/api/AuthenticateService.js';
import { getAccessToken } from '@/server/api/mastodon/MastodonClientService.js';
import { MastodonPushService, PUSH_ALERT_TYPES, PUSH_POLICIES } from '@/server/api/mastodon/MastodonPushService.js';
import type { MastodonPushSubscription, PushPolicy } from '@/server/api/mastodon/MastodonPushService.js';
import type { MiLocalUser } from '@/models/User.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type Body = Record<string, unknown>;

/**
 * Reads a parameter from a nested JSON body, or from a flat form body such as "subscription[keys][auth]".
 */
function param(body: Body, path: string[]): unknown {
	let nested: unknown = body;
	for (const key of path) {
		nested = nested != null && typeof nested === 'object' ? (nested as Body)[key] : undefined;
	}
	if (nested !== undefined) return nested;
	return body[path[0] + path.slice(1).map(k => `[${k}]`).join('')];
}

function toBool(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return !['0', 'f', 'F', 'false', 'FALSE', 'off', 'OFF', ''].includes(value);
	return undefined;
}

function parseAlerts(body: Body, current: MastodonPushSubscription['alerts']): MastodonPushSubscription['alerts'] {
	const alerts = { ...current };
	for (const type of PUSH_ALERT_TYPES) {
		const value = toBool(param(body, ['data', 'alerts', type]));
		if (value !== undefined) alerts[type] = value;
	}
	return alerts;
}

function parsePolicy(body: Body, current: PushPolicy): PushPolicy {
	// Mastodon reads data[policy]; some clients send it at the top level
	const value = param(body, ['data', 'policy']) ?? body.policy;
	return typeof value === 'string' && (PUSH_POLICIES as readonly string[]).includes(value) ? value as PushPolicy : current;
}

@Injectable()
export class ApiPushMastodon {
	constructor(
		private readonly authenticateService: AuthenticateService,
		private readonly pushService: MastodonPushService,
	) {}

	/**
	 * Push subscriptions belong to an OAuth access token, so a signed-in app is required.
	 */
	private async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<{ me: MiLocalUser; accessTokenId: string } | null> {
		const [me, token] = await this.authenticateService.authenticate(getAccessToken(request));
		if (me == null || token == null) {
			reply.code(401).send({ error: 'The access token is invalid' });
			return null;
		}
		return { me, accessTokenId: token.id };
	}

	private render(subscription: MastodonPushSubscription, serverKey: string) {
		return {
			id: subscription.id,
			endpoint: subscription.endpoint,
			standard: subscription.standard,
			alerts: Object.fromEntries(PUSH_ALERT_TYPES.map(type => [type, subscription.alerts[type] ?? false])),
			server_key: serverKey,
			policy: subscription.policy,
		};
	}

	public register(fastify: FastifyInstance): void {
		fastify.post<{ Body?: Body }>('/v1/push/subscription', async (request, reply) => {
			const auth = await this.authenticate(request, reply);
			if (auth == null) return;

			const serverKey = this.pushService.serverKey;
			if (serverKey == null) return reply.code(422).send({ error: 'Push notifications are not available on this server' });

			const body = request.body ?? {};
			const endpoint = param(body, ['subscription', 'endpoint']);
			const p256dh = param(body, ['subscription', 'keys', 'p256dh']);
			const authKey = param(body, ['subscription', 'keys', 'auth']);
			if (typeof endpoint !== 'string' || !URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:') {
				return reply.code(422).send({ error: 'Validation failed: Endpoint must be an HTTPS URL' });
			}
			if (typeof p256dh !== 'string' || typeof authKey !== 'string') {
				return reply.code(422).send({ error: 'Validation failed: Keys are missing' });
			}

			// Creating a subscription replaces the previous one of the same token
			const subscription = await this.pushService.save({
				userId: auth.me.id,
				accessTokenId: auth.accessTokenId,
				endpoint,
				p256dh,
				auth: authKey,
				standard: toBool(param(body, ['subscription', 'standard'])) ?? false,
				alerts: parseAlerts(body, {}),
				policy: parsePolicy(body, 'all'),
			});

			return reply.send(this.render(subscription, serverKey));
		});

		fastify.get('/v1/push/subscription', async (request, reply) => {
			const auth = await this.authenticate(request, reply);
			if (auth == null) return;

			const serverKey = this.pushService.serverKey;
			const subscription = await this.pushService.get(auth.accessTokenId);
			if (subscription == null || serverKey == null) return reply.code(404).send({ error: 'Record not found' });

			return reply.send(this.render(subscription, serverKey));
		});

		fastify.put<{ Body?: Body }>('/v1/push/subscription', async (request, reply) => {
			const auth = await this.authenticate(request, reply);
			if (auth == null) return;

			const serverKey = this.pushService.serverKey;
			const current = await this.pushService.get(auth.accessTokenId);
			if (current == null || serverKey == null) return reply.code(404).send({ error: 'Record not found' });

			const body = request.body ?? {};
			const subscription = await this.pushService.save({
				...current,
				alerts: parseAlerts(body, current.alerts),
				policy: parsePolicy(body, current.policy),
			});

			return reply.send(this.render(subscription, serverKey));
		});

		fastify.delete('/v1/push/subscription', async (request, reply) => {
			const auth = await this.authenticate(request, reply);
			if (auth == null) return;

			await this.pushService.remove(auth.me.id, auth.accessTokenId);
			return reply.send({});
		});
	}
}

