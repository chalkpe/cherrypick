/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CleanupInputError } from '@/core/NoteCleanupService.js';
import { ApiError } from '@/server/api/error.js';

export const cleanupBusyError = {
	message: 'Note cleanup is busy. Please try again later.',
	code: 'CLEANUP_BUSY',
	kind: 'server',
	httpStatusCode: 503,
} as const;

// 같은 계정의 정리가 진행 중이라 잠금을 못 잡은 경우. 서버 전체 혼잡(CLEANUP_BUSY)과 구분해 알린다.
export const cleanupInProgressError = {
	message: 'Note cleanup is in progress. Please try again after it finishes.',
	code: 'CLEANUP_IN_PROGRESS',
	kind: 'server',
	httpStatusCode: 503,
} as const;

// 혼잡만 서버 오류로 분리하고 입력·권한·참조 오류의 세부 정보는 유지한다.
export function rethrowCleanupError(error: unknown, invalidCleanup: ConstructorParameters<typeof ApiError>[0], cleanupBusy: ConstructorParameters<typeof ApiError>[0], cleanupInProgress: ConstructorParameters<typeof ApiError>[0]): never {
	if (error instanceof CleanupInputError) {
		if (error.code === 'CLEANUP_BUSY') throw new ApiError(cleanupBusy);
		if (error.code === 'CLEANUP_IN_PROGRESS') throw new ApiError(cleanupInProgress);
		throw new ApiError(invalidCleanup, { code: error.code, path: error.path, ...(error.referenceId ? { referenceId: error.referenceId } : {}) });
	}
	throw error;
}
