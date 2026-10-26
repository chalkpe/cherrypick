/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const postgresRegexSpecialChars = /[\\^$.*+?()[\]{}|]/g;

/**
 * Escape a string so it is treated as a literal by PostgreSQL's regex operators (`~`, `~*`).
 */
export function escapePostgresRegex(s: string): string {
	return s.replace(postgresRegexSpecialChars, '\\$&');
}
