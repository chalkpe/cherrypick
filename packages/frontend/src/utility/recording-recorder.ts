/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const RECORDING_SEGMENT_MAX_BYTES = 100 * 1024 * 1024;

export function recordingSegmentBytes(policyMaxFileSizeMb: number, serverMaxFileSize: number): number {
	return Math.min(RECORDING_SEGMENT_MAX_BYTES, serverMaxFileSize, policyMaxFileSizeMb * 1024 * 1024);
}

/** 각 파일은 자신의 recorder가 종료된 뒤에만 내보낸다. */
export function createRecordingSegments(stream: MediaStream, options: MediaRecorderOptions, segmentBytes: number, handlers: {
	onSegment: (blob: Blob, index: number) => void;
	onStop: () => void;
	onError: (error: unknown) => void;
}): { stop: () => void } {
	const tracks = stream.getTracks().map(track => track.clone());
	const recorderStream = new MediaStream(tracks);
	const recorders = new Set<MediaRecorder>();
	let current: MediaRecorder | null = null;
	let stopping = false;
	let segmentIndex = 0;
	let errorReported = false;

	function releaseTracks(): void {
		for (const track of tracks) track.stop();
	}

	function reportError(error: unknown): void {
		if (errorReported) return;
		errorReported = true;
		handlers.onError(error);
	}

	function stop(): void {
		if (stopping) return;
		stopping = true;
		for (const recorder of recorders) {
			if (recorder.state === 'inactive') continue;
			try {
				recorder.stop();
			} catch (error) {
				// 원본 입력은 호출자가 소유한다. 실패한 recorder의 복제 트랙만 끝낸다.
				releaseTracks();
				reportError(error);
			}
		}
	}

	function startSegment(): void {
		const recorder = new MediaRecorder(recorderStream, options);
		const index = ++segmentIndex;
		const chunks: Blob[] = [];
		let bytes = 0;
		let largestChunk = 0;
		recorder.ondataavailable = event => {
			if (event.data.size === 0) return;
			chunks.push(event.data);
			bytes += event.data.size;
			largestChunk = Math.max(largestChunk, event.data.size);
			if (bytes + 2 * largestChunk <= segmentBytes || stopping || current !== recorder) return;
			try {
				// 다음 recorder를 먼저 시작해 파일 사이의 캡처 공백을 피한다.
				startSegment();
				recorder.stop();
			} catch (error) {
				stop();
				reportError(error);
			}
		};
		recorder.onstop = () => {
			if (chunks.length > 0) {
				const type = chunks.find(chunk => chunk.type !== '')?.type || recorder.mimeType;
				handlers.onSegment(new Blob(chunks, { type }), index);
			}
			recorders.delete(recorder);
			if (current === recorder) {
				current = null;
				stopping = true;
			}
			if (recorders.size === 0) {
				releaseTracks();
				handlers.onStop();
			}
		};
		recorder.onerror = event => {
			stop();
			reportError(event);
		};
		recorder.start(1_000);
		recorders.add(recorder);
		current = recorder;
	}

	try {
		startSegment();
	} catch (error) {
		releaseTracks();
		throw error;
	}
	return { stop };
}
