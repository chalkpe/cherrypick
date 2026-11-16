/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { PreferencesManager } from '@/preferences/manager.js';

vi.mock('@/os.js', () => ({}));

test('푸시용 설정 조회는 다른 계정의 덮어쓰기와 공통 설정을 구분하며 현재 계정을 바꾸지 않는다', async () => {
	const manager = new PreferencesManager({ load: () => null, save: () => {}, cloudGet: async () => null, cloudGetBulk: async () => ({}), cloudSet: async () => {} }, { id: 'alice' });
	await manager.cloudReady;
	manager.commit('showAvatarDecorations', false);
	manager.setAccountOverride('showAvatarDecorations');
	manager.commit('showAvatarDecorations', true);

	expect(manager.getMatchedRecordOf('showAvatarDecorations', { id: 'bob' })[1]).toBe(false);
	expect(manager.getMatchedRecordOf('showAvatarDecorations', { id: 'alice' })[1]).toBe(true);
	expect(manager.s.showAvatarDecorations).toBe(true);
});
