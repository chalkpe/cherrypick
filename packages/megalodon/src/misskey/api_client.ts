import axios, { type AxiosResponse, type AxiosRequestConfig } from 'axios'
import dayjs from 'dayjs'

import { DEFAULT_UA } from '../default.js'
import { type Response } from '../response.js'
import * as Entity from './entity.js'
import * as MegalodonEntity from '../entity.js'
import * as MisskeyNotificationType from './notification.js'
import * as NotificationType from '../notification.js'
import { UnknownNotificationTypeError } from '../notification.js';

export type * as Entity from './entity.js';

export namespace Converter {
	export const announcement = (a: Entity.Announcement): MegalodonEntity.Announcement => ({
		id: a.id,
		content: a.title + '\n' + a.text,
		starts_at: null,
		ends_at: null,
		published: true,
		all_day: true,
		published_at: a.createdAt,
		updated_at: a.updatedAt,
		read: a.isRead !== undefined ? a.isRead : null,
		mentions: [],
		statuses: [],
		tags: [],
		emojis: [],
		reactions: []
	})

	export const emoji = (e: Entity.Emoji): MegalodonEntity.Emoji => {
		return {
			shortcode: e.name,
			static_url: e.url,
			url: e.url,
			visible_in_picker: true,
			category: e.category
		}
	}

	export const user = (u: Entity.User, host: string | null = null): MegalodonEntity.Account => {
		let acct = u.username;
		host ? host = host.replace("https://", "") : undefined;
		let acctUrl = `https://${host || u.host || host}/@${
			u.username
		}`;
		if (u.host) {
			acct = `${u.username}@${u.host}`;
			acctUrl = `https://${u.host}/@${u.username}`;
		}
		const fqn = `${u.username}@${u.host ?? host}`;
		return {
			id: u.id,
			fqn: fqn,
			username: u.username,
			acct: acct,
			display_name: u.name ? u.name : '',
			locked: false,
			group: null,
			noindex: null,
			suspended: null,
			limited: null,
			created_at: u.createdAt ? u.createdAt : '',
			followers_count: u.followersCount ? u.followersCount : 0,
			following_count: u.followingCount ? u.followingCount : 0,
			statuses_count: u.notesCount ? u.notesCount : 0,
			note: u.description ? u.description : '',
			url: u.uri ?? acctUrl,
			avatar: u.avatarUrl ? u.avatarUrl : 'https://dev.joinsharkey.org/static-assets/avatar.png',
			avatar_static: u.avatarUrl ? u.avatarUrl : 'https://dev.joinsharkey.org/static-assets/avatar.png',
			header: u.bannerUrl ? u.bannerUrl : 'https://dev.joinsharkey.org/static-assets/transparent.png',
			header_static: u.bannerUrl ? u.bannerUrl : 'https://dev.joinsharkey.org/static-assets/transparent.png',
			emojis: mapEmojis(u.emojis),
			moved: null,
			fields: [],
			bot: null
		}
	}

	export const userDetail = (u: Entity.UserDetail, host: string | null = null): MegalodonEntity.Account => {
		let acct = u.username;
		host ? host = host.replace("https://", "") : undefined;
		let acctUrl = `https://${u.host || host}/@${u.username}`;
		if (u.host) {
			acct = `${u.username}@${u.host}`;
			acctUrl = `https://${u.host}/@${u.username}`;
		}
		return {
			id: u.id,
			username: u.username,
			acct: acct,
			display_name: u.name ? u.name : '',
			locked: u.isLocked,
			group: null,
			noindex: null,
			suspended: null,
			limited: null,
			created_at: u.createdAt,
			followers_count: u.followersCount,
			following_count: u.followingCount,
			statuses_count: u.notesCount,
			note: u.description ? u.description.replace(/\n|\\n/g, "<br>") : '',
			url: u.uri ?? acctUrl,
			avatar: u.avatarUrl ? u.avatarUrl : 'https://dev.joinsharkey.org/static-assets/avatar.png',
			avatar_static: u.avatarUrl ? u.avatarUrl : 'https://dev.joinsharkey.org/static-assets/avatar.png',
			header: u.bannerUrl ? u.bannerUrl : 'https://dev.joinsharkey.org/static-assets/transparent.png',
			header_static: u.bannerUrl ? u.bannerUrl : 'https://dev.joinsharkey.org/static-assets/transparent.png',
			emojis: mapEmojis(u.emojis),
			moved: null,
			fields: [],
			bot: u.isBot
		}
	}

	export const userPreferences = (v: "public" | "unlisted" | "private" | "direct"): MegalodonEntity.Preferences => {
		return {
			"reading:expand:media": "default",
			"reading:expand:spoilers": false,
			"posting:default:language": "english",
			"posting:default:sensitive": false,
			"posting:default:visibility": v,
		};
	};

	export const visibility = (v: 'public' | 'home' | 'followers' | 'specified'): 'public' | 'unlisted' | 'private' | 'direct' => {
		switch (v) {
			case 'public':
				return v
			case 'home':
				return 'unlisted'
			case 'followers':
				return 'private'
			case 'specified':
				return 'direct'
		}
	}

	export const encodeVisibility = (v: 'public' | 'unlisted' | 'private' | 'direct' | 'local'): 'public' | 'home' | 'followers' | 'specified' => {
		switch (v) {
			// Pleroma / Akkoma local-only posts are public notes with localOnly
			case 'local':
			case 'public':
				return 'public'
			case 'unlisted':
				return 'home'
			case 'private':
				return 'followers'
			case 'direct':
				return 'specified'
		}
	}

	export const fileType = (s: string): 'unknown' | 'image' | 'gifv' | 'video' | 'audio' => {
		if (s === 'image/gif') {
			return 'gifv'
		}
		if (s.includes('image')) {
			return 'image'
		}
		if (s.includes('video')) {
			return 'video'
		}
		if (s.includes('audio')) {
			return 'audio'
		}
		return 'unknown'
	}

	export const file = (f: Entity.File): MegalodonEntity.Attachment => {
		return {
			id: f.id,
			type: fileType(f.type),
			url: f.url,
			remote_url: f.url,
			preview_url: f.thumbnailUrl,
			text_url: f.url,
			meta: {
				width: f.properties.width,
				height: f.properties.height
			},
			description: f.comment ? f.comment : null,
			blurhash: f.blurhash ? f.blurhash : null
		}
	}

	export const follower = (f: Entity.Follower): MegalodonEntity.Account => {
		return user(f.follower)
	}

	export const following = (f: Entity.Following): MegalodonEntity.Account => {
		return user(f.followee)
	}

	export const relation = (r: Entity.Relation): MegalodonEntity.Relationship => {
		return {
			id: r.id,
			following: r.isFollowing,
			followed_by: r.isFollowed,
			blocking: r.isBlocking,
			blocked_by: r.isBlocked,
			muting: r.isMuted,
			muting_notifications: r.isMuted,
			requested: r.hasPendingFollowRequestFromYou,
			requested_by: r.hasPendingFollowRequestToYou,
			domain_blocking: r.isInstanceMuted ?? false,
			showing_reblogs: !r.isRenoteMuted,
			endorsed: false,
			// Notifications of new notes are a setting of the following itself
			notifying: r.following?.notify === 'normal',
			note: r.memo ?? '',
		}
	}

	export const choice = (c: Entity.Choice): MegalodonEntity.PollOption => {
		return {
			title: c.text,
			votes_count: c.votes
		}
	}

	export const poll = (p: Entity.Poll, id: string): MegalodonEntity.Poll => {
		const now = dayjs()
		const expire = dayjs(p.expiresAt)
		const count = p.choices.reduce((sum, choice) => sum + choice.votes, 0)
		return {
			id: id,
			expires_at: p.expiresAt,
			expired: now.isAfter(expire),
			multiple: p.multiple,
			votes_count: count,
			options: Array.isArray(p.choices) ? p.choices.map(c => choice(c)) : [],
			voted: Array.isArray(p.choices) ? p.choices.some(c => c.isVoted) : false,
			own_votes: Array.isArray(p.choices) ? p.choices.filter((c) => c.isVoted).map((c) => p.choices.indexOf(c)) : [],
			emojis: [],
		}
	}

	export const note = (n: Entity.Note, host: string | null = null): MegalodonEntity.Status => {
		host ? host = host.replace("https://", "") : null;
		return {
			id: n.id,
			uri: n.uri ? n.uri : host ? `https://${host}/notes/${n.id}` : '',
			url: n.url ? n.url : host ? `https://${host}/notes/${n.id}` : '',
			account: user(n.user, n.user.host ? n.user.host : host ? host : null),
			in_reply_to_id: n.replyId,
			in_reply_to_account_id: n.reply?.userId ?? null,
			reblog: n.renote ? note(n.renote, n.user.host ? n.user.host : host ? host : null) : null,
			content: n.text
				? n.text
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#39;')
					.replace(/`/g, '&#x60;')
					.replace(/\r?\n/g, '<br>')
				: '',
			plain_content: n.text ? n.text : null,
			created_at: n.createdAt,
			edited_at: n.updatedAt || null,
			// TODO this is probably wrong
			emojis: mapEmojis(n.emojis).concat(mapReactionEmojis(n.reactionEmojis)),
			replies_count: n.repliesCount,
			reblogs_count: n.renoteCount,
			favourites_count: getTotalReactions(n.reactions),
			reblogged: false,
			favourited: !!n.myReaction,
			muted: false,
			sensitive: Array.isArray(n.files) ? n.files.some(f => f.isSensitive) : false,
			spoiler_text: n.cw ? n.cw : '',
			visibility: visibility(n.visibility),
			media_attachments: Array.isArray(n.files) ? n.files.map(f => file(f)) : [],
			mentions: [],
			tags: [],
			card: null,
			poll: n.poll ? poll(n.poll, n.id) : null,
			application: null,
			language: null,
			pinned: null,
			emoji_reactions: typeof n.reactions === 'object' ? mapReactions(n.reactions, n.reactionEmojis, n.myReaction) : [],
			bookmarked: false,
			quote: n.renote && n.text ? note(n.renote, n.user.host ? n.user.host : host ? host : null) : null
		}
	}

	export const noteWithText = (n: Entity.Note, host: string | null = null): MegalodonEntity.StatusWithText => {
		return {
			...note(n, host),
			text: n.text ?? ''
		}
	}

	export const notesource = (n: Entity.Note): MegalodonEntity.StatusSource => {
		return {
			id: n.id,
			text: n.text ?? '',
			spoiler_text: n.cw ? n.cw : ''
		}
	}

	const mapEmojis = (e: Array<Entity.Emoji> | { [key: string]: string }): Array<MegalodonEntity.Emoji> => {
		if (Array.isArray(e)) {
			return e.map(e => emoji(e))
		} else if (e) {
			return mapReactionEmojis(e)
		} else {
			return []
		}
	}

	export const getTotalReactions = (r: { [key: string]: number }): number => {
		return Object.values(r).length > 0 ? Object.values(r).reduce(
			(previousValue, currentValue) => previousValue + currentValue,
		) : 0;
	};

	export const mapReactions = (r: { [key: string]: number }, e: Record<string, string | undefined>, myReaction?: string): Array<MegalodonEntity.Reaction> => {
		return Object.entries(r).map(([key, count]) => {
			const me = myReaction != null && key === myReaction;

			// Name is equal to the key for native emoji reactions, and as a fallback.
			let name = key;

			// Custom emoji have a leading / trailing ":", which we need to remove.
			const match = key.match(/^:([^@:]+)(@[^:]+)?:$/);
			if (match) {
				const [, prefix, host] = match;

				// Local custom emoji end in "@.", which we need to remove.
				if (host && host !== '@.') {
					name = prefix + host;
				} else {
					name = prefix;
				}
			}

			return {
				count,
				me,
				name,
				url: e[name],
				static_url: e[name],
			}
		})
	}

	// TODO implement other properties
	const mapReactionEmojis = (r: { [key: string]: string }): Array<MegalodonEntity.Emoji> => {
		return Object.keys(r).map(key => ({
			shortcode: key,
			static_url: r[key],
			url: r[key],
			visible_in_picker: true,
			category: ''
		}))
	}

	export const reactions = (r: Array<Entity.Reaction>): Array<MegalodonEntity.Reaction> => {
		const result: Array<MegalodonEntity.Reaction> = []
		r.map(e => {
			const i = result.findIndex(res => res.name === e.type)
			if (i >= 0) {
				result[i].count++
			} else {
				result.push({
					count: 1,
					me: false,
					name: e.type,
				})
			}
		})
		return result
	}

	export const noteToConversation = (n: Entity.Note): MegalodonEntity.Conversation => {
		const accounts: Array<MegalodonEntity.Account> = [user(n.user)]
		if (n.reply) {
			accounts.push(user(n.reply.user))
		}
		return {
			id: n.id,
			accounts: accounts,
			last_status: note(n),
			unread: false
		}
	}

	export const list = (l: Entity.List): MegalodonEntity.List => ({
		id: l.id,
		title: l.name,
		exclusive: null
	})

	// Misskey notification types that have a megalodon counterpart. Notification lists leave out the others.
	const notificationTypeMap: ReadonlyMap<Entity.NotificationType, MegalodonEntity.NotificationType> = new Map([
		// followRequestAccepted means the other user accepted our request, which Mastodon has no notification for
		[MisskeyNotificationType.Follow, NotificationType.Follow],
		[MisskeyNotificationType.Mention, NotificationType.Mention],
		[MisskeyNotificationType.Reply, NotificationType.Mention],
		[MisskeyNotificationType.Renote, NotificationType.Reblog],
		[MisskeyNotificationType.Quote, NotificationType.Quote],
		[MisskeyNotificationType.Reaction, NotificationType.EmojiReaction],
		[MisskeyNotificationType.PollVote, NotificationType.PollVote],
		[MisskeyNotificationType.PollEnded, NotificationType.PollExpired],
		[MisskeyNotificationType.Note, NotificationType.Status],
		[MisskeyNotificationType.ReceiveFollowRequest, NotificationType.FollowRequest],
	])

	/**
	 * Misskey notification types that decodeNotificationType can decode.
	 */
	export const decodableNotificationTypes: ReadonlyArray<Entity.NotificationType> = [...notificationTypeMap.keys()]

	/**
	 * Misskey notification types behind the given megalodon notification types, the reverse of decodeNotificationType.
	 * Types without a Misskey counterpart are left out.
	 */
	export const encodeNotificationTypes = (types: ReadonlyArray<MegalodonEntity.NotificationType>): Array<Entity.NotificationType> => {
		// Misskey reactions are favourites as well
		const wanted = new Set(types.map(t => (t === NotificationType.Favourite ? NotificationType.EmojiReaction : t)))
		return decodableNotificationTypes.filter(t => wanted.has(notificationTypeMap.get(t)!))
	}

	export const decodeNotificationType = (
		e: Entity.NotificationType
	): MegalodonEntity.NotificationType | UnknownNotificationTypeError => {
		return notificationTypeMap.get(e) ?? new UnknownNotificationTypeError()
	}

	export const notification = (n: Entity.Notification): MegalodonEntity.Notification | UnknownNotificationTypeError => {
		const notificationType = decodeNotificationType(n.type)
		if (notificationType instanceof UnknownNotificationTypeError) {
			return notificationType
		}
		// Notifications from the system, such as ended polls, have no user, so they come from the author of the note
		const account = n.user ?? n.note?.user
		if (!account) {
			return new UnknownNotificationTypeError()
		}
		let notification = {
			id: n.id,
			account: user(account),
			created_at: n.createdAt,
			type: notificationType
		}
		if (n.note) {
			notification = Object.assign(notification, {
				status: note(n.note)
			})
		}
		if (n.reaction) {
			notification = Object.assign(notification, {
				emoji: n.reaction
			})
		}
		return notification
	}

	export const stats = (s: Entity.Stats): MegalodonEntity.Stats => {
		return {
			user_count: s.originalUsersCount,
			status_count: s.originalNotesCount,
			domain_count: s.instances
		}
	}

	export const meta = (m: Entity.Meta, s: Entity.Stats): MegalodonEntity.Instance => {
		const wss = m.uri.replace(/^https:\/\//, 'wss://')
		return {
			uri: m.uri,
			title: m.name,
			description: m.description,
			email: m.maintainerEmail,
			version: m.version,
			thumbnail: m.bannerUrl,
			urls: {
				streaming_api: `${wss}/streaming`
			},
			stats: stats(s),
			languages: m.langs,
			registrations: !m.disableRegistration,
			approval_required: false,
			configuration: {
				statuses: {
					max_characters: m.maxNoteTextLength,
					max_media_attachments: m.policies.clipLimit
				}
			},
			rules: m.serverRules.map((r, index) => ({
				id: (index + 1).toString(),
				text: r,
			}))
		}
	}

	export const hashtag = (h: Entity.Hashtag): MegalodonEntity.Tag => {
		return {
			name: h.tag,
			url: h.tag,
			history: [],
			following: false
		}
	}
}

export const DEFAULT_SCOPE = [
	'read:account',
	'write:account',
	'read:blocks',
	'write:blocks',
	'read:drive',
	'write:drive',
	'read:favorites',
	'write:favorites',
	'read:following',
	'write:following',
	'read:mutes',
	'write:mutes',
	'write:notes',
	'read:notifications',
	'write:notifications',
	'read:reactions',
	'write:reactions',
	'write:votes'
]

/**
 * Interface
 */
export interface Interface {
	get<T = any>(path: string, params?: any, headers?: { [key: string]: string }): Promise<Response<T>>
	post<T = any>(path: string, params?: any, headers?: { [key: string]: string }): Promise<Response<T>>
	cancel(): void
}

/**
 * Transport options for talking to the Misskey API
 */
export interface ClientOptions {
	/** Base URL for HTTP requests, when it differs from the public base URL used in entities */
	apiUrl?: string
	/** Unix domain socket to connect to instead of TCP */
	socketPath?: string
	/** Headers sent with every request */
	headers?: { [key: string]: string }
	/** false to connect directly, ignoring the HTTP_PROXY / HTTPS_PROXY environment variables axios follows by default */
	proxy?: false
}

/**
 * Misskey API client.
 *
 * Using axios for request, you will handle promises.
 */
export class Client implements Interface {
	private accessToken: string | null
	private baseUrl: string
	private userAgent: string
	private abortController: AbortController
	private socketPath: string | undefined
	private defaultHeaders: { [key: string]: string }
	private proxy: false | undefined

	/**
	 * @param baseUrl hostname or base URL
	 * @param accessToken access token from OAuth2 authorization
	 * @param userAgent UserAgent is specified in header on request.
	 * @param options transport options
	 */
	constructor(baseUrl: string, accessToken: string | null, userAgent: string = DEFAULT_UA, options: ClientOptions = {}) {
		this.accessToken = accessToken
		this.baseUrl = options.apiUrl ?? baseUrl
		this.userAgent = userAgent
		this.abortController = new AbortController();
		this.socketPath = options.socketPath
		this.defaultHeaders = options.headers ?? {}
		this.proxy = options.proxy
	}

	/**
	 * GET request to misskey API.
	 **/
	public async get<T>(path: string, params: any = {}, headers: { [key: string]: string } = {}): Promise<Response<T>> {
		headers = { ...this.defaultHeaders, ...headers };
		if (!headers['Authorization'] && this.accessToken) {
			headers['Authorization'] = `Bearer ${this.accessToken}`;
		}
		if (!headers['User-Agent']) {
			headers['User-Agent'] = this.userAgent;
		}

		let options: AxiosRequestConfig = {
			params: params,
			headers,
			maxContentLength: Infinity,
			maxBodyLength: Infinity,
			signal: this.abortController.signal,
			socketPath: this.socketPath,
			proxy: this.proxy,
		}
		return axios.get<T>(this.baseUrl + path, options).then((resp: AxiosResponse<T>) => {
			const res: Response<T> = {
				data: resp.data,
				status: resp.status,
				statusText: resp.statusText,
				headers: resp.headers
			}
			return res
		})
	}

	/**
	 * POST request to misskey REST API.
	 * @param path relative path from baseUrl
	 * @param params Form data
	 * @param headers Request header object
	 */
	public async post<T>(path: string, params: any = {}, headers: { [key: string]: string } = {}): Promise<Response<T>> {
		headers = { ...this.defaultHeaders, ...headers };
		if (!headers['Authorization'] && this.accessToken) {
			headers['Authorization'] = `Bearer ${this.accessToken}`;
		}
		if (!headers['User-Agent']) {
			headers['User-Agent'] = this.userAgent;
		}

		let options: AxiosRequestConfig = {
			headers: headers,
			maxContentLength: Infinity,
			maxBodyLength: Infinity,
			signal: this.abortController.signal,
			socketPath: this.socketPath,
			proxy: this.proxy,
		}

		return axios.post<T>(this.baseUrl + path, params, options).then((resp: AxiosResponse<T>) => {
			const res: Response<T> = {
				data: resp.data,
				status: resp.status,
				statusText: resp.statusText,
				headers: resp.headers
			}
			return res
		})
	}

	/**
	 * Cancel all requests in this instance.
	 * @returns void
	 */
	public cancel(): void {
		return this.abortController.abort()
	}
}
