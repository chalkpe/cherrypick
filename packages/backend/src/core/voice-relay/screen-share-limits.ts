/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type ScreenShareLimits = { maxWidth: number; maxHeight: number; maxFrameRate: number; maxBitrate: number };

export function parseScreenShareLimits(value: unknown): ScreenShareLimits | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const limits = value as Record<string, unknown>;
	const fields = ['maxWidth', 'maxHeight', 'maxFrameRate', 'maxBitrate'] as const;
	if (Object.keys(limits).length !== fields.length) return null;
	for (const field of fields) {
		const number = limits[field];
		if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
	}
	return limits as ScreenShareLimits;
}
