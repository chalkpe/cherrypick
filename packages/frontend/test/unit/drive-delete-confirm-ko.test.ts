/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import locales from 'i18n';

vi.mock('@/os.js', () => ({ confirm: vi.fn(), alert: vi.fn(), waiting: () => vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { uploadFolder: null }, commit: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { token: 'unit-token' } }));

import * as os from '@/os.js';
import { updateI18n } from '@/i18n.js';
import { deleteDriveItems } from '@/utility/drive-delete.js';

// 매개변수가 있는 문구의 함수는 처음 쓸 때의 locale 로 만들어져 남으므로, 첫 호출 전에 한국어로 바꾼다.
updateI18n(locales['ko-KR']);

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
});

test.each(['나무', '숲', 'Quarry'])('the Korean folder confirmation keeps particles off the folder name “%s”', async name => {
	fetchMock.mockResponseOnce(JSON.stringify({ operationId: '00000000-0000-0000-0000-000000000000', totalCount: 3 }));
	vi.mocked(os.confirm).mockResolvedValue({ canceled: true });

	await deleteDriveItems({ folderId: 'root', name });

	const text = vi.mocked(os.confirm).mock.calls[0][0].text;
	expect(text).not.toContain('”과');
	expect(text).toContain(`“${name}” 폴더와 모든 하위 폴더(파일 총 3개)를 삭제할까요? 삭제한 폴더와 파일은 복구할 수 없어요.`);
});
