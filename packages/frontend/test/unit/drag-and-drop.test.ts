/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { checkDragDataType } from '@/drag-and-drop.js';

function dragEvent(types: string[]) {
	return { dataTransfer: { types } } as unknown as DragEvent;
}

describe('checkDragDataType', () => {
	// ブラウザは一度のドラッグに複数の形式を載せる (text/plain など)。先頭だけ見ると、ドライブのファイルを取りこぼす
	test('finds the wanted type anywhere in the list of types, not only first', () => {
		expect(checkDragDataType(dragEvent(['text/plain', 'cherrypick/drivefiles']), ['driveFiles'])).toBe(true);
	});

	test('ignores case, as browsers do for data transfer formats', () => {
		expect(checkDragDataType(dragEvent(['Cherrypick/DriveFiles']), ['driveFiles'])).toBe(true);
	});

	test('answers false without a data transfer or without a matching type', () => {
		expect(checkDragDataType({ dataTransfer: null } as unknown as DragEvent, ['driveFiles'])).toBe(false);
		expect(checkDragDataType(dragEvent(['Files']), ['driveFiles'])).toBe(false);
		expect(checkDragDataType(dragEvent([]), ['driveFiles'])).toBe(false);
	});
});
