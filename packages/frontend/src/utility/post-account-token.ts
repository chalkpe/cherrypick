/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getAccounts } from '@/accounts.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';

export function getPostAccountToken(accountId: string | undefined): string | null | undefined {
	if (accountId == null) return undefined;

	const token = getAccounts().find(account => account.id === accountId)?.token;
	if (token == null) {
		os.alert({
			type: 'error',
			text: 'cannot find the token of the selected account.',
		});
		return null;
	}
	return token;
}

export async function getStoredPostAccount(accountId: string) {
	const savedAccount = getAccounts().find(account => account.id === accountId);
	if (savedAccount?.token == null) return null;
	if (savedAccount.user?.id === accountId) return savedAccount.user;

	const account = await misskeyApi('i', {}, savedAccount.token).catch(() => null);
	return account?.id === accountId ? account : null;
}
