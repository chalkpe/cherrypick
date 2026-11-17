/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

// 録画変換の入力上限。これを超える入力はデコーダの資源を際限なく使うため、実行前に拒否する。
export const RECORDING_MAX_DURATION_SEC = 4 * 60 * 60;
export const RECORDING_MAX_WIDTH = 1920;
export const RECORDING_MAX_HEIGHT = 1080;

// 録画はあとで見返すための保存なので、ライブ視聴用の高い画質は使わない。
// 720p/15fps・CRF23 で共有画面の文字は読める品質を保ちつつ、1ファイルの容量を抑える。
export const RECORDING_VIDEO_CRF = '23';

export class RecordingOutputLimitError extends Error {
	constructor() {
		super('Recording conversion output exceeded the size limit');
	}
}

export class RecordingInputLimitError extends Error {
	constructor(message: string) {
		super(message);
	}
}

function outputArgs(dst: string, isVideo: boolean): string[] {
	return isVideo
		? ['-vsync', 'vfr', '-enc_time_base:v', '-1', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', RECORDING_VIDEO_CRF, '-af', 'alimiter=limit=0.95', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', dst]
		: ['-vn', '-af', 'alimiter=limit=0.95', '-c:a', 'libmp3lame', '-b:a', '320k', dst];
}

export function recordingConversionArgs(src: string, dst: string, isVideo: boolean): string[] {
	return ['-y', '-v', 'error', '-threads', '2', '-i', src, ...outputArgs(dst, isVideo)];
}

// 여러 임시 조각을 순서대로 이어 붙여 하나의 파일로 만든다. concat demuxer가 타임스탬프를 이어 준다.
export function recordingConcatArgs(listPath: string, dst: string, isVideo: boolean): string[] {
	return ['-y', '-v', 'error', '-threads', '2', '-f', 'concat', '-safe', '0', '-i', listPath, ...outputArgs(dst, isVideo)];
}

export function recordingConcatList(paths: string[]): string {
	return paths.map(p => `file '${p.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}

export function recordingOutputLimitBytes(serverMaxBytes: number, roleMaxFileSizeMb: number): number {
	return Math.min(serverMaxBytes, roleMaxFileSizeMb * 1024 * 1024);
}

// 변환 시간 상한. 실측(720p/15fps, libx264 veryfast 2스레드): 단순 화면 내용 약 580fps,
// 최악 내용(노이즈) 약 75fps, 음성만 mp3 약 320배 속도. 영상은 입력 길이에 비례해 늘리고
// 최악 실측의 2.5배 여유(초당 입력을 2초 만에 인코딩한다고 가정)를 둔다. 음성만은 기본 상한으로 충분하다.
export const RECORDING_CONVERSION_BASE_TIMEOUT_MS = 10 * 60 * 1000;
export const RECORDING_CONVERSION_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const VIDEO_TIMEOUT_SECONDS_PER_INPUT_SECOND = 2;

export function recordingConversionTimeoutMs(durationSec: number, hasVideo: boolean): number {
	if (!hasVideo || !Number.isFinite(durationSec)) return RECORDING_CONVERSION_BASE_TIMEOUT_MS;
	const scaled = RECORDING_CONVERSION_BASE_TIMEOUT_MS + durationSec * VIDEO_TIMEOUT_SECONDS_PER_INPUT_SECOND * 1000;
	// 슬롯 만료 갱신이 이 값을 Redis PEXPIRE에 넘기므로 정수 밀리초로 올림한다
	return Math.min(RECORDING_CONVERSION_MAX_TIMEOUT_MS, Math.max(RECORDING_CONVERSION_BASE_TIMEOUT_MS, Math.ceil(scaled)));
}

export type RecordingProbe = {
	durationSec: number;
	width: number;
	height: number;
	hasAudio: boolean;
	hasVideo: boolean;
};

// 입력 스트림·길이·해상도 한도를 검사한다. 위반이면 명시적 실패로 처리해 원본을 유지한다.
// 길이를 알 수 없는 컨테이너(WebM 등)는 실행 중 출력 바이트 감시가 상한을 보장한다.
export function assertRecordingInput(probe: RecordingProbe, expectVideo: boolean): void {
	if (!probe.hasAudio) throw new RecordingInputLimitError('recording has no audio stream');
	if (expectVideo && !probe.hasVideo) throw new RecordingInputLimitError('recording has no video stream');
	if (Number.isFinite(probe.durationSec) && probe.durationSec > RECORDING_MAX_DURATION_SEC) throw new RecordingInputLimitError('recording is too long');
	if (probe.hasVideo && (probe.width > RECORDING_MAX_WIDTH || probe.height > RECORDING_MAX_HEIGHT)) throw new RecordingInputLimitError('recording resolution is too large');
}

/**
 * ffmpeg を実行しながら出力バイトを 감시한다. 상한을 넘거나 timeout 되면 자식 프로세스를 중단하고 정리한다.
 * 상한 도달은 일부만 쓴 결과를 성공으로 저장하지 않도록 명시적 실패(RecordingOutputLimitError)로 알린다.
 */
export function runRecordingFfmpeg(args: string[], dst: string, limitBytes: number, timeoutMs: number): Promise<{ stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		let settled = false;
		child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 8192) stderr = stderr.slice(-8192); });

		const finish = (err: Error | null) => {
			if (settled) return;
			settled = true;
			clearInterval(watchdog);
			clearTimeout(timer);
			if (err) reject(err); else resolve({ stderr });
		};

		const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };

		const watchdog = setInterval(() => {
			try {
				if (fs.statSync(dst).size > limitBytes) {
					kill();
					finish(new RecordingOutputLimitError());
				}
			} catch { /* output not created yet */ }
		}, 250);

		const timer = setTimeout(() => {
			kill();
			finish(new Error('recording conversion timed out'));
		}, timeoutMs);

		child.on('error', err => finish(err));
		child.on('close', code => {
			if (settled) return;
			if (code === 0) finish(null);
			else finish(new Error(`ffmpeg exited with code ${code}`));
		});
	});
}
