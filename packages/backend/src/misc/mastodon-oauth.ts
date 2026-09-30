/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// A persistent namespace keeps OAuth sessions out of legacy token exchange even after Redis expiry.
export const MASTODON_OAUTH_PREFIX = 'mastodon:';
