/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'vitest';
import {
	recordingConversionArgs, runRecordingFfmpeg, RecordingOutputLimitError,
	recordingConversionTimeoutMs, recordingTempOutputLimitBytes,
	RECORDING_CONVERSION_BASE_TIMEOUT_MS, RECORDING_CONVERSION_MAX_TIMEOUT_MS,
} from '@/core/recording-conversion.js';

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

test('scales the conversion timeout with the input length for video, keeps the base for audio', () => {
	expect(recordingConversionTimeoutMs(60, false)).toBe(RECORDING_CONVERSION_BASE_TIMEOUT_MS);
	expect(recordingConversionTimeoutMs(NaN, true)).toBe(RECORDING_CONVERSION_BASE_TIMEOUT_MS);
	expect(recordingConversionTimeoutMs(60, true)).toBe(RECORDING_CONVERSION_BASE_TIMEOUT_MS + 120_000);
	// 15분짜리 최악 내용 녹화(실측 약 12분 변환)가 10분 상한에 걸리지 않는다
	expect(recordingConversionTimeoutMs(900, true)).toBeGreaterThanOrEqual(15 * 60_000);
	expect(recordingConversionTimeoutMs(4 * 60 * 60, true)).toBe(RECORDING_CONVERSION_MAX_TIMEOUT_MS);
});

test('kills the conversion and reports when it runs past the timeout', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-conversion-test-'));
	const src = path.join(dir, 'noise.mp4');
	const dst = path.join(dir, 'converted.mp4');
	try {
		execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=size=1280x720:rate=15,geq=random(1)*255:128:128', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-c:a', 'aac', src], { timeout: 60_000 });

		// 3초 노이즈 인코딩은 이 러너에서 ~1초 이상 걸린다. 500ms 상한이면 중단되어야 한다.
		await expect(runRecordingFfmpeg(recordingConversionArgs(src, dst, true), dst, 1024 * 1024 * 1024, 500))
			.rejects.toThrow('timed out');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('bounds the temporary output by the server file size setting', () => {
	expect(recordingTempOutputLimitBytes(250 * 1024 * 1024)).toBe(1024 * 1024 * 1024);
	expect(recordingTempOutputLimitBytes(10 * 1024 * 1024 * 1024)).toBe(8 * 1024 * 1024 * 1024);
});

test('kills the conversion and reports when the output grows past the limit while running', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-conversion-test-'));
	const src = path.join(dir, 'noise.mp4');
	const dst = path.join(dir, 'converted.mp4');
	try {
		// 노이즈는 인코딩이 느려 감시 주기가 돌 만큼 실행된다. 출력은 한도를 크게 넘는다.
		execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=size=1280x720:rate=15,geq=random(1)*255:128:128', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-c:a', 'aac', src], { timeout: 60_000 });

		await expect(runRecordingFfmpeg(recordingConversionArgs(src, dst, true), dst, 1024, 60_000))
			.rejects.toBeInstanceOf(RecordingOutputLimitError);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
