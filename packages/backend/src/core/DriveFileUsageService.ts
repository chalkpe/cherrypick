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

		// 下書き・予約投稿 (fileIds に GIN インデックスあり)
		q.andWhere('NOT EXISTS (SELECT 1 FROM "note_draft" WHERE "note_draft"."userId" = :userId AND "note_draft"."fileIds" @> ARRAY[file.id]::varchar[])');

		// ノート編集履歴
		q.andWhere('NOT EXISTS (SELECT 1 FROM "note_history" WHERE "note_history"."userId" = :userId AND "note_history"."fileIds" @> ARRAY[file.id]::varchar[])');

		// チャット (fileId は NULL 可なので NOT IN ではなく NOT EXISTS を使う)
		q.andWhere('NOT EXISTS (SELECT 1 FROM "chat_message" WHERE "chat_message"."fromUserId" = :userId AND "chat_message"."fileId" = file.id)');

		// ギャラリー
		q.andWhere('NOT EXISTS (SELECT 1 FROM "gallery_post" WHERE "gallery_post"."userId" = :userId AND "gallery_post"."fileIds" @> ARRAY[file.id]::varchar[])');

		// ページ: アイキャッチ + 本文の image ブロック (section の children など入れ子も含む)
		q.andWhere(`NOT EXISTS (
			SELECT 1 FROM "page"
			WHERE "page"."userId" = :userId
			AND (
				"page"."eyeCatchingImageId" = file.id
				OR jsonb_path_exists("page"."content", '$.** ? (@.type == "image" && @.fileId == $fid)', jsonb_build_object('fid', file.id))
			)
		)`);

		// チャンネルのバナー
		q.andWhere('NOT EXISTS (SELECT 1 FROM "channel" WHERE "channel"."userId" = :userId AND "channel"."bannerId" = file.id)');

		// アバター・バナー
		q.andWhere('NOT EXISTS (SELECT 1 FROM "user" WHERE "user"."id" = :userId AND ("user"."avatarId" = file.id OR "user"."bannerId" = file.id))');

		return q;
	}
}
