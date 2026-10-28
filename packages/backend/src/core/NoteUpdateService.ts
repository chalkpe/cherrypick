/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setImmediate } from 'node:timers/promises';
import { In, DataSource } from 'typeorm';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as mfm from 'mfc-js';
import type { IMentionedRemoteUsers } from '@/models/Note.js';
import { MiNote } from '@/models/Note.js';
import { MiEvent } from '@/models/Event.js';
import type { IEvent } from '@/models/Event.js';
import type { NotesRepository, PollVotesRepository, UsersRepository, MiMeta } from '@/models/_.js';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { RelayService } from '@/core/RelayService.js';
import { DI } from '@/di-symbols.js';
import ActiveUsersChart from '@/core/chart/charts/active-users.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { QueueService } from '@/core/QueueService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { bindThis } from '@/decorators.js';
import { DB_MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import { SearchService } from '@/core/SearchService.js';
import { normalizeTag } from '@/misc/normalize-tag.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { MiDriveFile } from '@/models/_.js';
import { MiPoll, IPoll } from '@/models/Poll.js';
import { UtilityService } from '@/core/UtilityService.js';
import { concat } from '@/misc/prelude/array.js';
import { extractHashtags } from '@/misc/extract-hashtags.js';
import { extractCustomEmojisFromMfm } from '@/misc/extract-custom-emojis-from-mfm.js';
import { extractUrlsForKeyWordCheck } from '@/misc/extract-urls-for-keyword-check.js';
import { isHostAllowedByDeliveryTargets } from '@/misc/normalize-host.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { NoteHistorySerivce } from './NoteHistoryService.js';

type Option = {
	visibility?: MiNote['visibility'];
	visibleUserIds?: MiNote['visibleUserIds'];
	updatedAt?: Date | null;
	files?: MiDriveFile[] | null;
	name?: string | null;
	text?: string | null;
	disableRightClick?: boolean | null;
	cw?: string | null;
	apHashtags?: string[] | null;
	apEmojis?: string[] | null;
	poll?: IPoll | null;
	event?: IEvent | null;
	deleteAt?: Date | null;
};

@Injectable()
export class NoteUpdateService implements OnApplicationShutdown {
	#shutdownController = new AbortController();

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private queueService: QueueService,
		private relayService: RelayService,
		private apDeliverManagerService: ApDeliverManagerService,
		private apRendererService: ApRendererService,
		private searchService: SearchService,
		private activeUsersChart: ActiveUsersChart,
		private noteHistoryService: NoteHistorySerivce,
		private fanoutTimelineService: FanoutTimelineService,
		private moderationLogService: ModerationLogService,
		private noteEntityService: NoteEntityService,

		@Inject(DI.meta)
		private meta: MiMeta,

		private utilityService: UtilityService,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,
	) { }

	/** Change only the audience; author editing and its poll/event/history handling stay separate. */
	@bindThis
	public async updateVisibility(moderator: MiUser, note: MiNote, visibility: MiNote['visibility']): Promise<MiNote> {
		if (visibility === note.visibility) return note;

		const updatedAt = new Date();
		await this.db.transaction(async manager => {
			await manager.update(MiNote, { id: note.id }, { visibility, updatedAt });
			if (note.hasPoll) await manager.update(MiPoll, { noteId: note.id }, { noteVisibility: visibility });
			if (note.hasEvent) await manager.update(MiEvent, { noteId: note.id }, { noteVisibility: visibility });
		});
		const updatedNote = await this.notesRepository.findOneByOrFail({ id: note.id });

		await this.removeFromLocalTimeline(updatedNote);

		// Notify the previous audience without content so clients that lost access also refetch.
		this.globalEventService.publishNoteStream(note, 'updated', { updatedAt });
		await this.searchService.unindexNote(note);
		await this.searchService.indexNote(updatedNote);

		const author = await this.usersRepository.findOneByOrFail({ id: note.userId });
		await this.moderationLogService.log(moderator, 'updateNote', {
			noteId: note.id,
			noteUserId: author.id,
			noteUserUsername: author.username,
			noteUserHost: author.host,
			before: note.visibility,
			after: visibility,
		});

		// Notify previous recipients of the new audience using the unchanged content snapshot.
		// An Update avoids a terminal Delete racing an Update at a shared inbox.
		if (this.userEntityService.isLocalUser(author) && !note.localOnly) {
			const activity = await this.renderNoteActivity(new MiNote({ ...note, visibility, updatedAt }), author);
			if (note.visibility !== 'specified' || visibility !== 'specified') {
				if (note.deliveryTargets) await this.apDeliverManagerService.deliverToFollowers(author, activity, note.deliveryTargets);
				else await this.apDeliverManagerService.deliverToFollowers(author, activity);
			}
			// A relay rebroadcasts to every follower, so it cannot honor a target list.
			if (note.deliveryTargets == null && (note.visibility === 'public' || note.visibility === 'home' || visibility === 'public')) {
				await this.relayService.deliverToRelays(author, activity);
			}
			const previousRecipients = await this.getMentionedRemoteUsers(note);
			const explicitRecipients = note.visibleUserIds.length === 0 ? [] : await this.usersRepository.find({
				where: { id: In(note.visibleUserIds) },
			});
			await this.apDeliverManagerService.deliverToUsers(author, activity, [
				...previousRecipients,
				...explicitRecipients.filter(recipient => recipient.host != null) as MiRemoteUser[],
			].filter(recipient => isHostAllowedByDeliveryTargets(note.deliveryTargets, recipient.host)));
		}
		return updatedNote;
	}

	@bindThis
	private async removeFromLocalTimeline(note: MiNote): Promise<void> {
		if (note.visibility === 'public') return;
		await Promise.all([
			this.fanoutTimelineService.remove('localTimeline', note.id),
			this.fanoutTimelineService.remove('localTimelineWithFiles', note.id),
			this.fanoutTimelineService.remove('localTimelineWithReplies', note.id),
			this.fanoutTimelineService.remove('localTimelineWithCats', note.id),
			...(note.replyUserId ? [this.fanoutTimelineService.remove(`localTimelineWithReplyTo:${note.replyUserId}`, note.id)] : []),
		]);
	}

	@bindThis
	public async update(user: {
		id: MiUser['id'];
		username: MiUser['username'];
		host: MiUser['host'];
		isBot: MiUser['isBot'];
	}, data: Option, note: MiNote, silent = false): Promise<MiNote | null> {
		if (data.updatedAt == null) data.updatedAt = new Date();

		if (data.text) {
			if (data.text.length > DB_MAX_NOTE_TEXT_LENGTH) {
				data.text = data.text.slice(0, DB_MAX_NOTE_TEXT_LENGTH);
			}
			data.text = data.text.trim();
		} else {
			data.text = null;
		}

		// Apply the same content checks as note creation to the edited content
		const nextCw = data.cw !== undefined ? data.cw : note.cw;
		const nextText = data.text !== undefined ? data.text : note.text;
		if (this.utilityService.isKeyWordIncluded(
			this.utilityService.concatNoteContentsForKeyWordCheck({
				cw: nextCw,
				text: nextText,
				pollChoices: data.poll?.choices,
				others: [...extractUrlsForKeyWordCheck(nextCw ?? ''), ...extractUrlsForKeyWordCheck(nextText ?? '')],
			}),
			this.meta.prohibitedWords,
		)) {
			throw new IdentifiableError('689ee33f-f97c-479a-ac49-1b9f8140af99', 'Note contains prohibited words');
		}

		// Public notes containing sensitive words are downgraded to home, as on creation
		const sensitiveWordsTarget = nextCw ?? nextText ?? '';
		if ((data.visibility ?? note.visibility) === 'public' && note.channelId == null
			&& this.utilityService.isKeyWordIncluded([sensitiveWordsTarget, ...extractUrlsForKeyWordCheck(sensitiveWordsTarget)].join('\n'), this.meta.sensitiveWords)) {
			data.visibility = 'home';
		}

		let tags = data.apHashtags;
		let emojis = data.apEmojis;

		// Parse MFM if needed
		if (!tags || !emojis) {
			const tokens = data.text ? mfm.parse(data.text)! : [];
			const cwTokens = data.cw ? mfm.parse(data.cw)! : [];
			const choiceTokens = data.poll && data.poll.choices
				? concat(data.poll.choices.map(choice => mfm.parse(choice)!))
				: [];

			const combinedTokens = tokens.concat(cwTokens).concat(choiceTokens);

			tags = data.apHashtags ?? extractHashtags(combinedTokens);

			emojis = data.apEmojis ?? extractCustomEmojisFromMfm(combinedTokens);
		}

		tags = tags.filter(tag => Array.from(tag ?? '').length <= 128).splice(0, 32);

		const updatedNote = await this.updateNote(user, note, data, tags, emojis);

		if (updatedNote) {
			if (updatedNote.visibility !== note.visibility ||
				updatedNote.visibleUserIds.length !== note.visibleUserIds.length ||
				updatedNote.visibleUserIds.some(id => !note.visibleUserIds.includes(id))) {
				await this.removeFromLocalTimeline(updatedNote);
				await this.searchService.unindexNote(note);
				this.globalEventService.publishNoteStream(note, 'updated', { updatedAt: data.updatedAt });
			}
			setImmediate('post updated', { signal: this.#shutdownController.signal }).then(
				() => this.postNoteUpdated(updatedNote, user, silent),
				() => { /* aborted, ignore this */ },
			);
		}

		return updatedNote;
	}

	@bindThis
	private async updateNote(user: {
		id: MiUser['id']; host: MiUser['host'];
	}, note: MiNote, data: Option, tags: string[], emojis: string[]): Promise<MiNote | null> {
		const updatedAtHistory = note.updatedAtHistory ? note.updatedAtHistory : [];

		const values = new MiNote({
			updatedAt: data.updatedAt,
			...(data.visibility !== undefined ? { visibility: data.visibility } : {}),
			...(data.visibleUserIds !== undefined ? { visibleUserIds: data.visibleUserIds } : {}),
			fileIds: data.files ? data.files.map(file => file.id) : [],
			text: data.text,
			hasPoll: data.poll != null,
			hasEvent: data.event != null,
			cw: data.cw ?? null,
			tags: tags.map(tag => normalizeTag(tag)),
			emojis,
			disableRightClick: data.disableRightClick!,
			attachedFileTypes: data.files ? data.files.map(file => file.type) : [],
			updatedAtHistory: [...updatedAtHistory, new Date()],
			deleteAt: data.deleteAt!,
		});

		// 投稿を更新
		try {
			const [originalPoll, originalEvent] = await Promise.all([
				note.hasPoll
					? this.db.getRepository(MiPoll).findOneBy({ noteId: note.id }).then(poll =>
						poll ? {
							choices: poll.choices,
							multiple: poll.multiple,
							expiresAt: poll.expiresAt,
						} : null,
					)
					: Promise.resolve(null),
				note.hasEvent
					? this.db.getRepository(MiEvent).findOneBy({ noteId: note.id }).then(event =>
						event ? {
							title: event.title,
							start: event.start,
							end: event.end,
							metadata: event.metadata,
						} : null,
					)
					: Promise.resolve(null),
			]);

			// Start transaction for any poll or event changes
			const needsTransaction = note.hasPoll || values.hasPoll || note.hasEvent || values.hasEvent;

			if (needsTransaction) {
				await this.db.transaction(async transactionalEntityManager => {
					await transactionalEntityManager.update(MiNote, { id: note.id }, values);
					if (data.visibility !== undefined) {
						if (note.hasPoll) await transactionalEntityManager.update(MiPoll, { noteId: note.id }, { noteVisibility: data.visibility ?? note.visibility });
						if (note.hasEvent) await transactionalEntityManager.update(MiEvent, { noteId: note.id }, { noteVisibility: data.visibility ?? note.visibility });
					}

					if (note.hasPoll && values.hasPoll) {
						const old_poll = await transactionalEntityManager.findOneBy(MiPoll, { noteId: note.id });
						const choicesChanged = old_poll != null && (
							old_poll.choices.length !== data.poll!.choices.length
							|| old_poll.choices.some((choice, i) => choice !== data.poll!.choices[i])
						);
						if (old_poll && (choicesChanged || old_poll.multiple !== data.poll!.multiple)) {
							// Drop existing votes: their choice indexes refer to the old choices
							await transactionalEntityManager.withRepository(this.pollVotesRepository).delete({ noteId: note.id });
							await transactionalEntityManager.delete(MiPoll, { noteId: note.id });
							const poll = new MiPoll({
								noteId: note.id,
								choices: data.poll!.choices,
								expiresAt: data.poll!.expiresAt,
								multiple: data.poll!.multiple,
								votes: new Array(data.poll!.choices.length).fill(0),
								noteVisibility: data.visibility ?? note.visibility,
								userId: user.id,
								userHost: user.host,
							});
							await transactionalEntityManager.insert(MiPoll, poll);
						}
					} else if (!note.hasPoll && values.hasPoll) {
						const poll = new MiPoll({
							noteId: note.id,
							choices: data.poll!.choices,
							expiresAt: data.poll!.expiresAt,
							multiple: data.poll!.multiple,
							votes: new Array(data.poll!.choices.length).fill(0),
							noteVisibility: data.visibility ?? note.visibility,
							userId: user.id,
							userHost: user.host,
						});
						await transactionalEntityManager.insert(MiPoll, poll);
					} else if (note.hasPoll && !values.hasPoll) {
						// Remove poll
						await transactionalEntityManager.withRepository(this.pollVotesRepository).delete({ noteId: note.id });
						await transactionalEntityManager.delete(MiPoll, { noteId: note.id });
					}

					if (note.hasEvent && values.hasEvent) {
						const old_event = await transactionalEntityManager.findOneBy(MiEvent, { noteId: note.id });
						if (old_event && (
							old_event.start !== data.event!.start ||
							old_event.end !== data.event!.end ||
							old_event.title !== data.event!.title ||
							old_event.metadata !== data.event!.metadata
						)) {
							await transactionalEntityManager.delete(MiEvent, { noteId: note.id });
							const event = new MiEvent({
								noteId: note.id,
								title: data.event!.title,
								start: data.event!.start,
								end: data.event!.end ?? undefined,
								metadata: data.event!.metadata,
								noteVisibility: data.visibility ?? note.visibility,
								userId: user.id,
								userHost: user.host,
							});
							await transactionalEntityManager.insert(MiEvent, event);
						}
					} else if (!note.hasEvent && values.hasEvent) {
						const event = new MiEvent({
							noteId: note.id,
							title: data.event!.title,
							start: data.event!.start,
							end: data.event!.end ?? undefined,
							metadata: data.event!.metadata,
							noteVisibility: data.visibility ?? note.visibility,
							userId: user.id,
							userHost: user.host,
						});
						await transactionalEntityManager.insert(MiEvent, event);
					} else if (note.hasEvent && !values.hasEvent) {
						await transactionalEntityManager.delete(MiEvent, { noteId: note.id });
					}
				});
			} else {
				await this.notesRepository.update({ id: note.id }, values);
			}

			await this.noteHistoryService.recordHistory(values, note, originalPoll, originalEvent, { updatedAt: data.updatedAt });

			return await this.notesRepository.findOneBy({ id: note.id });
		} catch (e) {
			console.error(e);

			throw e;
		}
	}

	@bindThis
	private async postNoteUpdated(note: MiNote, user: {
		id: MiUser['id'];
		username: MiUser['username'];
		host: MiUser['host'];
		isBot: MiUser['isBot'];
	}, silent: boolean) {
		if (!silent) {
			if (this.userEntityService.isLocalUser(user)) this.activeUsersChart.write(user);

			// The job is keyed by the note ID (see NoteCreateService), so the one of the previous deleteAt can be replaced,
			// or dropped when the scheduled deletion was removed
			await (await this.queueService.scheduledNoteDeleteQueue.getJob(note.id))?.remove();
			if (note.deleteAt) {
				const delay = note.deleteAt.getTime() - Date.now();
				await this.queueService.scheduledNoteDeleteQueue.add(note.id, {
					noteId: note.id,
				}, {
					jobId: note.id,
					delay,
					removeOnComplete: true,
				});
			}

			this.globalEventService.publishNoteStream(note, 'updated', { updatedAt: note.updatedAt ?? new Date() });

			//#region AP deliver
			if (this.userEntityService.isLocalUser(user) && !note.localOnly) {
				await (async () => {
					// eslint-disable-next-line @typescript-eslint/ban-ts-comment
					// @ts-expect-error
					const noteActivity = await this.renderNoteActivity(note, user);

					await this.deliverToConcerned(user, note, noteActivity);
				})();
			}
			//#endregion
		}

		// Register to search database
		this.reIndex(note);
	}

	@bindThis
	private async renderNoteActivity(note: MiNote, user: MiUser) {
		const object = await this.apRendererService.renderNote(note, false);
		if (note.visibility === 'specified') {
			// Existing mentions are not the audience after a moderation change to specified.
			const recipients = note.visibleUserIds.length === 0 ? [] : await this.usersRepository.find({
				where: { id: In(note.visibleUserIds) },
			});
			object.to = recipients.flatMap(recipient => recipient.host == null
				? [this.userEntityService.genLocalUserUri(recipient.id)]
				: recipient.uri ? [recipient.uri] : []);
			object.cc = [];
		}
		const content = this.apRendererService.renderUpdate(object, user);
		content.to = object.to;
		content.cc = object.cc;

		return this.apRendererService.addContext(content);
	}

	@bindThis
	private async getMentionedRemoteUsers(note: MiNote) {
		const where = [] as any[];

		// mention / reply / dm
		const uris = (JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers).map(x => x.uri);
		if (uris.length > 0) {
			where.push(
				{ uri: In(uris) },
			);
		}

		// renote / quote
		if (note.renoteUserId) {
			where.push({
				id: note.renoteUserId,
			});
		}

		if (where.length === 0) return [];

		return await this.usersRepository.find({
			where,
		}) as MiRemoteUser[];
	}

	@bindThis
	private async deliverToConcerned(user: { id: MiLocalUser['id']; host: null; }, note: MiNote, content: any) {
		if (note.visibility === 'specified') {
			const recipients = note.visibleUserIds.length === 0 ? [] : await this.usersRepository.find({
				where: { id: In(note.visibleUserIds) },
			});
			await this.apDeliverManagerService.deliverToUsers(user, content, recipients.filter(recipient => recipient.host != null) as MiRemoteUser[]);
			return;
		}
		if (note.deliveryTargets) await this.apDeliverManagerService.deliverToFollowers(user, content, note.deliveryTargets);
		else await this.apDeliverManagerService.deliverToFollowers(user, content);
		// A relay rebroadcasts to every follower, so it cannot honor a target list.
		if (note.deliveryTargets == null && note.visibility === 'public') await this.relayService.deliverToRelays(user, content);
		const remoteUsers = await this.getMentionedRemoteUsers(note);
		for (const remoteUser of remoteUsers) {
			if (!isHostAllowedByDeliveryTargets(note.deliveryTargets, remoteUser.host)) continue;
			if (await this.noteEntityService.isVisibleForMe(note, remoteUser.id)) {
				await this.apDeliverManagerService.deliverToUser(user, content, remoteUser);
			}
		}
	}

	@bindThis
	private reIndex(note: MiNote) {
		if (note.text == null && note.cw == null) return;

		this.searchService.unindexNote(note);
		this.searchService.indexNote(note);
	}

	/**
	 * Whether `meId` may read the revision history of `note`.
	 * Mirrors the access rules of notes/show and additionally requires the note itself to be visible,
	 * because revision payloads contain the raw note content.
	 */
	@bindThis
	public async checkRevisionsAccess(note: MiNote, meId: MiUser['id'] | null): Promise<'ok' | 'restrictedByUser' | 'restrictedByServer' | 'invisible'> {
		if (meId == null) {
			const author = await this.usersRepository.findOneByOrFail({ id: note.userId });
			if (author.requireSigninToViewContents) return 'restrictedByUser';
			if (this.meta.ugcVisibilityForVisitor === 'none') return 'restrictedByServer';
			if (this.meta.ugcVisibilityForVisitor === 'local' && note.userHost != null) return 'restrictedByServer';
		}

		if (!await this.noteEntityService.isVisibleForMe(note, meId)) return 'invisible';

		return 'ok';
	}

	@bindThis
	public dispose(): void {
		this.#shutdownController.abort();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
