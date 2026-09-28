/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Log } from '@google-cloud/logging';
import type { LogBackend } from './LogBackend.js';
import type { AccessLogRecord, LogRecord } from './types.js';

/** Mirrors normalized logs to Google Cloud while preserving the console backend. */
export class CloudLoggingBackend implements LogBackend {
	private readonly pending = new Set<Promise<void>>();

	constructor(private readonly consoleBackend: LogBackend, private readonly cloudLog: Pick<Log, 'entry' | 'write'>) {}

	public write(record: LogRecord): void {
		this.consoleBackend.write(record);
		const severity = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' } as const;
		// Legacy data is unredacted; only normalized attributes and errors may leave the process.
		const { compatibility, context, ...payload } = record;
		const pending = Promise.resolve().then(() => this.cloudLog.entry({
			severity: severity[record.level],
			timestamp: new Date(record.timestamp),
			resource: { type: 'global' },
			labels: { name: record.loggerName },
		}, payload)).then(entry => this.cloudLog.write(entry)).then(() => undefined).catch(() => {
			// Do not log through LogManager here: that would retry the failed destination recursively.
			this.consoleBackend.write({ ...record, level: 'error', message: 'Google Cloud Logging write failed', attributes: undefined, error: undefined, compatibility: undefined });
		}).finally(() => this.pending.delete(pending));
		this.pending.add(pending);
	}

	public writeAccess(record: AccessLogRecord): void {
		this.consoleBackend.writeAccess?.(record);
	}

	public async flush(): Promise<void> {
		while (this.pending.size > 0) await Promise.all(this.pending);
		await this.consoleBackend.flush?.();
	}

	public async close(): Promise<void> {
		await this.flush();
		await this.consoleBackend.close?.();
	}
}
