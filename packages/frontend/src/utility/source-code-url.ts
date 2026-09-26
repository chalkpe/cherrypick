/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function sourceCodeUrl(repositoryUrl: string | null, gitHash: string): string | null {
	if (repositoryUrl === 'https://github.com/chalkpe/cherrypick' && /^[0-9a-f]{40}$/.test(gitHash)) {
		return `${repositoryUrl}/tree/${gitHash}`;
	}

	return repositoryUrl;
}
