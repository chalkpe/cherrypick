/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { CloudLoggingBackend } from '@/logging/CloudLoggingBackend.js';
import { LogManager } from '@/logging/LogManager.js';

describe('Google Cloud Logging', () => {
	test('sends normalized records without legacy credentials and drains pending writes', async () => {
		let finish!: () => void;
		const cloudLog = { entry: vi.fn((_metadata, data) => data), write: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
		const consoleBackend = { write: vi.fn() };
		const backend = new CloudLoggingBackend(consoleBackend, cloudLog as never);
		const manager = new LogManager(backend, { isQuiet: () => false });
		manager.write({ level: 'warn', message: 'test', context: [{ name: 'api' }], attributes: { password: 'secret', visible: true }, compatibility: { data: { token: 'legacy-secret' } } });
		await Promise.resolve();
		await Promise.resolve();
		expect(cloudLog.entry.mock.calls[0][0]).toMatchObject({ severity: 'WARNING', labels: { name: 'api' } });
		const payload = cloudLog.entry.mock.calls[0][1];
		expect(payload.attributes).toEqual({ password: '[REDACTED]', visible: true });
		expect(payload).not.toHaveProperty('compatibility');
		let flushed = false;
		const flush = backend.flush().then(() => { flushed = true; });
		await Promise.resolve();
		expect(flushed).toBe(false);
		finish();
		await flush;
		expect(consoleBackend.write).toHaveBeenCalledOnce();
	});

	test('handles transport rejection without recursive remote logging', async () => {
		const cloudLog = { entry: vi.fn((_metadata, data) => data), write: vi.fn().mockRejectedValue(new Error('offline')) };
		const consoleBackend = { write: vi.fn() };
		const backend = new CloudLoggingBackend(consoleBackend, cloudLog as never);
		new LogManager(backend, { isQuiet: () => false }).write({ level: 'error', message: 'test', context: [] });
		await backend.flush();
		expect(cloudLog.write).toHaveBeenCalledOnce();
		expect(consoleBackend.write).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Google Cloud Logging write failed' }));
	});
});
