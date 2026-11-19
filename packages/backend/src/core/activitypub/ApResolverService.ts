/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { IsNull, Not } from 'typeorm';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type {
	FollowRequestsRepository,
	MiMeta,
	NoteReactionsRepository,
	NotesRepository,
	PollsRepository,
	UsersRepository
} from '@/models/_.js';
import type { Config } from '@/config.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { DI } from '@/di-symbols.js';
import { UtilityService } from '@/core/UtilityService.js';
import { bindThis } from '@/decorators.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { StatusError } from '@/misc/status-error.js';
import type { ICollection, IObject, IOrderedCollection } from './type.js';
import { isCollectionOrOrderedCollection, isNote } from './type.js';
import { ApDbResolverService } from './ApDbResolverService.js';
import { ApRendererService } from './ApRendererService.js';
import { ApRequestService } from './ApRequestService.js';
import { FetchAllowSoftFailMask } from './misc/check-against-url.js';
import { ModuleRef } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class Resolver {
	private history: Set<string>;
	private readonly prefetchedNotes = new Map<string, IObject>();
	private readonly permanentNoteFailures = new Map<string, StatusError>();
	private user?: MiLocalUser;
	private logger: Logger;
	private recursionLimit = 256;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		private utilityService: UtilityService,
		private systemAccountService: SystemAccountService,
		private apRequestService: ApRequestService,
		private httpRequestService: HttpRequestService,
		private apRendererService: ApRendererService,
		private apDbResolverService: ApDbResolverService,
		private loggerService: LoggerService,
	) {
		this.history = new Set();
		this.logger = this.loggerService.getLogger('ap-resolve');
	}

	/**
	 * A chat message is served only to its participants, who are identified by the key that signs the request.
	 */
	@bindThis
	public signAs(user: MiLocalUser): void {
		this.user = user;
		this.prefetchedNotes.clear();
		this.permanentNoteFailures.clear();
	}

	@bindThis
	public getHistory(): string[] {
		return Array.from(this.history);
	}

	@bindThis
	public getRecursionLimit(): number {
		return this.recursionLimit;
	}

	@bindThis
	public async resolveCollection(value: string | IObject): Promise<ICollection | IOrderedCollection> {
		const collection = typeof value === 'string'
			? await this.resolve(value)
			: value;

		if (isCollectionOrOrderedCollection(collection)) {
			return collection;
		} else {
			throw new IdentifiableError('f100eccf-f347-43fb-9b45-96a0831fb635', `unrecognized collection type: ${collection.type}`);
		}
	}

	public async resolveFeaturedItem(value: string | IObject): Promise<IObject> {
		const object = await this.resolve(value);
		if (typeof value === 'string' && isNote(object)) {
			this.prefetchedNotes.set(value, object);
		}
		return object;
	}

	public async resolveNote(value: string | IObject): Promise<IObject> {
		if (typeof value !== 'string') {
			if (value.id != null) this.prefetchedNotes.delete(value.id);
			return await this.resolve(value);
		}

		const prefetched = this.prefetchedNotes.get(value);
		if (prefetched != null) {
			// 미리 조회한 객체는 한 번만 사용한다. 글을 처리하는 도중의 재진입은 기존 중복 검사에 맡긴다.
			this.prefetchedNotes.delete(value);
			return prefetched;
		}

		const failure = this.permanentNoteFailures.get(value);
		if (failure != null) throw failure;

		try {
			return await this.resolve(value);
		} catch (err) {
			// 같은 대상의 영구 조회 실패는 같은 인용을 처리할 때도 유지한다.
			if (err instanceof StatusError && !err.isRetryable) this.permanentNoteFailures.set(value, err);
			throw err;
		}
	}

	@bindThis
	public async resolve(value: string | IObject, allowSoftfail: FetchAllowSoftFailMask = FetchAllowSoftFailMask.Strict): Promise<IObject> {
		if (typeof value !== 'string') {
			return value;
		}

		if (value.includes('#')) {
			// URLs with fragment parts cannot be resolved correctly because
			// the fragment part does not get transmitted over HTTP(S).
			// Avoid strange behaviour by not trying to resolve these at all.
			throw new IdentifiableError('b94fd5b1-0e3b-4678-9df2-dad4cd515ab2', `cannot resolve URL with fragment: ${value}`);
		}

		if (this.history.has(value)) {
			throw new IdentifiableError('0dc86cf6-7cd6-4e56-b1e6-5903d62d7ea5', 'cannot resolve already resolved one');
		}

		if (this.history.size > this.recursionLimit) {
			throw new IdentifiableError('d592da9f-822f-4d91-83d7-4ceefabcf3d2', `hit recursion limit: ${this.utilityService.extractDbHost(value)}`);
		}

		this.history.add(value);

		const host = this.utilityService.extractDbHost(value);
		if (this.utilityService.isSelfHost(host)) {
			return await this.resolveLocal(value);
		}

		if (!this.utilityService.isFederationAllowedHost(host)) {
			throw new IdentifiableError('09d79f9e-64f1-4316-9cfa-e75c4d091574', 'Instance is blocked');
		}

		if (this.meta.signToActivityPubGet && !this.user) {
			this.user = await this.systemAccountService.fetch('actor');
		}

		const object = (this.user
			? await this.apRequestService.signedGet(value, this.user, allowSoftfail) as IObject
			: await this.httpRequestService.getActivityJson(value, undefined, allowSoftfail)) as IObject;

		if (
			Array.isArray(object['@context']) ?
				!(object['@context'] as unknown[]).includes('https://www.w3.org/ns/activitystreams') :
				object['@context'] !== 'https://www.w3.org/ns/activitystreams'
		) {
			throw new IdentifiableError('72180409-793c-4973-868e-5a118eb5519b', 'invalid response');
		}

		return object;
	}

	@bindThis
	private resolveLocal(url: string): Promise<IObject> {
		const parsed = this.apDbResolverService.parseUri(url);
		if (!parsed.local) throw new IdentifiableError('02b40cd0-fa92-4b0c-acc9-fb2ada952ab8', 'resolveLocal: not local');

		switch (parsed.type) {
			case 'notes':
				return this.notesRepository.findOneByOrFail({ id: parsed.id })
					.then(async note => {
						if (parsed.rest === 'activity') {
							// this refers to the create activity and not the note itself
							return this.apRendererService.addContext(this.apRendererService.renderCreate(await this.apRendererService.renderNote(note), note));
						} else {
							return this.apRendererService.renderNote(note);
						}
					});
			case 'users':
				return this.usersRepository.findOneByOrFail({ id: parsed.id })
					.then(user => this.apRendererService.renderPerson(user as MiLocalUser));
			case 'questions':
				// Polls are indexed by the note they are attached to.
				return Promise.all([
					this.notesRepository.findOneByOrFail({ id: parsed.id }),
					this.pollsRepository.findOneByOrFail({ noteId: parsed.id }),
				])
					.then(([note, poll]) => this.apRendererService.renderQuestion({ id: note.userId }, note, poll));
			case 'likes':
				return this.noteReactionsRepository.findOneByOrFail({ id: parsed.id }).then(async reaction =>
					this.apRendererService.addContext(await this.apRendererService.renderLike(reaction, { uri: null })));
			case 'follows':
				return this.followRequestsRepository.findOneBy({ id: parsed.id })
					.then(async followRequest => {
						if (followRequest == null) throw new IdentifiableError('a9d946e5-d276-47f8-95fb-f04230289bb0', 'resolveLocal: invalid follow request ID');
						const [follower, followee] = await Promise.all([
							this.usersRepository.findOneBy({
								id: followRequest.followerId,
								host: IsNull(),
							}),
							this.usersRepository.findOneBy({
								id: followRequest.followeeId,
								host: Not(IsNull()),
							}),
						]);
						if (follower == null || followee == null) {
							throw new IdentifiableError('06ae3170-1796-4d93-a697-2611ea6d83b6', 'resolveLocal: follower or followee does not exist');
						}
						return this.apRendererService.addContext(this.apRendererService.renderFollow(follower as MiLocalUser | MiRemoteUser, followee as MiLocalUser | MiRemoteUser, url));
					});
			default:
				throw new IdentifiableError('7a5d2fc0-94bc-4db6-b8b8-1bf24a2e23d0', `resolveLocal: type ${parsed.type} unhandled`);
		}
	}
}

@Injectable()
export class ApResolverService {
	constructor(
		private moduleRef: ModuleRef,
	) {
	}

	@bindThis
	public async createResolver(): Promise<Resolver> {
		return await this.moduleRef.create(Resolver);
	}
}
