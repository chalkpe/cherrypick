/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'vitest';
import { recordingConversionArgs } from '@/core/recording-conversion.js';

function videoTimestamps(file: string, kind: 'packets' | 'frames'): number[] {
	const field = kind === 'packets' ? 'pts_time' : 'best_effort_timestamp_time';
	const probe = JSON.parse(execFileSync('ffprobe', [
		'-v', 'error', '-select_streams', 'v:0', '-show_entries', `${kind === 'packets' ? 'packet' : 'frame'}=${field}`,
		kind === 'packets' ? '-show_packets' : '-show_frames', '-of', 'json', file,
	], { encoding: 'utf8' })) as Record<string, Record<string, string>[]>;
	return probe[kind].map(item => Math.round(Number(item[field]) * 1000)).sort((a, b) => a - b);
}

test('preserves the video frames and timestamps of a variable frame rate recording', () => {
	const src = path.resolve(import.meta.dirname, '../resources/recording-vfr.webm');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-conversion-test-'));
	const dst = path.join(dir, 'converted.mp4');
	try {
		const input = videoTimestamps(src, 'packets');
		expect(input.length).toBeGreaterThan(0);

		execFileSync('ffmpeg', recordingConversionArgs(src, dst, true), { timeout: 60_000 });

		expect(videoTimestamps(dst, 'frames')).toEqual(input);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
