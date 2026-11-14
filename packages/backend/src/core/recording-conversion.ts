/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function recordingConversionArgs(src: string, dst: string, isVideo: boolean): string[] {
	const input = ['-y', '-v', 'error', '-threads', '2', '-i', src];
	return isVideo
		? [...input, '-vsync', 'vfr', '-enc_time_base:v', '-1', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-af', 'alimiter=limit=0.95', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', dst]
		: [...input, '-vn', '-af', 'alimiter=limit=0.95', '-c:a', 'libmp3lame', '-b:a', '320k', dst];
}
