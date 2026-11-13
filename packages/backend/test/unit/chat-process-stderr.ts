/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chatProcessExitError } from '../misc/chat-process-stderr.js';

test('reports child stderr when it exits before readiness', () => {
	const evidenceDir = mkdtempSync(join(tmpdir(), 'chat-process-stderr-'));
	try {
		writeFileSync(join(evidenceDir, 'stderr.log'), 'configuration file missing\n');

		expect(chatProcessExitError('chat sender', 1, null, evidenceDir).message).toContain('configuration file missing');
		expect(chatProcessExitError('chat sender', 1, null, evidenceDir).message).toContain('chat sender exited before readiness: 1/null');
	} finally {
		rmSync(evidenceDir, { recursive: true, force: true });
	}
});

test('preserves the exit reason when stderr is unavailable', () => {
	const evidenceDir = mkdtempSync(join(tmpdir(), 'chat-process-stderr-'));
	try {
		expect(chatProcessExitError('job worker', 1, null, evidenceDir).message).toContain('job worker exited before readiness: 1/null');
	} finally {
		rmSync(evidenceDir, { recursive: true, force: true });
	}
});
