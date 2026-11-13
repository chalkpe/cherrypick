/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Keep absent/unsupported settings absent when relaying older participants. */
export function reportedVoiceStatus(value: { micMuted?: unknown; deafened?: unknown; recording?: unknown }): { micMuted?: boolean; deafened?: boolean; recording?: boolean } {
	return {
		...(typeof value.micMuted === 'boolean' ? { micMuted: value.micMuted } : {}),
		...(typeof value.deafened === 'boolean' ? { deafened: value.deafened } : {}),
		...(typeof value.recording === 'boolean' ? { recording: value.recording } : {}),
	};
}
