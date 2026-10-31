/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'cherrypick-js';

type DragDataMap = {
	driveFiles: Misskey.entities.DriveFile[];
	driveFolders: Misskey.entities.DriveFolder[];
	deckColumn: string;
	MkDraggable: { item: { id: string }; instanceId: string; group: string; };
};

// NOTE: dataTransfer の format は大文字小文字区別されないっぽいので toLowerCase が必要

export function setDragData<T extends keyof DragDataMap>(
	event: DragEvent,
	type: T,
	data: DragDataMap[T],
) {
	if (event.dataTransfer == null) return;

	event.dataTransfer.setData(`cherrypick/${type}`.toLowerCase(), JSON.stringify(data));
}

export function setPlainDragData(
	event: DragEvent,
	data: string,
) {
	if (event.dataTransfer == null) return;

	event.dataTransfer.setData('text/plain', data);
}

export function getDragData<T extends keyof DragDataMap>(
	event: DragEvent,
	type: T,
): DragDataMap[T] | null {
	if (event.dataTransfer == null) return null;

	const data = event.dataTransfer.getData(`cherrypick/${type}`.toLowerCase());
	if (data == null || data === '') return null;

	return JSON.parse(data);
}

export function getPlainDragData(
	event: DragEvent,
): string | null {
	if (event.dataTransfer == null) return null;

	const data = event.dataTransfer.getData('text/plain');
	if (data == null || data === '') return null;

	return data;
}

export function checkDragDataType(
	event: DragEvent,
	types: (keyof DragDataMap)[],
): boolean {
	if (event.dataTransfer == null) return false;

	// ブラウザは一度のドラッグに複数の形式を載せる (text/plain など) ので、先頭だけでなく全部を見る
	const wanted = types.map((type) => `cherrypick/${type}`.toLowerCase());
	return Array.from(event.dataTransfer.types).some((dataType) => wanted.includes(dataType.toLowerCase()));
}
