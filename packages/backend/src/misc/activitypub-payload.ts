/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';

export function activityPubDigest(content: string): string {
	return `SHA-256=${createHash('sha256').update(content).digest('base64')}`;
}

export function serializeActivityPub(activity: unknown): { content: string; digest: string } {
	const content = JSON.stringify(activity);
	return { content, digest: activityPubDigest(content) };
}
