/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Entity, MastodonEntity, MisskeyEntity } from 'megalodon';
import * as mfm from 'mfc-js';
import { DI } from '@/di-symbols.js';
import { MfmService } from '@/core/MfmService.js';
import type { Config } from '@/config.js';
import { IMentionedRemoteUsers, MiNote } from '@/models/Note.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import type { NoteHistoryRepository } from '@/models/_.js';
import { escapeHtml } from '@/misc/escape-html.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { IdService } from '@/core/IdService.js';
import type { Packed } from '@/misc/json-schema.js';
import { MastodonDataService } from '@/server/api/mastodon/MastodonDataService.js';
import { MastodonFilterService } from '@/server/api/mastodon/MastodonFilterService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { CacheService } from '@/core/CacheService.js';
import { isRenote } from '@/misc/is-renote.js';
import { promiseMap } from '@/misc/promise-map.js';
import { emojiRegex } from '@/misc/emoji-regex.js';
import { ApiError } from '@/server/api/error.js';

// Mastodon requires a header image URL even when the user has none.
const TRANSPARENT_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Missing from Megalodon apparently
// https://docs.joinmastodon.org/entities/StatusEdit/
export interface StatusEdit {
	content: string;
	spoiler_text: string;
	sensitive: boolean;
	created_at: string;
	account: MastodonEntity.Account;
	poll?: {
		options: {
			title: string;
		}[]
	},
	media_attachments: MastodonEntity.Attachment[],
	emojis: MastodonEntity.Emoji[],
}

export const escapeMFM = (text: string): string => text
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
	.replace(/'/g, '&#39;')
	.replace(/`/g, '&#x60;')
	.replace(/\r?\n/g, '<br>');

@Injectable()
export class MastodonConverters {
	constructor(
		@Inject(DI.config)
		private readonly config: Config,

		@Inject(DI.noteHistoryRepository)
		private readonly noteHistoryRepository: NoteHistoryRepository,

		private readonly mfmService: MfmService,
		private readonly getterService: GetterService,
		private readonly customEmojiService: CustomEmojiService,
		private readonly idService: IdService,
		private readonly driveFileEntityService: DriveFileEntityService,
		private readonly mastodonDataService: MastodonDataService,
		private readonly userEntityService: UserEntityService,
		private readonly cacheService: CacheService,
		private readonly filterService: MastodonFilterService,
	) {}

	/**
	 * Base URL of this server, for building URLs in entities
	 */
	public get publicBaseUrl(): string {
		return this.config.url;
	}

	/**
	 * Resolves custom emoji used in a note or a name.
	 * Misskey leaves local emoji for its own client to look up, so those come from the local emoji list.
	 */
	private async resolveEmojis(names: string[], host: string | null): Promise<Entity.Emoji[]> {
		if (names.length === 0) return [];

		if (host == null) {
			const localEmojis = await this.customEmojiService.localEmojisCache.fetch();
			return names.flatMap(name => {
				const emoji = localEmojis.get(name);
				if (emoji == null) return [];
				const url = emoji.publicUrl || emoji.originalUrl;
				return [{ shortcode: name, url, static_url: url, visible_in_picker: true, category: emoji.category ?? undefined }];
			});
		}

		const emojis = await this.customEmojiService.populateEmojis(names, host);
		return Object.entries(emojis).map(([shortcode, url]) => ({ shortcode, url, static_url: url, visible_in_picker: true, category: undefined }));
	}

	/**
	 * Renders MFM into the HTML subset Mastodon clients expect, the same way it is rendered for ActivityPub.
	 */
	private toMastoHtml(text: string, mentionedRemoteUsers: IMentionedRemoteUsers = [], quoteUri: string | null = null, inline = false): string {
		const quoteHtml = quoteUri != null
			? `<span class="quote-inline"><br><br>RE: <a href="${escapeHtml(quoteUri)}">${escapeHtml(quoteUri)}</a></span>`
			: null;
		const html = this.mfmService.toHtml(mfm.parse(text), mentionedRemoteUsers, quoteHtml) ?? escapeMFM(text);
		return inline ? html : `<p>${html}</p>`;
	}

	private encode(u: MiUser, m: IMentionedRemoteUsers): MastodonEntity.Mention {
		let acct = u.username;
		let acctUrl = `${this.config.url}/@${u.username}`;
		let url: string | null = null;
		if (u.host) {
			const info = m.find(r => r.username === u.username && r.host === u.host);
			acct = `${u.username}@${u.host}`;
			acctUrl = `https://${u.host}/@${u.username}`;
			if (info) url = info.url ?? info.uri;
		}
		return {
			id: u.id,
			username: u.username,
			acct: acct,
			url: url ?? acctUrl,
		};
	}

	public fileType(s: string): 'unknown' | 'image' | 'gifv' | 'video' | 'audio' {
		if (s === 'image/gif') {
			return 'gifv';
		}
		if (s.includes('image')) {
			return 'image';
		}
		if (s.includes('video')) {
			return 'video';
		}
		if (s.includes('audio')) {
			return 'audio';
		}
		return 'unknown';
	}

	public encodeFile(f: Packed<'DriveFile'>): MastodonEntity.Attachment {
		const { width, height } = f.properties;
		const size = (width && height) ? `${width}x${height}` : undefined;
		const aspect = (width && height) ? (width / height) : undefined;

		return {
			id: f.id,
			type: this.fileType(f.type),
			url: f.url,
			remote_url: f.url,
			preview_url: f.thumbnailUrl,
			text_url: f.url,
			meta: {
				original: {
					width,
					height,
					size,
					aspect,
				},
				width,
				height,
				size,
				aspect,
			},
			description: f.comment ?? null,
			blurhash: f.blurhash ?? null,
		};
	}

	private encodeField(f: Entity.Field): MastodonEntity.Field {
		return {
			name: f.name,
			value: this.toMastoHtml(f.value, [], null, true),
			verified_at: null,
		};
	}

	/**
	 * @param me The viewer, who always sees the follower counts of their own account
	 */
	public async convertAccount(account: Entity.Account | MiUser, me?: MiLocalUser | null): Promise<MastodonEntity.Account> {
		const [user, profile] = await Promise.all([
			this.getterService.getUser(account.id),
			this.cacheService.userProfileCache.fetch(account.id).catch(() => undefined),
		]);
		const emoji = await this.resolveEmojis(user.emojis, user.host);
		const fqn = `${user.username}@${user.host ?? this.config.hostname}`;
		let acct = user.username;
		let acctUrl = `${this.config.url}/@${user.username}`;
		const acctUri = `${this.config.url}/users/${user.id}`;
		if (user.host) {
			acct = `${user.username}@${user.host}`;
			acctUrl = `https://${user.host}/@${user.username}`;
		}

		const bioText = profile?.description && this.toMastoHtml(profile.description);
		const avatarUrl = user.avatarUrl ?? this.userEntityService.getIdenticonUrl(user);

		return await awaitAll({
			id: account.id,
			username: user.username,
			acct: acct,
			fqn: fqn,
			display_name: user.name ?? user.username,
			locked: user.isLocked,
			created_at: this.idService.parse(user.id).date.toISOString(),
			followers_count: profile?.followersVisibility === 'public' || me?.id === user.id ? user.followersCount : 0,
			following_count: profile?.followingVisibility === 'public' || me?.id === user.id ? user.followingCount : 0,
			statuses_count: user.notesCount,
			note: bioText ?? '',
			url: user.uri ?? acctUrl,
			uri: user.uri ?? acctUri,
			avatar: avatarUrl,
			avatar_static: avatarUrl,
			header: user.bannerUrl ?? TRANSPARENT_IMAGE,
			header_static: user.bannerUrl ?? TRANSPARENT_IMAGE,
			emojis: emoji,
			moved: null, //FIXME
			fields: profile?.fields.map(p => this.encodeField(p)) ?? [],
			bot: user.isBot,
			discoverable: user.isExplorable,
			noindex: profile?.noCrawle ?? false,
			hide_collections: profile != null && (profile.followersVisibility !== 'public' || profile.followingVisibility !== 'public'),
			group: null,
			suspended: user.isSuspended || user.isDeleted,
			limited: false,
		});
	}

	/**
	 * Builds the Mastodon edit history of a note, oldest first and including the current version.
	 * Each NoteHistory row holds the content a note had before an edit.
	 */
	public async getEdits(id: string, me: MiLocalUser | null): Promise<StatusEdit[]> {
		const note = await this.mastodonDataService.getNote(id, me);
		if (!note) {
			return [];
		}

		const noteUser = await this.getterService.getUser(note.userId);
		const account = await this.convertAccount(noteUser);
		const histories = await this.noteHistoryRepository.find({ where: { noteId: note.id }, order: { updatedAt: 'ASC' } });
		if (histories.length === 0) {
			return [];
		}

		const mentionedRemoteUsers = JSON.parse(note.mentionedRemoteUsers);
		const renote = isRenote(note) ? await this.mastodonDataService.getNote(note.renoteId, me) : null;
		const quoteUri = renote
			? renote.url ?? renote.uri ?? `${this.config.url}/notes/${renote.id}`
			: null;

		const versions = [
			...histories.map(h => ({ text: h.text, cw: h.cw, fileIds: h.fileIds })),
			{ text: note.text, cw: note.cw, fileIds: note.fileIds },
		];

		// A version was created when the previous one was replaced.
		let createdAt = this.idService.parse(note.id).date;
		const history: StatusEdit[] = [];
		for (const [i, version] of versions.entries()) {
			const files = await this.driveFileEntityService.packManyByIds(version.fileIds);
			const cw = version.cw ?? '';

			history.push({
				account: account,
				content: this.toMastoHtml(version.text ?? '', mentionedRemoteUsers, quoteUri),
				created_at: createdAt.toISOString(),
				emojis: [], //FIXME
				sensitive: !!cw,
				spoiler_text: cw,
				media_attachments: files.map((f) => this.encodeFile(f)),
			});

			if (i < histories.length) {
				createdAt = histories[i].updatedAt;
			}
		}

		return history;
	}

	public async convertStatus(status: Entity.Status, me: MiLocalUser | null, hints?: { note?: MiNote, user?: MiUser }): Promise<MastodonEntity.Status> {
		const note = hints?.note ?? await this.mastodonDataService.requireNote(status.id, me);
		const noteUser = hints?.user ?? note.user ?? await this.getterService.getUser(status.account.id);
		const mentionedRemoteUsers = JSON.parse(note.mentionedRemoteUsers);

		const emoji = await this.resolveEmojis(note.emojis, noteUser.host);

		const mentionedUsers = await Promise.all(note.mentions.map(id => this.cacheService.findUserById(id).catch(() => null)));
		const mentions = mentionedUsers.filter(u => u != null).map(u => this.encode(u, mentionedRemoteUsers));

		const tags = note.tags.map(tag => {
			return {
				name: tag,
				url: `${this.config.url}/tags/${tag}`,
			} as Entity.Tag;
		});

		// This must mirror the usual isQuote / isPureRenote logic used elsewhere.
		const isQuote = note.renoteId && (note.text || note.cw || note.fileIds.length > 0 || note.hasPoll || note.replyId);

		// The renoted note is fetched once for both the quote link and the embedded status.
		// A pure renote shows nothing but its target, so it fails without it, while a quote is still shown.
		const [renote, reblogged, state, filtered, pureRenotes] = await Promise.all([
			note.renoteId
				? isQuote ? this.mastodonDataService.getNote(note.renoteId, me) : this.mastodonDataService.requireNote(note.renoteId, me)
				: null,
			this.mastodonDataService.hasReblog(note.id, me),
			this.mastodonDataService.getNoteState(note, me),
			me ? this.filterService.match(note, me) : undefined,
			// Most notes are never renoted, so only those that are need counting
			note.renoteCount > 0 ? this.mastodonDataService.countPureRenotes(note.id) : 0,
		]);

		const quoteUri = isQuote && renote
			? renote.url ?? renote.uri ?? `${this.config.url}/notes/${renote.id}`
			: null;
		const embedded = status.reblog && renote
			? this.convertStatus(status.reblog, me, { note: renote })
			: null;

		// Mastodon 4.5 quote. A visible quoted status also comes with its own fields, for clients that read quotes the Fedibird way.
		const quote = isQuote
			? embedded
				? embedded.then(quoted => ({ ...quoted, state: 'accepted' as const, quoted_status: quoted }))
				: { state: 'unauthorized' as const, quoted_status: null }
			: null;

		const text = note.text;
		const content = text !== null
			? this.toMastoHtml(text, mentionedRemoteUsers, quoteUri)
			: '';

		const cw = note.cw ?? '';

		// noinspection ES6MissingAwait
		return await awaitAll({
			id: note.id,
			uri: note.uri ?? `${this.config.url}/notes/${note.id}`,
			url: note.url ?? note.uri ?? `${this.config.url}/notes/${note.id}`,
			account: this.convertAccount(status.account),
			in_reply_to_id: note.replyId,
			in_reply_to_account_id: note.replyUserId,
			reblog: !isQuote ? embedded : null,
			content: content,
			content_type: 'text/x.misskeymarkdown',
			text: note.text,
			created_at: status.created_at,
			edited_at: note.updatedAt?.toISOString() ?? null,
			emojis: emoji,
			replies_count: note.repliesCount,
			reblogs_count: pureRenotes,
			quotes_count: note.renoteCount - pureRenotes,
			favourites_count: status.favourites_count,
			reblogged,
			favourited: status.favourited,
			muted: state.muted,
			sensitive: status.sensitive || !!cw,
			spoiler_text: cw,
			visibility: status.visibility,
			// Glitch-soc and Hometown mark local-only posts this way, which clients unaware of the "local" visibility still read
			local_only: note.localOnly,
			media_attachments: status.media_attachments.map((a: Entity.Attachment) => convertAttachment(a)),
			mentions: mentions,
			tags: tags,
			card: null, //FIXME
			poll: status.poll ?? null,
			application: null, //FIXME
			language: null, //FIXME
			pinned: state.pinned,
			bookmarked: state.bookmarked,
			quote_id: isQuote && embedded ? status.reblog?.id : undefined,
			quote,
			quote_approval: getQuoteApproval(note, me),
			filtered,
			reactions: this.convertReactions(status.emoji_reactions),
		});
	}

	/**
	 * Converts the statuses of a list, leaving out those the viewer cannot see (any more),
	 * such as a bookmarked followers-only note of someone they stopped following.
	 * One such status must not fail the whole list.
	 */
	public async convertStatuses(statuses: Entity.Status[], me: MiLocalUser | null, limiter = 4): Promise<MastodonEntity.Status[]> {
		const converted = await promiseMap(statuses, async status => {
			try {
				return await this.convertStatus(status, me);
			} catch (err) {
				if (err instanceof ApiError && err.code === 'NO_SUCH_NOTE') return null;
				throw err;
			}
		}, { limiter });
		return converted.filter(status => status != null);
	}

	/**
	 * Fills in image URLs of custom emoji reactions.
	 * Misskey only sends URLs of remote emoji, so local ones are served through /emoji/.
	 */
	public convertReactions(reactions: Entity.Reaction[]): MastodonEntity.Reaction[] {
		return reactions.map(r => {
			if (r.url || isUnicodeEmojiReaction(r.name)) return r;
			const url = `${this.config.url}/emoji/${r.name}.webp`;
			return { ...r, url, static_url: url };
		});
	}

	/**
	 * Builds Pleroma-style reaction entries with the reacting accounts from Misskey reaction records.
	 */
	public async convertReactionUsers(records: MisskeyEntity.Reaction[], me: MiLocalUser | null): Promise<(MastodonEntity.Reaction & { accounts: MastodonEntity.Account[], account_ids: string[] })[]> {
		const groups = new Map<string, MisskeyEntity.Reaction[]>();
		for (const record of records) {
			const name = fromMisskeyReaction(record.type);
			groups.set(name, [...(groups.get(name) ?? []), record]);
		}

		return await promiseMap(groups.entries(), async ([name, group]) => {
			const [reaction] = this.convertReactions([{ name, count: group.length, me: false }]);
			return {
				...reaction,
				me: me != null && group.some(r => r.user.id === me.id),
				accounts: await promiseMap(group, async r => await this.convertAccount(r.user as unknown as Entity.Account), { limiter: 4 }),
				account_ids: group.map(r => r.user.id),
			};
		});
	}

	public async convertConversation(conversation: Entity.Conversation, me: MiLocalUser | null): Promise<MastodonEntity.Conversation> {
		return {
			id: conversation.id,
			accounts: await promiseMap(conversation.accounts, async (a: Entity.Account) => await this.convertAccount(a), { limiter: 2 }),
			last_status: conversation.last_status ? await this.convertStatus(conversation.last_status, me) : null,
			unread: conversation.unread,
		};
	}

	public async convertNotification(notification: Entity.Notification, me: MiLocalUser | null): Promise<MastodonEntity.Notification | null> {
		const status = notification.status
			? await this.convertStatus(notification.status, me).catch(() => null)
			: null;

		// We sometimes get notifications for inaccessible notes, these should be ignored.
		// Notifications without a note (follows, follow requests...) are kept.
		if (notification.status && !status) {
			return null;
		}

		// Mastodon points boost notifications at the boosted status, not at the boost itself
		const type = convertNotificationType(notification.type as Entity.NotificationType);
		const target = type === 'reblog' && status?.reblog ? status.reblog : status;

		return {
			account: await this.convertAccount(notification.account),
			created_at: notification.created_at,
			id: notification.id,
			status: target ?? undefined,
			type,
			...(notification.emoji ? this.convertNotificationEmoji(notification.emoji, target) : {}),
		};
	}

	/**
	 * The reaction of a reaction notification as Pleroma / Akkoma send it: the emoji itself, or ":name:" with an image URL for custom emoji.
	 */
	private convertNotificationEmoji(reaction: string, status: MastodonEntity.Status | null): { emoji: string, emoji_url: string | null } {
		const name = fromMisskeyReaction(reaction);
		if (isUnicodeEmojiReaction(name)) return { emoji: name, emoji_url: null };

		// Remote emoji come with their URL in the status, while local ones are served through /emoji/
		const url = status?.reactions?.find(r => r.name === name)?.url ?? `${this.config.url}/emoji/${name}.webp`;
		return { emoji: `:${name}:`, emoji_url: url };
	}

	public convertApplication(app: MisskeyEntity.App): MastodonEntity.Application {
		return {
			name: app.name,
			scopes: app.permission,
			redirect_uri: app.callbackUrl,
			redirect_uris: [app.callbackUrl],
		};
	}
}

/**
 * Who can quote a note, as Misskey allows renoting it: anyone for public and home notes, and only the author for followers-only notes.
 */
function getQuoteApproval(note: MiNote, me: MiLocalUser | null): MastodonEntity.QuoteApproval {
	const open = note.visibility === 'public' || note.visibility === 'home';
	const canQuote = open || (note.visibility === 'followers' && me?.id === note.userId);
	return {
		automatic: open ? ['public'] : [],
		manual: [],
		current_user: me ? (canQuote ? 'automatic' : 'denied') : 'unknown',
	};
}

const unicodeEmojiReactionRegex = new RegExp(`^${emojiRegex.source}$`);

export function isUnicodeEmojiReaction(name: string): boolean {
	return unicodeEmojiReactionRegex.test(name);
}

/**
 * Converts a reaction name from Mastodon clients into a Misskey reaction.
 * Clients send custom emoji as "name" or "name@host" without colons.
 */
export function toMisskeyReaction(name: string): string {
	if (isUnicodeEmojiReaction(name)) return name;
	if (/^:[^:]+:$/.test(name)) return name;
	return `:${name}:`;
}

/**
 * Converts a Misskey reaction (":name@.:", ":name@host:" or a Unicode emoji) into the name Mastodon clients use.
 */
export function fromMisskeyReaction(reaction: string): string {
	const match = reaction.match(/^:([^@:]+)(?:@([^:]+))?:$/);
	if (!match) return reaction;
	const [, name, host] = match;
	return host && host !== '.' ? `${name}@${host}` : name;
}

function simpleConvert<T>(data: T): T {
	// copy the object to bypass weird pass by reference bugs
	return Object.assign({}, data);
}

function convertNotificationType(type: Entity.NotificationType): MastodonEntity.NotificationType {
	switch (type) {
		case 'emoji_reaction': return 'reaction';
		case 'poll_vote':
		case 'poll_expired':
			return 'poll';
		// Not supported by mastodon
		case 'move':
			return type as MastodonEntity.NotificationType;
		default: return type;
	}
}

export function convertAnnouncement(announcement: Entity.Announcement): MastodonEntity.Announcement {
	return {
		...announcement,
		updated_at: announcement.updated_at ?? announcement.published_at,
	};
}

export function convertAttachment(attachment: Entity.Attachment): MastodonEntity.Attachment {
	const { width, height } = attachment.meta?.original ?? attachment.meta ?? {};
	const size = (width && height) ? `${width}x${height}` : undefined;
	const aspect = (width && height) ? (width / height) : undefined;
	return {
		...attachment,
		meta: attachment.meta ? {
			...attachment.meta,
			original: {
				...attachment.meta.original,
				width,
				height,
				size,
				aspect,
				frame_rate: String(attachment.meta.fps),
				duration: attachment.meta.duration,
				bitrate: attachment.meta.audio_bitrate ? parseInt(attachment.meta.audio_bitrate) : undefined,
			},
			width,
			height,
			size,
			aspect,
		} : null,
	};
}
export function convertFilter(filter: Entity.Filter): MastodonEntity.Filter {
	return simpleConvert(filter);
}
export function convertList(list: Entity.List): MastodonEntity.List {
	return {
		id: list.id,
		title: list.title,
		replies_policy: list.replies_policy ?? 'followed',
	};
}
export function convertFeaturedTag(tag: Entity.FeaturedTag): MastodonEntity.FeaturedTag {
	return simpleConvert(tag);
}

export function convertPoll(poll: Entity.Poll): MastodonEntity.Poll {
	return simpleConvert(poll);
}

// Megalodon sometimes returns broken / stubbed relationship data
export function convertRelationship(relationship: Partial<Entity.Relationship> & { id: string }): MastodonEntity.Relationship {
	return {
		id: relationship.id,
		following: relationship.following ?? false,
		showing_reblogs: relationship.showing_reblogs ?? true,
		notifying: relationship.notifying ?? true,
		languages: [],
		followed_by: relationship.followed_by ?? false,
		blocking: relationship.blocking ?? false,
		blocked_by: relationship.blocked_by ?? false,
		muting: relationship.muting ?? false,
		muting_notifications: relationship.muting_notifications ?? false,
		requested: relationship.requested ?? false,
		requested_by: relationship.requested_by ?? false,
		domain_blocking: relationship.domain_blocking ?? false,
		endorsed: relationship.endorsed ?? false,
		note: relationship.note ?? '',
	};
}
