/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';

/**
 * ドライブファイルがどこから参照されているかを判定するサービス。
 * 参照元が増えたらここだけを直す。
 */
@Injectable()
export class DriveFileUsageService {
	/**
	 * 指定ユーザーのファイルのうち、どこからも参照されていないものだけに絞り込む。
	 * @param q alias が `file` の DriveFile クエリビルダー
	 */
	@bindThis
	public applyUnusedFilter(q: SelectQueryBuilder<MiDriveFile>, userId: MiUser['id']): SelectQueryBuilder<MiDriveFile> {
		q.andWhere('file.userId = :userId', { userId });

		// ノート (fileIds に GIN インデックスあり)
		q.andWhere('NOT EXISTS (SELECT 1 FROM "note" WHERE "note"."userId" = :userId AND "note"."fileIds" @> ARRAY[file.id]::varchar[])');

		return q;
	}
}
