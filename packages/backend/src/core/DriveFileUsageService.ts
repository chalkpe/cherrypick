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

		// チャット
		q.andWhere('NOT EXISTS (SELECT 1 FROM "chat_message" WHERE "chat_message"."fromUserId" = :userId AND "chat_message"."fileIds" @> ARRAY[file.id]::varchar[])');

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

		// チャンネルのバナー (モデレーターは他人のチャンネルのバナーを自分のファイルに差し替えられるので、チャンネルの持ち主では絞らない)
		q.andWhere('NOT EXISTS (SELECT 1 FROM "channel" WHERE "channel"."bannerId" = file.id)');

		// 그룹 아이콘은 소유자의 드라이브 파일을 참조한다.
		q.andWhere('NOT EXISTS (SELECT 1 FROM "chat_room" WHERE "chat_room"."iconId" = file.id)');

		// アバター・バナー
		q.andWhere('NOT EXISTS (SELECT 1 FROM "user" WHERE "user"."id" = :userId AND ("user"."avatarId" = file.id OR "user"."bannerId" = file.id))');

		return q;
	}

	/**
	 * ノートの削除に伴ってファイルを消してよいかを判定するための、より保守的な絞り込み。
	 * applyUnusedFilter の判定に加えて、持ち主以外のレコードや URL・JSON 本文経由の参照も「使用中」とみなす。
	 * 判定が曖昧な参照は使用中として扱い、ファイルを消さない。
	 * @param q alias が `file` の DriveFile クエリビルダー
	 */
	@bindThis
	public applyUnreferencedFilter(q: SelectQueryBuilder<MiDriveFile>, userId: MiUser['id']): SelectQueryBuilder<MiDriveFile> {
		this.applyUnusedFilter(q, userId);

		// 持ち主以外のレコードが ID を保持している場合 (applyUnusedFilter は持ち主のレコードだけを見る)
		q.andWhere('NOT EXISTS (SELECT 1 FROM "note" WHERE "note"."fileIds" @> ARRAY[file.id]::varchar[])');
		q.andWhere('NOT EXISTS (SELECT 1 FROM "note_draft" WHERE "note_draft"."fileIds" @> ARRAY[file.id]::varchar[])');
		q.andWhere('NOT EXISTS (SELECT 1 FROM "note_history" WHERE "note_history"."fileIds" @> ARRAY[file.id]::varchar[])');
		q.andWhere('NOT EXISTS (SELECT 1 FROM "chat_message" WHERE "chat_message"."fileIds" @> ARRAY[file.id]::varchar[])');
		q.andWhere('NOT EXISTS (SELECT 1 FROM "gallery_post" WHERE "gallery_post"."fileIds" @> ARRAY[file.id]::varchar[])');
		q.andWhere('NOT EXISTS (SELECT 1 FROM "user" WHERE "user"."avatarId" = file.id OR "user"."bannerId" = file.id)');
		q.andWhere('NOT EXISTS (SELECT 1 FROM "chat_room" WHERE "chat_room"."iconFileId" = file.id)');

		// ページ: ブロックの種類や入れ子に関わらず、本文・スクリプトのどこかに ID が現れるなら使用中とみなす
		q.andWhere(`NOT EXISTS (
			SELECT 1 FROM "page"
			WHERE "page"."userId" = :userId
			AND (
				"page"."content"::text LIKE '%' || file.id || '%'
				OR "page"."script" LIKE '%' || file.id || '%'
				OR "page"."variables"::text LIKE '%' || file.id || '%'
			)
		)`);

		// URL で参照されうる場所 (絵文字・広告・お知らせ・ロール・アバター装飾・サーバー設定など)
		const urls = 'ARRAY["file"."url", "file"."thumbnailUrl", "file"."webpublicUrl"]::varchar[]';
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "emoji" WHERE "emoji"."originalUrl" = ANY(${urls}) OR "emoji"."publicUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "ad" WHERE "ad"."imageUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "announcement" WHERE "announcement"."imageUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "role" WHERE "role"."iconUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "avatar_decoration" WHERE "avatar_decoration"."url" = ANY(${urls}) OR "avatar_decoration"."rawUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "chat_room" WHERE "chat_room"."iconUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "access_token" WHERE "access_token"."iconUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (SELECT 1 FROM "user" WHERE "user"."avatarUrl" = ANY(${urls}) OR "user"."bannerUrl" = ANY(${urls}))`);
		q.andWhere(`NOT EXISTS (
			SELECT 1 FROM "meta" WHERE ARRAY["meta"."mascotImageUrl", "meta"."bannerUrl", "meta"."backgroundImageUrl", "meta"."logoImageUrl", "meta"."iconUrl",
				"meta"."app192IconUrl", "meta"."app512IconUrl", "meta"."serverErrorImageUrl", "meta"."notFoundImageUrl", "meta"."infoImageUrl", "meta"."youBlockedImageUrl"]::varchar[] && ${urls}
		)`);

		// 클라이언트 설정 (배경 이미지 등을 URL이나 ID로 저장한다). 본인 항목만 검사한다.
		q.andWhere(`NOT EXISTS (
			SELECT 1 FROM "registry_item"
			WHERE "registry_item"."userId" = :userId
			AND ("registry_item"."value"::text LIKE '%' || file.id || '%' OR "registry_item"."value"::text LIKE '%' || "file"."url" || '%')
		)`);

		return q;
	}
}
