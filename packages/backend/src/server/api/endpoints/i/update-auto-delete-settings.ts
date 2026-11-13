/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { CleanupInputError, NoteCleanupService } from '@/core/NoteCleanupService.js';

export const meta = {
	tags: ['account'],

	requireCredential: true,

	// This setting deletes notes in bulk, so restrict it to the native client like i/truncate-account.
	secure: true,

	kind: 'write:account',

	errors: {
		invalidValue: {
			message: 'Invalid value.',
			code: 'INVALID_VALUE',
			id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
		},
		// 같은 계정의 정리 작업과 겹친 정상 혼잡이므로 잠시 뒤 다시 시도하면 된다.
		cleanupBusy: {
			message: 'Note cleanup is busy. Please try again later.',
			code: 'CLEANUP_BUSY',
			id: 'ef801a30-12f2-4f79-a60d-2a94c8c42302',
			kind: 'server',
			httpStatusCode: 503,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		autoDeleteNotesAfterDays: {
			type: 'number',
			nullable: true,
			minimum: 1,
			maximum: 3650, // 최대 10년
		},
		autoDeleteKeepFavorites: {
			type: 'boolean',
		},
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> {
	constructor(
		private noteCleanupService: NoteCleanupService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const updates: Record<string, any> = {};

			if (ps.autoDeleteNotesAfterDays !== undefined) {
				updates.autoDeleteNotesAfterDays = ps.autoDeleteNotesAfterDays;
			}

			if (ps.autoDeleteKeepFavorites !== undefined) {
				updates.autoDeleteKeepFavorites = ps.autoDeleteKeepFavorites;
			}

			try {
				await this.noteCleanupService.updateLegacy(me.id, updates);
			} catch (error) {
				// 정수가 아닌 일수는 DB 오류(500)가 되기 전에 거부한다.
				if (error instanceof CleanupInputError && error.code === 'INVALID_VALUE') throw new ApiError(meta.errors.invalidValue);
				if (error instanceof CleanupInputError && error.code === 'CLEANUP_BUSY') throw new ApiError(meta.errors.cleanupBusy);
				throw error;
			}

			// Do not return the raw user entity: it contains the native access token.
		});
	}
}
