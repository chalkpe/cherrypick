/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { globalEvents } from '@/events.js';

export const driveDeletionBusy = ref(false);
type DeleteResult = Misskey.Endpoints['drive/delete/execute']['res'];
type Selection = { fileIds: readonly string[] } | { folderId: string; name: string };

export async function deleteDriveItems(input: Selection): Promise<DeleteResult | null> {
	if (driveDeletionBusy.value) return null;
	driveDeletionBusy.value = true;
	let result: DeleteResult | null = null;
	let operationId: string | undefined;
	let confirmed = false;
	let closeWaiting: (() => void) | undefined;
	const notifiedFiles = new Set<string>();
	const notifiedFolders = new Set<string>();

	function notify(outcome: DeleteResult) {
		const files = [...outcome.deletedIds, ...outcome.missingIds].filter(id => !notifiedFiles.has(id));
		const removedFolders = [...outcome.deletedFolderIds, ...outcome.missingFolderIds];
		const folders = removedFolders.filter(id => !notifiedFolders.has(id));
		for (const id of files) notifiedFiles.add(id);
		for (const id of folders) notifiedFolders.add(id);
		globalEvents.emit('driveFilesDeleted', files.map(id => ({ id })));
		globalEvents.emit('driveFoldersDeleted', folders.map(id => ({ id })));
		if (prefer.s.uploadFolder && removedFolders.includes(prefer.s.uploadFolder)) prefer.commit('uploadFolder', null);
	}

	try {
		closeWaiting = os.waiting();
		let plan: Misskey.Endpoints['drive/delete/prepare']['res'];
		if ('fileIds' in input) {
			if (input.fileIds.length > 10000) {
				closeWaiting();
				closeWaiting = undefined;
				await os.alert({ type: 'error', text: i18n.ts._driveDeletion.tooMany });
				return null;
			}
			plan = await misskeyApi('drive/delete/prepare', { fileIds: [...input.fileIds] });
		} else {
			plan = await misskeyApi('drive/delete/prepare', { folderId: input.folderId });
		}

		operationId = plan.operationId;
		closeWaiting();
		closeWaiting = undefined;
		const { canceled } = await os.confirm({
			type: 'warning',
			title: i18n.ts.delete,
			text: ('fileIds' in input
				? i18n.tsx._driveDeletion.filesConfirm({ count: plan.totalCount })
				: i18n.tsx._driveDeletion.folderConfirm({ name: input.name, count: plan.totalCount })) + '\n\n' + i18n.ts._driveDeletion.scope,
		});
		if (canceled) return null;
		confirmed = true;
		closeWaiting = os.waiting();
		let response: DeleteResult;
		do {
			response = await misskeyApi('drive/delete/execute', { operationId: plan.operationId });
			result = response;
			notify(response);
		} while (!response.done);
		closeWaiting();
		closeWaiting = undefined;
		await os.alert({
			type: response.failedCount > 0 || response.remainingCount > 0 || response.remainingFoldersCount > 0 ? 'warning' : 'success',
			text: resultText(response) + (response.remainingCount > 0 || response.remainingFoldersCount > 0 ? '\n' + i18n.ts._driveDeletion.retry : ''),
		});
		return result;
	} catch (error) {
		closeWaiting?.();
		closeWaiting = undefined;
		if (confirmed && operationId) {
			try {
				const recovered: DeleteResult = await misskeyApi('drive/delete/status', { operationId });
				result = recovered;
				notify(recovered);
			} catch { /* 처리 중이거나 서버에 닿지 않으면 마지막으로 받은 결과만 표시한다. */ }
		}
		if (result?.done) {
			await os.alert({ type: result.failedCount || result.remainingCount || result.remainingFoldersCount ? 'warning' : 'success', text: resultText(result) + (result.remainingCount || result.remainingFoldersCount ? '\n' + i18n.ts._driveDeletion.retry : '') });
			return result;
		}
		const code = (error as { code?: string }).code;
		const text = code === 'TOO_MANY_ITEMS' ? i18n.ts._driveDeletion.tooMany
			: code === 'PLAN_EXPIRED' ? i18n.ts._driveDeletion.expired
				: code === 'DELETE_BUSY' ? i18n.ts._driveDeletion.busy
					: i18n.ts._driveDeletion.interrupted;
		await os.alert({ type: 'error', text: (result ? resultText(result) + '\n' : '') + text });
		return result;
	} finally {
		closeWaiting?.();
		driveDeletionBusy.value = false;
	}
}

function resultText(result: DeleteResult) {
	const messages: string[] = [];
	if (result.deletedCount > 0) messages.push(i18n.tsx._driveDeletion.deletedFiles({ count: result.deletedCount }));
	if (result.deletedFolderIds.length > 0) messages.push(i18n.tsx._driveDeletion.deletedFolders({ count: result.deletedFolderIds.length }));
	if (result.missingCount > 0) messages.push(i18n.tsx._driveDeletion.missingFiles({ count: result.missingCount }));
	if (result.missingFolderIds.length > 0) messages.push(i18n.tsx._driveDeletion.missingFolders({ count: result.missingFolderIds.length }));
	if (result.failedCount > 0) messages.push(i18n.tsx._driveDeletion.failedFiles({ count: result.failedCount }));
	if (result.remainingCount > 0) messages.push(i18n.tsx._driveDeletion.remainingFiles({ count: result.remainingCount }));
	if (result.remainingFoldersCount > 0) messages.push(i18n.tsx._driveDeletion.remainingFolders({ count: result.remainingFoldersCount }));
	return messages.length > 0 ? messages.join('\n') : i18n.ts._driveDeletion.noItemsDeleted;
}
