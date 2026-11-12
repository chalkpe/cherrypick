/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export async function runDriveFileBatches(fileIds: readonly string[], action: (ids: string[]) => Promise<unknown>) {
	const snapshot = [...new Set(fileIds)];
	const succeededIds: string[] = [];
	const failedIds: string[] = [];
	for (let i = 0; i < snapshot.length; i += 100) {
		const batch = snapshot.slice(i, i + 100);
		try {
			await action(batch);
			succeededIds.push(...batch);
		} catch {
			failedIds.push(...batch);
		}
	}
	return { succeededIds, failedIds };
}
