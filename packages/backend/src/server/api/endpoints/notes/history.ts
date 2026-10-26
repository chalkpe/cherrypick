/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteUpdateService } from '@/core/NoteUpdateService.js';
import { DI } from '@/di-symbols.js';
import { GetterService } from '@/server/api/GetterService.js';
import { MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import type { DriveFilesRepository, MiDriveFile } from '@/models/_.js';
import { NoteHistoryEntityService } from '@/core/entities/NoteHistoryEntityService.js';
import { NoteHistorySerivce } from '@/core/NoteHistoryService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: false,

	stability: 'experimental',

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: '596e916b-c4d7-45f2-9d49-ecbbb99ac1c0',
		},

		contentRestrictedByUser: {
			message: 'Content restricted by user. Please sign in to view.',
			code: 'CONTENT_RESTRICTED_BY_USER',
			id: '644e8a4e-1217-4651-be75-29053a1e77e5',
		},

		contentRestrictedByServer: {
			message: 'Content restricted by server settings. Please sign in to view.',
			code: 'CONTENT_RESTRICTED_BY_SERVER',
			id: 'faac6575-8b98-4668-8a0e-29e0774e7724',
		},
	},
	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'NoteHistory',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
	},
	required: ['noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private noteHistoryEntityService: NoteHistoryEntityService,
		private noteHistoryService: NoteHistorySerivce,
		private getterService: GetterService,
		private noteEntityService: NoteEntityService,
		private noteUpdateService: NoteUpdateService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			// Apply the same visitor restrictions as notes/show in addition to note visibility
			switch (await this.noteUpdateService.checkRevisionsAccess(note, me?.id ?? null)) {
				case 'restrictedByUser': throw new ApiError(meta.errors.contentRestrictedByUser);
				case 'restrictedByServer': throw new ApiError(meta.errors.contentRestrictedByServer);
				case 'invisible': throw new ApiError(meta.errors.noSuchNote);
			}

			// Apply the author's time-based hiding settings (makeNotesHiddenBefore / makeNotesFollowersOnlyBefore)
			const packedNote = await this.noteEntityService.pack(note, me, { skipHide: true });
			if (await this.noteEntityService.shouldHideNote(packedNote, me?.id ?? null)) {
				return [];
			}

			const note_history = await this.noteHistoryService.getHistory(note.id, ps.limit, ps.sinceId, ps.untilId);
			if (!note_history) {
				return [];
			}
			return await this.noteHistoryEntityService.packMany(note_history, note.userHost, me);
		});
	}
}
