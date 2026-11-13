/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { runQueueJob } from '@/queue/queue-job-runner.js';
import { TelemetryService } from '@/core/telemetry/TelemetryService.js';

describe('runQueueJob', () => {
	test('returns the processor result without invoking the error handler', async () => {
		let spanActive = false;
		const startSpan = vi.fn(<T>(_name: string, fn: () => T): T => {
			spanActive = true;
			const result = fn();
			if (result instanceof Promise) return result.finally(() => { spanActive = false; }) as T;
			spanActive = false;
			return result;
		});
		const telemetryService = {
			startSpan,
		} as unknown as TelemetryService;
		const onError = vi.fn();

		await expect(runQueueJob(telemetryService, 'Queue: test', () => 'ok', onError)).resolves.toBe('ok');

		expect(onError).not.toHaveBeenCalled();
		expect(spanActive).toBe(false);
	});

	test('handles failures while the processor span is active and rethrows the original error', async () => {
		let spanActive = false;
		const startSpan = vi.fn(<T>(_name: string, fn: () => T): T => {
			spanActive = true;
			const result = fn();
			if (result instanceof Promise) return result.finally(() => { spanActive = false; }) as T;
			spanActive = false;
			return result;
		});
		const telemetryService = {
			startSpan,
		} as unknown as TelemetryService;
		const onError = vi.fn((error: Error) => {
			expect(spanActive).toBe(true);
			expect(error).toBeInstanceOf(Error);
		});
		const originalError = new Error('failed');

		await expect(runQueueJob(telemetryService, 'Queue: test', async () => {
			throw originalError;
		}, onError)).rejects.toBe(originalError);

		expect(onError).toHaveBeenCalledOnce();
		expect(spanActive).toBe(false);
	});
});

test('정상 제어 오류는 span 밖에서 원래 값으로 전달하고 다른 오류는 span 안에서 처리한다', async () => {
	const spanFailures: unknown[] = [];
	let active = false;
	const telemetry = { startSpan: async <T>(_name: string, fn: () => T): Promise<Awaited<T>> => {
		active = true;
		try { return await fn(); } catch (error) { spanFailures.push(error); throw error; } finally { active = false; }
	} } as unknown as TelemetryService;
	const control = new Error('control');
	const onError = vi.fn(() => { expect(active).toBe(true); throw new Error('logger failed'); });
	await expect(runQueueJob(telemetry, 'control', () => { throw control; }, onError, error => error === control)).rejects.toBe(control);
	expect(spanFailures).toEqual([]);
	expect(onError).not.toHaveBeenCalled();
	expect(active).toBe(false);
	const failure = { message: 'non-Error failure' };
	await expect(runQueueJob(telemetry, 'failure', () => { throw failure; }, onError, error => error === control)).rejects.toBe(failure);
	expect(spanFailures).toEqual([failure]);
	expect(onError).toHaveBeenCalledOnce();
	expect(active).toBe(false);
	await expect(runQueueJob(telemetry, 'result', () => undefined, onError)).resolves.toBeUndefined();
});
