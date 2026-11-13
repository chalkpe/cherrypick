/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TelemetryService } from '@/core/telemetry/TelemetryService.js';

type QueueTelemetryService = Pick<TelemetryService, 'startSpan'>;

/** Queueのprocessorを実行し、失敗処理をSpan内で行います。 */
export async function runQueueJob<T>(
	telemetryService: QueueTelemetryService,
	spanName: string,
	processJob: () => T | Promise<T>,
	onError: (error: Error) => void,
	isExpectedControlError?: (error: unknown) => boolean,
): Promise<T> {
	const result = await telemetryService.startSpan(spanName, async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
		try {
			return { ok: true, value: await processJob() };
		} catch (error) {
			// 정상 지연은 span 안에서 성공으로 마치고, span이 닫힌 뒤 BullMQ에 원래 제어 오류를 전달한다.
			if (isExpectedControlError?.(error)) return { ok: false, error };
			// 失敗イベントを待たず、processor Spanがactiveな間にログと通知を行います。
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			try {
				onError(normalizedError);
			} catch {
				// 失敗ログの処理が例外を投げても、Queueへは元のエラーを返します。
			}
			throw error;
		}
	});
	if (!result.ok) throw result.error;
	return result.value;
}
