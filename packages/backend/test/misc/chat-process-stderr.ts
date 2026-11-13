/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function chatProcessExitError(name: string, code: unknown, signal: unknown, evidenceDir: string): Error {
	let stderr = '';
	try {
		stderr = readFileSync(join(evidenceDir, 'stderr.log'), 'utf8').slice(-16_384).trim();
	} catch {
		// 원래 종료 원인을 stderr 읽기 실패로 덮어쓰지 않는다.
	}
	return new Error(`${name} exited before readiness: ${code}/${signal}${stderr ? `\nchild stderr:\n${stderr}` : ''}`);
}
