/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DriveDeletionError } from '@/core/DriveDeletionService.js';
import { ApiError } from '@/server/api/error.js';

export const deletionErrors = {
	busy: { message: 'A drive deletion request is already running.', code: 'DELETE_BUSY', id: '94d102da-c32a-4fde-8320-3895ea3c468b' },
	expired: { message: 'The deletion confirmation expired. Prepare and confirm again.', code: 'PLAN_EXPIRED', id: 'c864a77c-371c-44e1-9a3a-a3704d347d40' },
	folder: { message: 'No such folder.', code: 'NO_SUCH_FOLDER', id: '8f7f49d8-a63d-480a-a4cd-7a54b8bb87f1' },
	limit: { message: 'Delete at most 10000 files and 1000 folders at a time.', code: 'TOO_MANY_ITEMS', id: '9a2c01f7-6a99-4275-bda1-89d5fc15f6ea' },
	selection: { message: 'Choose either files or one folder.', code: 'INVALID_SELECTION', id: '86206bf8-8890-4407-ac04-3c90c7a25424' },
} as const;

export async function deletionResult<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof DriveDeletionError) {
			const definition = Object.values(deletionErrors).find(e => e.code === error.code)!;
			throw new ApiError(definition);
		}
		throw error;
	}
}
