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
		case 'CLEANUP_IN_PROGRESS': return text.inProgressError;
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

// 혼잡 오류(서버 전체 상한·같은 계정 정리 진행 중)는 바로 다시 누르는 버튼을 두지 않는다. 다시 시도는 다른 오류에만 둔다.
export function isCleanupBusyError(code: string): boolean {
	return code === 'CLEANUP_BUSY' || code === 'CLEANUP_IN_PROGRESS';
}

// 조건 구역에 보일 오류: 조건 자체의 문제(미완성·이동/참조 한도·잘못된 조건·사라진 참조)만 해당한다.
// 혼잡·이름·규칙 개수 한도·미리보기 필요 등 조건과 무관한 오류는 대화상자로 알린다.
export function isConditionCleanupError(code: string, path: string): boolean {
	if (['INCOMPLETE', 'LIMIT', 'REFERENCE_LIMIT', 'INVALID_CONDITION', 'MISSING_CLIP', 'INVALID_CLIP', 'MISSING_CHANNEL'].includes(code)) return true;
	if (['CLEANUP_BUSY', 'CLEANUP_IN_PROGRESS', 'INVALID_NAME', 'RULE_LIMIT', 'PREVIEW_REQUIRED', 'CONFIRMATION_REQUIRED', 'KEEP_CANNOT_RUN', 'NO_SUCH_RULE', 'INVALID_RULE_SELECTION'].includes(code)) return false;
	// 코드를 읽지 못한 일반 실패는 조건과 무관하다.
	if (!code) return false;
	// 그 밖에 서버가 조건 경로로 알려주는 오류는 조건 문제로 본다.
	return /^(condition(?:\.|$)|\d+(?:\.|$))/.test(path);
}

export function canRevealCleanupError(code: string, path: string): boolean {
	return isConditionCleanupError(code, path) && /^(condition(?:\.|$)|\d+(?:\.|$))/.test(path);
}
