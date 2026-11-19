/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Ref } from 'vue';

export async function translateWithState<T>(
	translation: Ref<T | null>,
	translating: Ref<boolean>,
	request: () => Promise<T>,
): Promise<boolean> {
	if (translation.value != null || translating.value) return false;
	translating.value = true;
	try {
		translation.value = await request();
		return true;
	} catch {
		return false;
	} finally {
		translating.value = false;
	}
}
