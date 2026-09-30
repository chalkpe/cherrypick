/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';
import type { MiChannel, MiNote, NoteFavoritesRepository, NotesRepository, NoteThreadMutingsRepository, UserNotePiningsRepository } from '@/models/_.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import { ApiError } from '../error.js';

/**
 * Utility service for accessing data with Mastodon semantics
 */
@Injectable()
export class MastodonDataService {
	constructor(
		@Inject(DI.notesRepository)
		private readonly notesRepository: NotesRepository,

		@Inject(DI.noteFavoritesRepository)
		private readonly noteFavoritesRepository: NoteFavoritesRepository,

		@Inject(DI.userNotePiningsRepository)
		private readonly userNotePiningsRepository: UserNotePiningsRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private readonly noteThreadMutingsRepository: NoteThreadMutingsRepository,

		@Inject(QueryService)
		private readonly queryService: QueryService,

		private readonly cacheService: CacheService,
		private readonly idService: IdService,
	) {}

	/**
	 * Fetches a note in the context of the current user, and throws an exception if not found.
	 */
	public async requireNote<Rel extends NoteRelations = NoteRelations>(noteId: string, me: MiLocalUser | null | undefined, relations?: Rel): Promise<NoteWithRelations<Rel>> {
		const note = await this.getNote(noteId, me, relations);

		if (!note) {
			throw new ApiError({
				message: 'No such note.',
				code: 'NO_SUCH_NOTE',
				id: '24fcbfc6-2e37-42b6-8388-c29b3861a08d',
				kind: 'client',
				httpStatusCode: 404,
			});
		}

		return note;
	}

	/**
	 * Fetches a note in the context of the current user.
	 */
	public async getNote<Rel extends NoteRelations = NoteRelations>(noteId: string, me: MiLocalUser | null | undefined, relations?: Rel): Promise<NoteWithRelations<Rel> | null> {
		// Root query: note + required dependencies
		const query = this.notesRepository
			.createQueryBuilder('note')
			.where('note.id = :noteId', { noteId });

		// Load relations
		if (relations) {
			if (relations.reply) {
				query.leftJoinAndSelect('note.reply', 'reply');
				if (typeof(relations.reply) === 'object') {
					if (relations.reply.reply) query.leftJoinAndSelect('reply.reply', 'replyReply');
					if (relations.reply.renote) query.leftJoinAndSelect('reply.renote', 'replyRenote');
					if (relations.reply.user) query.leftJoinAndSelect('reply.user', 'replyUser');
					if (relations.reply.channel) query.leftJoinAndSelect('reply.channel', 'replyChannel');
				}
			}
			if (relations.renote) {
				query.leftJoinAndSelect('note.renote', 'renote');
				if (typeof(relations.renote) === 'object') {
					if (relations.renote.reply) query.leftJoinAndSelect('renote.reply', 'renoteReply');
					if (relations.renote.renote) query.leftJoinAndSelect('renote.renote', 'renoteRenote');
					if (relations.renote.user) query.leftJoinAndSelect('renote.user', 'renoteUser');
					if (relations.renote.channel) query.leftJoinAndSelect('renote.channel', 'renoteChannel');
				}
			}
			if (relations.user) {
				query.innerJoinAndSelect('note.user', 'user');
			}
			if (relations.channel) {
				query.leftJoinAndSelect('note.channel', 'channel');
			}
		}

		// Restrict visibility
		this.queryService.generateVisibilityQuery(query, me);
		if (me) {
			this.queryService.generateBlockedUserQueryForNotes(query, me);
		}

		return await query.getOne() as NoteWithRelations<Rel> | null;
	}

	/**
	 * Whether the content of a note is hidden from the current user by a setting of its author:
	 * signed-in viewers only, notes hidden after a while, or notes limited to followers after a while.
	 * The visibility query of getNote does not know these, so this must mirror NoteEntityService.shouldHideNote for them.
	 */
	public async isContentHidden(
		note: Pick<MiNote, 'id' | 'userId' | 'visibility' | 'replyUserId' | 'mentions'>,
		author: Pick<MiUser, 'requireSigninToViewContents' | 'makeNotesHiddenBefore' | 'makeNotesFollowersOnlyBefore'>,
		me: MiLocalUser | null | undefined,
	): Promise<boolean> {
		if (me?.id === note.userId) return false;
		if (author.requireSigninToViewContents && me == null) return true;

		const createdAt = this.idService.parse(note.id).date;
		if (shouldHideNoteByTime(author.makeNotesHiddenBefore, createdAt)) return true;

		if ((note.visibility === 'public' || note.visibility === 'home') && shouldHideNoteByTime(author.makeNotesFollowersOnlyBefore, createdAt)) {
			if (me == null) return true;
			if (note.replyUserId === me.id || note.mentions.includes(me.id)) return false;
			const followings = await this.cacheService.userFollowingsCache.fetch(me.id);
			return !Object.hasOwn(followings, note.userId);
		}

		return false;
	}

	/**
	 * ID of the pure renote of a note by the current user, if any.
	 */
	public async findReblogId(noteId: string, me: MiLocalUser): Promise<string | null> {
		const reblog = await this.notesRepository.findOne({
			select: { id: true },
			where: { userId: me.id, renoteId: noteId, text: IsNull(), cw: IsNull(), replyId: IsNull(), hasPoll: false, fileIds: '{}' },
		});
		return reblog?.id ?? null;
	}

	/**
	 * Checks where the current user has made a reblog / boost / pure renote of a given target note.
	 */
	public async hasReblog(noteId: string, me: MiLocalUser | null | undefined): Promise<boolean> {
		if (!me) return false;

		return await this.notesRepository.existsBy({
			// Reblog of the target note by me
			userId: me.id,
			renoteId: noteId,

			// That is pure (not a quote)
			text: IsNull(),
			cw: IsNull(),
			replyId: IsNull(),
			hasPoll: false,
			fileIds: '{}',
		});
	}

	/**
	 * Number of pure renotes of a note. Misskey's renoteCount also counts quotes, which Mastodon counts separately.
	 */
	public async countPureRenotes(noteId: string): Promise<number> {
		return await this.notesRepository.countBy({
			renoteId: noteId,
			text: IsNull(),
			cw: IsNull(),
			replyId: IsNull(),
			hasPoll: false,
			fileIds: '{}',
		});
	}

	/**
	 * State of a note for the current user, as Mastodon statuses report it:
	 * bookmarked (a Misskey favorite), pinned to the user's own profile, and in a muted thread.
	 */
	public async getNoteState(note: Pick<MiNote, 'id' | 'userId' | 'threadId'>, me: MiLocalUser | null | undefined): Promise<{ bookmarked: boolean, pinned: boolean, muted: boolean }> {
		if (!me) return { bookmarked: false, pinned: false, muted: false };

		const [bookmarked, pinned, muted] = await Promise.all([
			this.noteFavoritesRepository.existsBy({ userId: me.id, noteId: note.id }),
			note.userId === me.id ? this.userNotePiningsRepository.existsBy({ userId: me.id, noteId: note.id }) : false,
			this.noteThreadMutingsRepository.existsBy({ userId: me.id, threadId: note.threadId ?? note.id }),
		]);
		return { bookmarked, pinned, muted };
	}
}

interface NoteRelations {
	reply?: boolean | {
		reply?: boolean;
		renote?: boolean;
		user?: boolean;
		channel?: boolean;
	};
	renote?: boolean | {
		reply?: boolean;
		renote?: boolean;
		user?: boolean;
		channel?: boolean;
	};
	user?: boolean;
	channel?: boolean;
}

type NoteWithRelations<Rel extends NoteRelations> = MiNote & {
	reply: Rel extends { reply: false }
		? null
		: null | (MiNote & {
			reply: Rel['reply'] extends { reply: true } ? MiNote | null : null;
			renote: Rel['reply'] extends { renote: true } ? MiNote | null : null;
			user: Rel['reply'] extends { user: true } ? MiUser : null;
			channel: Rel['reply'] extends { channel: true } ? MiChannel | null : null;
		});
	renote: Rel extends { renote: false }
		? null
		: null | (MiNote & {
			reply: Rel['renote'] extends { reply: true } ? MiNote | null : null;
			renote: Rel['renote'] extends { renote: true } ? MiNote | null : null;
			user: Rel['renote'] extends { user: true } ? MiUser : null;
			channel: Rel['renote'] extends { channel: true } ? MiChannel | null : null;
		});
	user: Rel extends { user: true } ? MiUser : null;
	channel: Rel extends { channel: true } ? MiChannel | null : null;
};
