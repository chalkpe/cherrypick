/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { i18n } from '@/i18n.js';

export type CleanupFailure = { code: string; path: string };

// API 오류의 info 코드와 조건 경로만 읽고 서버 메시지·참조 ID를 사용자 문구로 사용하지 않는다.
export function cleanupFailure(error: unknown): CleanupFailure {
	const value = error as { code?: unknown; info?: { code?: unknown; path?: unknown } } | null;
	return {
		code: typeof value?.info?.code === 'string' ? value.info.code : typeof value?.code === 'string' ? value.code : '',
		path: typeof value?.info?.path === 'string' ? value.info.path : '',
	};
}

export function cleanupErrorMessage(code: string): string {
	const text = i18n.ts._noteCleanup;
	switch (code) {
		case 'CLEANUP_BUSY': return text.busyError;
		case 'MISSING_CLIP': case 'INVALID_CLIP': return text.missingClipError;
		case 'MISSING_CHANNEL': return text.missingChannelError;
		case 'INVALID_CONDITION': case 'INVALID_VALUE': case 'INVALID_CLEANUP': return text.ruleError;
		case 'INCOMPLETE': return text.incomplete;
		case 'LIMIT': case 'REFERENCE_LIMIT': return text.limitError;
		case 'INVALID_NAME': return text.nameError;
		case 'RULE_LIMIT': return text.ruleLimitError;
		case 'PREVIEW_REQUIRED': return text.previewRequiredError;
		case 'CONFIRMATION_REQUIRED': return text.confirmationError;
		case 'NO_SUCH_RULE': case 'INVALID_RULE_SELECTION': return text.selectionError;
		case 'KEEP_CANNOT_RUN': return text.keepRunError;
		default: return text.requestError;
	}
}

export function canRevealCleanupError(code: string, path: string): boolean {
	return code !== 'CLEANUP_BUSY' && /^(condition(?:\.|$)|\d+(?:\.|$))/.test(path);
}
