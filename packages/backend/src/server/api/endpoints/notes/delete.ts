/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import type { UsersRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NoteAttachedFileService } from '@/core/NoteAttachedFileService.js';
import { DI } from '@/di-symbols.js';
import { GetterService } from '@/server/api/GetterService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,

	kind: 'write:notes',

	limit: {
		duration: ms('1hour'),
		max: 300,
		minInterval: ms('1sec'),
	},

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: '490be23f-8c1f-4796-819f-94cb4f9d1630',
		},

		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: 'fe8d7103-0ea8-4ec3-814d-f8b401dc69e9',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		// 삭제 후 편집처럼 첨부 파일을 이어서 쓰는 경우에 true로 보내면 파일 삭제 설정과 관계없이 파일을 남긴다.
		keepFiles: { type: 'boolean', default: false },
	},
	required: ['noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private getterService: GetterService,
		private roleService: RoleService,
		private noteDeleteService: NoteDeleteService,
		private noteAttachedFileService: NoteAttachedFileService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			if (!await this.roleService.isModerator(me) && (note.userId !== me.id)) {
				throw new ApiError(meta.errors.accessDenied);
			}

			// この操作を行うのが投稿者とは限らない(例えばモデレーター)ため
			const author = await this.usersRepository.findOneByOrFail({ id: note.userId });
			if (note.userId === me.id) {
				// 본인이 지우는 경우에만 단독 사용 첨부 파일 삭제 설정을 적용한다.
				await this.noteAttachedFileService.deleteOwnNote(author, note, { keepFiles: ps.keepFiles });
			} else {
				await this.noteDeleteService.delete(author, note, false, me);
			}
		});
	}
}
