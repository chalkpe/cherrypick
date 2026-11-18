/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, UserProfilesRepository } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';
import Logger from '@/logger.js';
import { CacheService } from '@/core/CacheService.js';
import { DriveService } from '@/core/DriveService.js';
import { DriveFileUsageService } from '@/core/DriveFileUsageService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';

/**
 * 노트를 지울 때 그 노트에서만 쓰이던 첨부 파일을 드라이브에서도 함께 지운다.
 * 계정 설정(autoDeleteNoteFiles)을 켠 로컬 사용자가 직접 지우는 경우에만 동작한다.
 */
@Injectable()
export class NoteAttachedFileService {
	private logger = new Logger('note-attached-file');

	constructor(
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private cacheService: CacheService,
		private driveService: DriveService,
		private driveFileUsageService: DriveFileUsageService,
		private noteDeleteService: NoteDeleteService,
	) {}

	/**
	 * 설정이 켜져 있는지 확인한다. 꺼져 있다고 알려진 경우는 질의 없이 끝내고,
	 * 켜져 있다고 알려진 경우는 지울 수 없는 파일을 지우지 않도록 DB에서 다시 확인한다.
	 */
	@bindThis
	public async isEnabled(userId: MiUser['id']): Promise<boolean> {
		const cached = await this.cacheService.userProfileCache.fetch(userId).catch(() => null);
		if (cached != null && !cached.autoDeleteNoteFiles) return false;

		const profile = await this.userProfilesRepository.findOne({ where: { userId }, select: { userId: true, autoDeleteNoteFiles: true } });
		return profile?.autoDeleteNoteFiles === true;
	}

	/**
	 * 본인의 의사로 노트를 지운다. 설정이 켜져 있으면 지운 뒤 단독으로 쓰이던 첨부 파일도 지운다.
	 */
	@bindThis
	public async deleteOwnNote(user: MiUser, note: MiNote, options: { keepFiles?: boolean } = {}): Promise<void> {
		// 첨부가 없거나 원격 사용자의 노트면 설정을 조회하지 않고 기존 삭제만 부른다.
		const enabled = !options.keepFiles && user.host == null && note.fileIds.length > 0 && await this.isEnabled(user.id);
		// 답글·인용 노트는 원문을 지워도 함께 지워지지 않고 남으므로(DB의 연쇄 삭제 없음) 지우는 노트 자신의 첨부만 대상으로 삼는다.
		const candidates = enabled ? note.fileIds : [];

		await this.noteDeleteService.delete(user, note);

		if (candidates.length > 0) await this.deleteUnreferenced(user, candidates);
	}

	/**
	 * 노트가 지워진 뒤의 상태를 기준으로, 어디에서도 쓰이지 않는 파일만 지운다.
	 * 파일마다 판정 직후에 바로 지워 판정과 삭제 사이의 간격을 줄인다.
	 * 실패는 기록만 하고 호출자에게 전파하지 않는다.
	 */
	@bindThis
	public async deleteUnreferenced(user: MiUser, fileIds: string[]): Promise<void> {
		for (const fileId of new Set(fileIds)) {
			try {
				const query = this.driveFilesRepository.createQueryBuilder('file').andWhere('file.id = :fileId', { fileId });
				// 드라이브 정리·노트 정리와 같은 '쓰이지 않는 파일' 기준을 쓴다.
				this.driveFileUsageService.applyUnusedFilter(query, user.id);
				const file = await query.getOne();
				if (file == null) continue;

				// 노트 정리와 같은 인자: 만료 삭제가 아니고, 소유자 본인이 지우는 것이므로 모더레이션 로그는 남지 않는다.
				await this.driveService.deleteFile(file, false, user);
			} catch (error) {
				this.logger.error('Failed to delete the file attached to the deleted note', { userId: user.id, fileId, error });
			}
		}
	}
}
