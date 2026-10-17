/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, MiClip, MiNote, NotesRepository, UsersRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { ClipService } from '@/core/ClipService.js';
import { DriveService } from '@/core/DriveService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { validateExportedClips } from '@/misc/exported-clips.js';
import type { ExportedClipNote } from '@/misc/exported-clips.js';
import { bindThis } from '@/decorators.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { DbUserImportJobData } from '../types.js';

@Injectable()
export class ImportClipsProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private clipService: ClipService,
		private driveService: DriveService,
		private apNoteService: ApNoteService,
		private noteEntityService: NoteEntityService,
		private userEntityService: UserEntityService,
		private utilityService: UtilityService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('import-clips');
	}

	@bindThis
	public async process(job: Bull.Job<DbUserImportJobData>): Promise<void> {
		this.logger.info(`Importing clips of ${job.data.user.id} ...`);

		const user = await this.usersRepository.findOneBy({ id: job.data.user.id });
		if (user == null || !this.userEntityService.isLocalUser(user)) {
			return;
		}

		const file = await this.driveFilesRepository.findOneBy({ id: job.data.fileId });
		if (file == null) {
			return;
		}

		const clips: unknown = JSON.parse(await this.driveService.readFileAsText(file));
		if (!validateExportedClips(clips)) {
			this.logger.warn('Validation failed');
			return;
		}

		for (const exported of clips) {
			// 同名のクリップがあっても常に新規作成する (エクスポート元のクリップと取り違えないため)
			let clip: MiClip;
			try {
				clip = await this.clipService.create(user, exported.name, false, exported.description ?? null);
			} catch (err) {
				if (err instanceof ClipService.TooManyClipsError) {
					this.logger.warn('Clip limit reached, remaining clips are skipped');
					break;
				}
				throw err;
			}

			for (const clipNote of exported.clipNotes) {
				const label = clipNote.note.uri ?? clipNote.note.id;
				try {
					const note = await this.resolveNote(clipNote.note);
					if (note == null) {
						this.logger.warn(`Note not found, skipped: ${label}`);
						continue;
					}
					if (!(await this.noteEntityService.isVisibleForMe(note, user.id))) {
						this.logger.warn(`Note not visible, skipped: ${label}`);
						continue;
					}
					await this.clipService.addNote(user, clip.id, note.id);
				} catch (err) {
					if (err instanceof ClipService.AlreadyAddedError) continue;
					if (err instanceof ClipService.TooManyClipNotesError) {
						this.logger.warn(`Clip note limit reached, remaining notes of clip ${clip.id} are skipped`);
						break;
					}
					this.logger.warn(`Failed to import note, skipped: ${label} (${err})`);
				}
			}

			this.logger.succ(`Clip created: ${clip.id}`);
		}

		this.logger.succ('Imported');
	}

	/**
	 * エクスポートされたノート情報からこのサーバー上のノートを解決する。
	 * uri があれば ActivityPub id として解決し (ローカル・リモートどちらも可)、
	 * 無ければ同じサーバーから書き出されたローカルノートとみなして id で探す。
	 */
	@bindThis
	private async resolveNote(exportedNote: ExportedClipNote): Promise<MiNote | null> {
		const uri = exportedNote.uri;
		if (uri == null) {
			return await this.notesRepository.findOneBy({ id: exportedNote.id });
		}

		if (!this.utilityService.isFederationAllowedUri(uri)) return null;

		const exist = await this.apNoteService.fetchNote(uri);
		if (exist != null) return exist;

		if (this.utilityService.isUriLocal(uri)) return null;

		return await this.apNoteService.resolveNote(uri);
	}
}
