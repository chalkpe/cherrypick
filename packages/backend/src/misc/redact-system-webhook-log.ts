/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const SYSTEM_WEBHOOK_SECRET_KEY = 'secret';

function withoutSecret(value: unknown): unknown {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
	const { [SYSTEM_WEBHOOK_SECRET_KEY]: _secret, ...webhook } = value as Record<string, unknown>;
	return webhook;
}

export function redactSystemWebhookLog(type: string, info: Record<string, unknown>): Record<string, unknown> {
	if (info == null || typeof info !== 'object' || Array.isArray(info)) return info;

	switch (type) {
		case 'createSystemWebhook':
		case 'deleteSystemWebhook':
			return { ...info, webhook: withoutSecret(info.webhook) };
		case 'updateSystemWebhook':
			return { ...info, before: withoutSecret(info.before), after: withoutSecret(info.after) };
		default:
			return info;
	}
}
