/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource, SelectQueryBuilder } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import DriveFilesEndpoint from '@/server/api/endpoints/drive/files.js';
import { QueryService } from '@/core/QueryService.js';
import type { MiDriveFile } from '@/models/DriveFile.js';

async function listFiles(params: Record<string, unknown>) {
	const dataSource = new DataSource({ type: 'postgres' });
	const query = new SelectQueryBuilder<MiDriveFile>(dataSource).from('drive_file', 'file');
	vi.spyOn(query, 'getMany').mockResolvedValue([]);
	const endpoint = new DriveFilesEndpoint(
		{ createQueryBuilder: () => query } as never,
		{ packMany: async () => [] } as never,
		Object.create(QueryService.prototype) as QueryService,
	);

	await endpoint.exec(params, { id: 'user' } as never, null, null);

	return query.expressionMap.orderBys;
}

describe('drive/files ordering', () => {
	test.each([
		{ sort: '+name', column: 'name', direction: 'DESC' },
		{ sort: '-name', column: 'name', direction: 'ASC' },
		{ sort: '+size', column: 'size', direction: 'DESC' },
		{ sort: '-size', column: 'size', direction: 'ASC' },
	])('preserves $sort at the drive root', async ({ sort, column, direction }) => {
		const order = await listFiles({ sort });

		expect(order).toEqual({ [`file.${column}`]: direction, 'file.id': direction });
	});

	test.each([
		{ params: {}, direction: 'DESC' },
		{ params: { sort: '+createdAt' }, direction: 'DESC' },
		{ params: { sort: '-createdAt' }, direction: 'ASC' },
		{ params: { sinceId: 'cursor' }, direction: 'ASC' },
	])('uses the root-folder index for $params', async ({ params, direction }) => {
		const order = await listFiles(params);

		expect(order).toEqual({ 'file.folderId': direction, 'file.id': direction });
	});

	test('keeps the ID order inside a folder', async () => {
		const order = await listFiles({ folderId: 'folder', sort: '-createdAt' });

		expect(order).toEqual({ 'file.id': 'ASC' });
	});
});
