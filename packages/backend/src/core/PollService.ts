/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { NotesRepository, UsersRepository, PollsRepository, PollVotesRepository, MiUser } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import type { MiRemoteUser } from '@/models/User.js';
import { RelayService } from '@/core/RelayService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { bindThis } from '@/decorators.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { isHostAllowedByDeliveryTargets } from '@/misc/normalize-host.js';

@Injectable()
export class PollService {
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
		private relayService: RelayService,
		private globalEventService: GlobalEventService,
		private userBlockingService: UserBlockingService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
	) {
	}

	@bindThis
	public async vote(user: MiUser, note: MiNote, choice: number) {
		const poll = await this.pollsRepository.findOneBy({ noteId: note.id });

		if (poll == null) throw new Error('poll not found');

		// Check whether is valid choice
		if (poll.choices[choice] == null) throw new Error('invalid choice param');

		// Check blocking
		if (note.userId !== user.id) {
			const blocked = await this.userBlockingService.checkBlocked(note.userId, user.id);
			if (blocked) {
				throw new Error('blocked');
			}
		}

		// if already voted
		const exist = await this.pollVotesRepository.findBy({
			noteId: note.id,
			userId: user.id,
		});

		if (poll.multiple) {
			if (exist.some(x => x.choice === choice)) {
				throw new Error('already voted');
			}
		} else if (exist.length !== 0) {
			throw new Error('already voted');
		}

		await this.pollVotesRepository.insert({
			id: this.idService.gen(),
			noteId: note.id,
			userId: user.id,
			choice: choice,
		});

		// Increment votes count
		const index = choice + 1; // In SQL, array index is 1 based
		await this.pollsRepository.query('UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2', [index, poll.noteId]);

		this.globalEventService.publishNoteStream(note, 'pollVoted', {
			choice: choice,
			userId: user.id,
		});
	}

	@bindThis
	public async deliverQuestionUpdate(noteId: MiNote['id']) {
		const note = await this.notesRepository.findOneBy({ id: noteId });
		if (note == null) throw new Error('note not found');

		if (note.localOnly) return;

		const user = await this.usersRepository.findOneBy({ id: note.userId });
		if (user == null) throw new Error('note not found');

		if (this.userEntityService.isLocalUser(user)) {
			const object = await this.apRendererService.renderNote(note, false);
			const content = this.apRendererService.renderUpdate(object, user);
			content.to = object.to;
			content.cc = object.cc;

			if (note.visibility === 'specified') {
				const recipients = note.visibleUserIds.length === 0 ? [] : await this.usersRepository.find({
					where: { id: In(note.visibleUserIds) },
				});
				const allowedRecipients = recipients.filter(recipient => isHostAllowedByDeliveryTargets(note.deliveryTargets, recipient.host));
				content.to = allowedRecipients.flatMap(recipient => recipient.host == null
					? [this.userEntityService.genLocalUserUri(recipient.id)]
					: recipient.uri ? [recipient.uri] : []);
				content.cc = [];
				await this.apDeliverManagerService.deliverToUsers(user, content, allowedRecipients.filter(recipient => recipient.host != null) as MiRemoteUser[]);
				return;
			}

			if (note.deliveryTargets) this.apDeliverManagerService.deliverToFollowers(user, content, note.deliveryTargets);
			else this.apDeliverManagerService.deliverToFollowers(user, content);
			// A relay rebroadcasts to every follower, so it cannot honor a target list.
			if (note.deliveryTargets == null && note.visibility === 'public') this.relayService.deliverToRelays(user, content);
		}
	}
}
