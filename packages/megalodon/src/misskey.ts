import * as MisskeyAPI from './misskey/api_client.js'
import { DEFAULT_UA } from './default.js'
import * as OAuth from './oauth.js'
import { type Response, type PagedResponse } from './response.js'
import * as Entity from './entity.js'
import { type MegalodonInterface, NoImplementedError, ArgumentError, UnexpectedError } from './megalodon.js'
import { UnknownNotificationTypeError } from './notification.js'

// "user" or "user@host", with or without the leading "@"
const ACCT_PATTERN = /^@?(?<user>[a-zA-Z0-9_]+)(?:@(?<host>[a-zA-Z0-9-.]+\.[a-zA-Z0-9-]+)|)$/

const emptyResults = (): Entity.Results => ({ accounts: [], statuses: [], hashtags: [] })

/**
 * Ignores the Misskey API errors that only mean the note already is in the requested state,
 * as the matching Mastodon actions succeed when repeated.
 */
const ignoreApiErrors = (codes: Array<string>) => (err: unknown): void => {
  const code = (err as { response?: { data?: { error?: { code?: string } } } } | null)?.response?.data?.error?.code
  if (code && codes.includes(code)) return
  throw err
}

type PageOptions = {
  limit?: number
  max_id?: string
  since_id?: string
  min_id?: string
}

/**
 * Misskey pagination parameters for Mastodon's.
 * Misskey's sinceId returns the oldest items after it, oldest first, which is Mastodon's min_id.
 * Mastodon's since_id asks for the newest items instead, so it is not sent and newerThan applies it to the newest page.
 */
const pageParams = (options?: PageOptions): { limit?: number; untilId?: string; sinceId?: string } => {
  const params: { limit?: number; untilId?: string; sinceId?: string } = {}
  if (options?.limit) params.limit = options.limit
  if (options?.max_id) params.untilId = options.max_id
  if (options?.min_id) params.sinceId = options.min_id
  return params
}

/**
 * Keeps the items newer than Mastodon's since_id, on a page fetched with pageParams.
 */
const newerThan = <T>(items: Array<T>, sinceId: string | undefined, getId: (item: T) => string): Array<T> =>
  sinceId ? items.filter(item => getId(item) > sinceId) : items

/**
 * Newest first page of a list that Misskey paginates by records other than the returned entities, such as follow relations.
 * The record IDs are kept in pageIds, as pagination links must point at them rather than at the entities.
 */
const recordPage = <R extends { id: string }, T>(
  res: Response<Array<R>>,
  options: PageOptions | undefined,
  convert: (record: R) => T
): PagedResponse<Array<T>> => {
  const records = newerThan(res.data, options?.since_id, r => r.id).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return { ...res, data: records.map(convert), pageIds: records.map(r => r.id) }
}

export default class Misskey implements MegalodonInterface {
  public client: MisskeyAPI.Interface
  public baseUrl: string

  /**
   * @param baseUrl hostname or base URL
   * @param accessToken access token from OAuth2 authorization
   * @param userAgent UserAgent is specified in header on request.
   * @param options transport options, such as a different URL to send requests to
   */
  constructor(
    baseUrl: string,
    accessToken: string | null = null,
    userAgent: string | null = DEFAULT_UA,
    options: MisskeyAPI.ClientOptions = {},
  ) {
    let token: string = ''
    if (accessToken) {
      token = accessToken
    }
    let agent: string = DEFAULT_UA
    if (userAgent) {
      agent = userAgent
    }
    this.client = new MisskeyAPI.Client(baseUrl, token, agent, options)
    this.baseUrl = baseUrl
  }

  /**
   * POST to any Misskey API endpoint, for endpoints this class does not wrap.
   * @param path path including /api/, such as /api/notes/featured
   */
  public async callApi<T = unknown>(path: string, params: any = {}): Promise<Response<T>> {
    return this.client.post<T>(path, params)
  }

  public cancel(): void {
    return this.client.cancel()
  }

  public async registerApp(
    client_name: string,
    options: Partial<{ scopes: Array<string>; redirect_uri: string; website?: string }> = {
      scopes: MisskeyAPI.DEFAULT_SCOPE,
      redirect_uri: this.baseUrl
    }
  ): Promise<OAuth.AppData> {
    return this.createApp(client_name, options).then(async appData => {
      return this.generateAuthUrlAndToken(appData.client_secret).then(session => {
        appData.url = session.url
        appData.session_token = session.token
        return appData
      })
    })
  }

  /**
   * POST /api/app/create
   *
   * Create an application.
   * @param client_name Your application's name.
   * @param options Form data.
   */
  public async createApp(
    client_name: string,
    options: Partial<{ scopes: Array<string>; redirect_uri: string; website?: string }> = {
      scopes: MisskeyAPI.DEFAULT_SCOPE,
      redirect_uri: this.baseUrl
    }
  ): Promise<OAuth.AppData> {
    const redirect_uri = options.redirect_uri || this.baseUrl
    const scopes = options.scopes || MisskeyAPI.DEFAULT_SCOPE
		const website = options.website ?? '';

    const params: {
      name: string
      description: string
      permission: Array<string>
      callbackUrl: string
    } = {
      name: client_name,
      description: website,
      permission: scopes,
      callbackUrl: redirect_uri
    }

    /**
     * The response is:
     {
       "id": "xxxxxxxxxx",
       "name": "string",
       "callbackUrl": "string",
       "permission": [
         "string"
       ],
       "secret": "string"
     }
    */
    return this.client.post<MisskeyAPI.Entity.App>('/api/app/create', params).then((res: Response<MisskeyAPI.Entity.App>) => {
      const appData: OAuth.AppDataFromServer = {
        id: res.data.id,
        name: res.data.name,
        website: null,
        redirect_uri: res.data.callbackUrl,
        client_id: '',
        client_secret: res.data.secret!
      }
      return OAuth.AppData.from(appData)
    })
  }

  /**
   * POST /api/auth/session/generate
   */
  public async generateAuthUrlAndToken(clientSecret: string): Promise<MisskeyAPI.Entity.Session> {
    return this.client
      .post<MisskeyAPI.Entity.Session>('/api/auth/session/generate', {
        appSecret: clientSecret
      })
      .then((res: Response<MisskeyAPI.Entity.Session>) => res.data)
  }

  // ======================================
  // apps
  // ======================================
  public async verifyAppCredentials(): Promise<Response<MisskeyAPI.Entity.App>> {
    // CherryPick resolves the current app from the access token on the server side instead.
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // apps/oauth
  // ======================================
  /**
   * POST /api/auth/session/userkey
   *
   * @param _client_id This parameter is not used in this method.
   * @param client_secret Application secret key which will be provided in createApp.
   * @param session_token Session token string which will be provided in generateAuthUrlAndToken.
   * @param _redirect_uri This parameter is not used in this method.
   */
  public async fetchAccessToken(
    _client_id: string | null,
    client_secret: string,
    session_token: string,
    _redirect_uri?: string
  ): Promise<OAuth.TokenData> {
    return this.client
      .post<MisskeyAPI.Entity.UserKey>('/api/auth/session/userkey', {
        appSecret: client_secret,
        token: session_token
      })
      .then(res => {
        const token = new OAuth.TokenData(res.data.accessToken, 'misskey', '', 0, null, null)
        return token
      })
  }

  public async refreshToken(_client_id: string, _client_secret: string, _refresh_token: string): Promise<OAuth.TokenData> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async revokeToken(_client_id: string, _client_secret: string, _token: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // accounts
  // ======================================
  public async registerAccount(
    _username: string,
    _email: string,
    _password: string,
    _agreement: boolean,
    _locale: string,
    _reason?: string | null
  ): Promise<Response<Entity.Token>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/i
   */
  public async verifyAccountCredentials(): Promise<Response<Entity.Account>> {
    return this.client.post<MisskeyAPI.Entity.UserDetail>('/api/i').then(res => {
      return Object.assign(res, {
        data: MisskeyAPI.Converter.userDetail(res.data)
      })
    })
  }

  /**
   * POST /api/i/update
   */
  public async updateCredentials(options?: {
    discoverable?: boolean
    bot?: boolean
    display_name?: string
    note?: string
    avatar?: string
    header?: string
    locked?: boolean
    hide_collections?: boolean
    source?: {
      privacy?: string
      sensitive?: boolean
      language?: string
    } | null
    fields_attributes?: Array<{ name: string; value: string }>
  }): Promise<Response<Entity.Account>> {
    const params: Record<string, unknown> = {}
    if (options) {
      if (options.bot !== undefined) params.isBot = options.bot
      if (options.locked !== undefined) params.isLocked = options.locked
      if (options.discoverable !== undefined) params.isExplorable = options.discoverable
      // An empty name or bio removes it
      if (options.display_name !== undefined) params.name = options.display_name || null
      if (options.note !== undefined) params.description = options.note || null
      if (options.avatar) params.avatarId = options.avatar
      if (options.header) params.bannerId = options.header
      if (options.fields_attributes) params.fields = options.fields_attributes
      // Mastodon hides both lists at once
      if (options.hide_collections !== undefined) {
        params.followersVisibility = options.hide_collections ? 'private' : 'public'
        params.followingVisibility = options.hide_collections ? 'private' : 'public'
      }
      if (options.source) {
        if (options.source.language !== undefined) params.lang = options.source.language || null
        if (options.source.sensitive !== undefined) params.alwaysMarkNsfw = options.source.sensitive
      }
    }
    return this.client.post<MisskeyAPI.Entity.UserDetail>('/api/i/update', params).then(res => {
      return Object.assign(res, {
        data: MisskeyAPI.Converter.userDetail(res.data)
      })
    })
  }

  /**
   * POST /api/users/show
   */
  public async getAccount(id: string): Promise<Response<Entity.Account>> {
    return this.client
      .post<MisskeyAPI.Entity.UserDetail>('/api/users/show', {
        userId: id
      })
      .then(res => {
        return Object.assign(res, {
          data: MisskeyAPI.Converter.userDetail(res.data, this.baseUrl)
        })
      })
  }

  /**
   * POST /api/users/notes
   */
  public async getAccountStatuses(
    id: string,
    options?: PageOptions & {
      pinned?: boolean
      exclude_replies?: boolean
      exclude_reblogs?: boolean
      only_media?: boolean
    }
  ): Promise<Response<Array<Entity.Status>>> {
    if (options && options.pinned) {
      return this.client
        .post<MisskeyAPI.Entity.UserDetail>('/api/users/show', {
          userId: id
        })
        .then(res => {
          if (res.data.pinnedNotes) {
            return { ...res, data: res.data.pinnedNotes.map(n => MisskeyAPI.Converter.note(n, this.baseUrl)) }
          }
          return { ...res, data: [] }
        })
    }

    let params = {
      userId: id,
      ...pageParams(options)
    }
    if (options) {
      // Mastodon includes replies and boosts unless they are excluded, while Misskey leaves out replies by default.
      // Misskey cannot list replies along with the media-only list, so that one keeps its own choice of replies.
      params = Object.assign(params, {
        withReplies: !options.only_media && !options.exclude_replies,
        withRenotes: !options.exclude_reblogs,
        withFiles: !!options.only_media
      })
    }
    return this.client.post<Array<MisskeyAPI.Entity.Note>>('/api/users/notes', params).then(res => {
      const statuses: Array<Entity.Status> = newerThan(res.data, options?.since_id, n => n.id).map(note => MisskeyAPI.Converter.note(note, this.baseUrl))
      return Object.assign(res, {
        data: statuses
      })
    })
  }

  public async getAccountFavourites(
    _id: string,
    _options?: {
      limit?: number
      max_id?: string
      since_id?: string
    }
  ): Promise<Response<Array<Entity.Status>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async subscribeAccount(_id: string): Promise<Response<Entity.Relationship>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async unsubscribeAccount(_id: string): Promise<Response<Entity.Relationship>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/users/followers
   */
  public async getAccountFollowers(id: string, options?: PageOptions): Promise<PagedResponse<Array<Entity.Account>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Follower>>('/api/users/followers', { userId: id, ...pageParams(options) })
      .then(res => recordPage(res, options, f => MisskeyAPI.Converter.follower(f)))
  }

  /**
   * POST /api/users/following
   */
  public async getAccountFollowing(id: string, options?: PageOptions): Promise<PagedResponse<Array<Entity.Account>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Following>>('/api/users/following', { userId: id, ...pageParams(options) })
      .then(res => recordPage(res, options, f => MisskeyAPI.Converter.following(f)))
  }

  /**
   * POST /api/users/lists/list
   *
   * Lists of the current user that contain the account.
   */
  public async getAccountLists(id: string): Promise<Response<Array<Entity.List>>> {
    return this.client.post<Array<MisskeyAPI.Entity.List>>('/api/users/lists/list').then(res => ({
      ...res,
      data: res.data.filter(l => l.userIds.includes(id)).map(l => MisskeyAPI.Converter.list(l))
    }))
  }

  public async getIdentityProof(_id: string): Promise<Response<Array<Entity.IdentityProof>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/following/create
   *
   * Following again is not an error, as Mastodon clients change the options of a follow this way.
   * @param options.reblogs whether boosts of the account are shown, backed by Misskey renote mutes
   * @param options.notify whether new posts of the account are notified
   */
  public async followAccount(id: string, options?: { reblogs?: boolean; notify?: boolean }): Promise<Response<Entity.Relationship>> {
    const current = (await this.getRelationship(id)).data
    if (!current.following && !current.requested) {
      await this.client.post<{}>('/api/following/create', {
        userId: id
      })
    }

    if (options?.reblogs !== undefined && options.reblogs !== current.showing_reblogs) {
      await this.client.post<{}>(options.reblogs ? '/api/renote-mute/delete' : '/api/renote-mute/create', { userId: id })
    }
    // Only an established follow has notification settings, not a pending request
    if (options?.notify !== undefined && options.notify !== current.notifying && current.following) {
      await this.client.post<{}>('/api/following/update', { userId: id, notify: options.notify ? 'normal' : 'none' })
    }
    return this.getRelationship(id)
  }

  /**
   * POST /api/following/delete
   */
  public async unfollowAccount(id: string): Promise<Response<Entity.Relationship>> {
    const current = (await this.getRelationship(id)).data
    if (current.following) {
      await this.client.post<{}>('/api/following/delete', {
        userId: id
      }).catch(ignoreApiErrors(['NOT_FOLLOWING']))
    }
    // Mastodon also withdraws a pending follow request
    if (current.requested) {
      await this.client.post<{}>('/api/following/requests/cancel', {
        userId: id
      }).catch(ignoreApiErrors(['FOLLOW_REQUEST_NOT_FOUND']))
    }
    return this.getRelationship(id)
  }

  /**
   * POST /api/blocking/create
   */
  public async blockAccount(id: string): Promise<Response<Entity.Relationship>> {
    await this.client.post<{}>('/api/blocking/create', {
      userId: id
    }).catch(ignoreApiErrors(['ALREADY_BLOCKING']))
    return this.getRelationship(id)
  }

  /**
   * POST /api/blocking/delete
   */
  public async unblockAccount(id: string): Promise<Response<Entity.Relationship>> {
    await this.client.post<{}>('/api/blocking/delete', {
      userId: id
    }).catch(ignoreApiErrors(['NOT_BLOCKING']))
    return this.getRelationship(id)
  }

  /**
   * POST /api/mute/create
   */
  public async muteAccount(id: string, _notifications: boolean, options?: { duration?: number }): Promise<Response<Entity.Relationship>> {
    const params = {
      userId: id,
      // Mastodon takes the duration in seconds, where 0 means indefinitely
      expiresAt: options?.duration ? Date.now() + options.duration * 1000 : null
    }
    await this.client.post<{}>('/api/mute/create', params).catch(async (err: unknown) => {
      ignoreApiErrors(['ALREADY_MUTING'])(err)
      // Muting again replaces the duration in Mastodon
      await this.client.post<{}>('/api/mute/delete', { userId: id }).catch(ignoreApiErrors(['NOT_MUTING']))
      await this.client.post<{}>('/api/mute/create', params)
    })
    return this.getRelationship(id)
  }

  /**
   * POST /api/mute/delete
   */
  public async unmuteAccount(id: string): Promise<Response<Entity.Relationship>> {
    await this.client.post<{}>('/api/mute/delete', {
      userId: id
    }).catch(ignoreApiErrors(['NOT_MUTING']))
    return this.getRelationship(id)
  }

  public async pinAccount(_id: string): Promise<Response<Entity.Relationship>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async unpinAccount(_id: string): Promise<Response<Entity.Relationship>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/users/relation
   *
   * @param id The accountID, for example `'1sdfag'`
   */
  public async getRelationship(id: string): Promise<Response<Entity.Relationship>> {
    return this.client
      .post<MisskeyAPI.Entity.Relation[]>('/api/users/relation', {
        userId: id
      })
      .then(res => {
        return Object.assign(res, {
          data: MisskeyAPI.Converter.relation(res.data[0])
        })
      })
  }

  /**
   * POST /api/users/relation
   *
   * @param ids Array of account ID, for example `['1sdfag', 'ds12aa']`.
   */
  public async getRelationships(ids: string | Array<string>): Promise<Response<Array<Entity.Relationship>>> {
		return this.client
			.post<MisskeyAPI.Entity.Relation[]>('/api/users/relation', {
				userId: ids
			})
			.then(res => {
				return Object.assign(res, {
					data: res.data.map(r => MisskeyAPI.Converter.relation(r))
				})
			})
  }

  /**
   * POST /api/users/search
   */
  public async searchAccount(
    q: string,
    options?: {
      following?: boolean
      resolve?: boolean
      limit?: number
      max_id?: string
      since_id?: string
    }
  ): Promise<Response<Array<Entity.Account>>> {
    const limit = options?.limit ?? 20
    // The user search does not understand "user@host", so those are looked up by username and host instead
    const match = q.match(ACCT_PATTERN)
    const host = this.remoteHost(match?.groups?.host)
    if (match?.groups?.user && host) {
      const accounts = await this.findRemoteAccounts(match.groups.user, host, options?.resolve, limit)
      return { data: accounts, status: 200, statusText: 'OK', headers: {} }
    }

    const params = {
      query: q,
      detail: true,
      limit
    }
    return this.client.post<Array<MisskeyAPI.Entity.UserDetail>>('/api/users/search', params).then(res => {
      return Object.assign(res, {
        data: res.data.map(u => MisskeyAPI.Converter.userDetail(u, this.baseUrl))
      })
    })
  }

  /**
   * The host of an acct, or undefined when it is this server.
   */
  private remoteHost(host: string | undefined): string | undefined {
    if (!host) return undefined
    try {
      if (new URL(this.baseUrl).host.toLowerCase() === host.toLowerCase()) return undefined
    } catch {}
    return host
  }

  /**
   * Accounts of another server matching the username and host.
   * Only resolve looks up an account this server does not know yet, as on Mastodon.
   */
  private async findRemoteAccounts(username: string, host: string, resolve: boolean | undefined, limit: number): Promise<Array<Entity.Account>> {
    if (resolve) {
      const res = await this.client.post<MisskeyAPI.Entity.UserDetail>('/api/users/show', { username, host }).catch(() => null)
      return res ? [MisskeyAPI.Converter.userDetail(res.data, this.baseUrl)] : []
    }
    const res = await this.client.post<Array<MisskeyAPI.Entity.UserDetail>>('/api/users/search-by-username-and-host', {
      username,
      host,
      limit,
      detail: true
    })
    return res.data.map(u => MisskeyAPI.Converter.userDetail(u, this.baseUrl))
  }

  // ======================================
  // accounts/bookmarks
  // ======================================
	/**
	 * POST /api/i/favorites
	 */
  public async getBookmarks(options?: PageOptions): Promise<PagedResponse<Array<Entity.Status>>> {
		return this.client
			.post<Array<MisskeyAPI.Entity.Favorite>>('/api/i/favorites', pageParams(options))
			.then(res => recordPage(res, options, fav => MisskeyAPI.Converter.note(fav.note, this.baseUrl)))
  }

	/**
	 * POST /api/users/reactions
	 */
	public async getReactions(userId: string, options?: PageOptions): Promise<PagedResponse<MisskeyAPI.Entity.NoteReaction[]>> {
		return this.client
			.post<MisskeyAPI.Entity.NoteReaction[]>('/api/users/reactions', { userId, ...pageParams(options) })
			.then(res => recordPage(res, options, r => r))
	}

  // ======================================
  //  accounts/favourites
  // ======================================
  /**
   * POST /api/users/reactions
   */
  public async getFavourites(options?: PageOptions & { userId?: string }): Promise<PagedResponse<Array<Entity.Status>>> {
		const userId = options?.userId ?? (await this.verifyAccountCredentials()).data.id;

		const response = await this.getReactions(userId, options);

		return {
			...response,
			data: response.data.map(r => MisskeyAPI.Converter.note(r.note, this.baseUrl)),
		};
  }

  // ======================================
  // accounts/mutes
  // ======================================
  /**
   * POST /api/mute/list
   */
  public async getMutes(options?: PageOptions): Promise<PagedResponse<Array<Entity.Account>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Mute>>('/api/mute/list', pageParams(options))
      .then(res => recordPage(res, options, mute => ({ ...MisskeyAPI.Converter.userDetail(mute.mutee), mute_expires_at: mute.expiresAt })))
  }

  // ======================================
  // accounts/blocks
  // ======================================
  /**
   * POST /api/blocking/list
   */
  public async getBlocks(options?: PageOptions): Promise<PagedResponse<Array<Entity.Account>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Blocking>>('/api/blocking/list', pageParams(options))
      .then(res => recordPage(res, options, blocking => MisskeyAPI.Converter.userDetail(blocking.blockee)))
  }

  // ======================================
  // accounts/domain_blocks
  // ======================================
  public async getDomainBlocks(_options?: { limit?: number; max_id?: string; min_id?: string }): Promise<Response<Array<string>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async blockDomain(_domain: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async unblockDomain(_domain: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // accounts/filters
  // ======================================
  public async getFilters(): Promise<Response<Array<Entity.Filter>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async getFilter(_id: string): Promise<Response<Entity.Filter>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async createFilter(
    _phrase: string,
    _context: Array<string>,
    _options?: {
      irreversible?: boolean
      whole_word?: boolean
      expires_in?: string
    }
  ): Promise<Response<Entity.Filter>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async updateFilter(
    _id: string,
    _phrase: string,
    _context: Array<string>,
    _options?: {
      irreversible?: boolean
      whole_word?: boolean
      expires_in?: string
    }
  ): Promise<Response<Entity.Filter>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async deleteFilter(_id: string): Promise<Response<Entity.Filter>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // accounts/reports
  // ======================================
  /**
   * POST /api/users/report-abuse
   */
  public async report(
    account_id: string,
    options: {
      status_ids?: Array<string>
      comment: string
      forward?: boolean
      category: Entity.Category
      rule_ids?: Array<number>
    }
  ): Promise<Response<Entity.Report>> {
    const category: Entity.Category = 'other'
    return this.client
      .post<{}>('/api/users/report-abuse', {
        userId: account_id,
        comment: options.comment
      })
      .then(res => {
        return Object.assign(res, {
          data: {
            id: '',
            action_taken: false,
            action_taken_at: null,
            comment: options.comment,
            category: category,
            forwarded: false,
            status_ids: null,
            rule_ids: null
          }
        })
      })
  }

  // ======================================
  // accounts/follow_requests
  // ======================================
  /**
   * POST /api/following/requests/list
   */
  public async getFollowRequests(options?: PageOptions): Promise<PagedResponse<Array<Entity.Account>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.FollowRequest>>('/api/following/requests/list', pageParams(options))
      .then(res => recordPage(res, options, r => MisskeyAPI.Converter.user(r.follower)))
  }

  /**
   * POST /api/following/requests/accept
   */
  public async acceptFollowRequest(id: string): Promise<Response<Entity.Relationship>> {
    await this.client.post<{}>('/api/following/requests/accept', {
      userId: id
    })
    return this.getRelationship(id)
  }

  /**
   * POST /api/following/requests/reject
   */
  public async rejectFollowRequest(id: string): Promise<Response<Entity.Relationship>> {
    await this.client.post<{}>('/api/following/requests/reject', {
      userId: id
    })
    return this.getRelationship(id)
  }

  // ======================================
  // accounts/endorsements
  // ======================================
  public async getEndorsements(_options?: {
    limit?: number
    max_id?: string
    since_id?: string
  }): Promise<Response<Array<Entity.Account>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // accounts/featured_tags
  // ======================================
  public async getFeaturedTags(): Promise<Response<Array<Entity.FeaturedTag>>> {
    const tags: Entity.FeaturedTag[] = [];
		const res: Response = {
			headers: undefined,
			statusText: "",
			status: 200,
			data: tags,
		};
		return new Promise((resolve) => resolve(res));
  }

  public async createFeaturedTag(_name: string): Promise<Response<Entity.FeaturedTag>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async deleteFeaturedTag(_id: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async getSuggestedTags(): Promise<Response<Array<Entity.Tag>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // accounts/preferences
  // ======================================

  private async getDefaultPostPrivacy(): Promise<"public" | "unlisted" | "private" | "direct"> {
    // The default visibility lives in the web client's settings, which API tokens cannot read.
    // (Sharkey exposes it through its own i/registry/get-unsecure extension.)
    return "public"
  }

  public async getPreferences(): Promise<Response<Entity.Preferences>> {
    return this.client.post<MisskeyAPI.Entity.UserDetail>("/api/i")
			.then(async (res) => {
				return Object.assign(res, {
					data: MisskeyAPI.Converter.userPreferences(
						await this.getDefaultPostPrivacy(),
					),
				});
		});
  }

  // ======================================
  // accounts/followed_tags
  // ======================================
  public async getFollowedTags(): Promise<Response<Array<Entity.Tag>>> {
    const tags: Entity.Tag[] = [];
		const res: Response = {
			headers: undefined,
			statusText: "",
			status: 200,
			data: tags,
		};
		return new Promise((resolve) => resolve(res));
  }

  // ======================================
  // accounts/suggestions
  // ======================================
  /**
   * POST /api/users/recommendation
   */
  public async getSuggestions(limit?: number): Promise<Response<Array<Entity.Account>>> {
    let params = {}
    if (limit) {
      params = Object.assign(params, {
        limit: limit
      })
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.UserDetail>>('/api/users/recommendation', params)
      .then(res => ({ ...res, data: res.data.map(u => MisskeyAPI.Converter.userDetail(u)) }))
  }

  // ======================================
  // accounts/tags
  // ======================================
  /**
   * POST /api/hashtags/show
   *
   * Misskey cannot follow hashtags, so following is always false. Hashtags not used yet are answered as well.
   */
  public async getTag(id: string): Promise<Response<Entity.Tag>> {
    const name = id.replace(/^#/, '')
    const res = await this.client.post<MisskeyAPI.Entity.Hashtag>('/api/hashtags/show', { tag: name }).catch(() => null)
    return {
      data: { name: res?.data.tag ?? name, url: `${this.baseUrl}/tags/${encodeURIComponent(res?.data.tag ?? name)}`, history: [], following: false },
      status: 200,
      statusText: 'OK',
      headers: {}
    }
  }

  public async followTag(_id: string): Promise<Response<Entity.Tag>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async unfollowTag(_id: string): Promise<Response<Entity.Tag>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // statuses
  // ======================================
  public async postStatus(
    status: string,
    options?: {
      media_ids?: Array<string>
      poll?: { options: Array<string>; expires_in: number; multiple?: boolean; hide_totals?: boolean }
      in_reply_to_id?: string
      sensitive?: boolean
      spoiler_text?: string
      visibility?: 'public' | 'unlisted' | 'private' | 'direct' | 'local'
      scheduled_at?: string
      language?: string
      quote_id?: string
      quoted_status_id?: string
      local_only?: boolean
    }
  ): Promise<Response<Entity.Status>> {
    let params = {
      text: status
    }
    if (options) {
      if (options.sensitive && options.media_ids) {
        await this.markMediaSensitive(options.media_ids)
      }
      if (options.media_ids) {
        params = Object.assign(params, {
          fileIds: options.media_ids
        })
      }
      if (options.poll) {
        let pollParam = {
          choices: options.poll.options,
          expiresAt: null,
          expiredAfter: options.poll.expires_in * 1000
        }
        if (options.poll.multiple !== undefined) {
          pollParam = Object.assign(pollParam, {
            multiple: options.poll.multiple.toString() === 'true' ? true : false
          })
        }
        params = Object.assign(params, {
          poll: pollParam
        })
      }
      if (options.in_reply_to_id) {
        params = Object.assign(params, {
          replyId: options.in_reply_to_id
        })
      }
      if (options.spoiler_text) {
        params = Object.assign(params, {
          cw: options.spoiler_text
        })
      }
      if (options.visibility) {
        params = Object.assign(params, {
          visibility: MisskeyAPI.Converter.encodeVisibility(options.visibility)
        })
      }
      // Pleroma / Akkoma "local" visibility and glitch-soc local_only both keep the note on this server
      if (options.visibility === 'local' || options.local_only) {
        params = Object.assign(params, {
          localOnly: true
        })
      }
      // quoted_status_id is Mastodon 4.5, quote_id is Fedibird
      const quoteId = options.quoted_status_id ?? options.quote_id
      if (quoteId) {
        params = Object.assign(params, {
          renoteId: quoteId
        })
      }
    }
    return this.client
      .post<MisskeyAPI.Entity.CreatedNote>('/api/notes/create', params)
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data.createdNote, this.baseUrl) }))
  }

  /**
   * Mastodon's sensitive flag marks the media of a status, which Misskey keeps on each drive file.
   */
  private async markMediaSensitive(mediaIds: Array<string>): Promise<void> {
    await Promise.all(mediaIds.map(fileId => this.client.post<{}>('/api/drive/files/update', { fileId, isSensitive: true })))
  }

  /**
   * POST /api/notes/show
   */
  public async getStatus(id: string): Promise<Response<Entity.Status>> {
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  public async editStatus(
    _id: string,
    _options: {
      status?: string
      spoiler_text?: string
      sensitive?: boolean
      media_ids?: Array<string> | null
      poll?: { options?: Array<string>; expires_in?: number; multiple?: boolean; hide_totals?: boolean }
      visibility?: "public" | "unlisted" | "private" | "direct"
      in_reply_to_id?: string
    }
  ): Promise<Response<Entity.Status>> {
    // CherryPick edits notes through notes/update, which replaces text, CW, files and poll as a whole.
    // Visibility and reply target cannot be changed after posting, so those options are ignored.
    let params: Record<string, unknown> = {
      noteId: _id,
      text: _options.status,
      cw: null
    }
    if (_options) {
      if (_options.sensitive && _options.media_ids) {
        await this.markMediaSensitive(_options.media_ids)
      }
      if (_options.media_ids && _options.media_ids.length > 0) {
        params = Object.assign(params, {
          fileIds: _options.media_ids
        })
      }
      if (_options.poll && _options.poll.options) {
        let pollParam: Record<string, unknown> = {
          choices: _options.poll.options,
          expiresAt: null
        }
        if (_options.poll.expires_in !== undefined) {
          pollParam = Object.assign(pollParam, {
            expiredAfter: _options.poll.expires_in * 1000
          })
        }
        if (_options.poll.multiple !== undefined) {
          pollParam = Object.assign(pollParam, {
            multiple: _options.poll.multiple
          })
        }
        params = Object.assign(params, {
          poll: pollParam
        })
      }
      if (_options.spoiler_text) {
        params = Object.assign(params, {
          cw: _options.spoiler_text
        })
      }
    }
    return this.client
      .post<MisskeyAPI.Entity.UpdatedNote>('/api/notes/update', params)
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data.updatedNote, this.baseUrl) }))
  }

  /**
   * POST /api/notes/delete
   */
  public async deleteStatus(id: string): Promise<Response<Entity.StatusWithText>> {
    const status = await this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.noteWithText(res.data, this.baseUrl) }))

    await this.client.post<{}>('/api/notes/delete', {
      noteId: id
    })

    return status
  }

  /**
   * POST /api/notes/children
   */
  public async getStatusContext(
    id: string,
    options?: { limit?: number; max_id?: string; since_id?: string }
  ): Promise<Response<Entity.Context>> {
    let params = {
      noteId: id
    }
    if (options) {
      if (options.limit) {
        params = Object.assign(params, {
          limit: options.limit
        })
      }
      if (options.max_id) {
        params = Object.assign(params, {
          untilId: options.max_id
        })
      }
      if (options.since_id) {
        params = Object.assign(params, {
          sinceId: options.since_id
        })
      }
    }
    return this.client.post<Array<MisskeyAPI.Entity.Note>>('/api/notes/children', params).then(async res => {
      const conversation = await this.client.post<Array<MisskeyAPI.Entity.Note>>("/api/notes/conversation", params);
      const parents = await Promise.all(
        conversation.data.map((n) =>
        MisskeyAPI.Converter.note(
            n,
            this.baseUrl
          ),
        ),
      );
      const context: Entity.Context = {
        ancestors: parents.reverse(),
        descendants: this.dfs(await Promise.all(res.data.map(n => MisskeyAPI.Converter.note(n, this.baseUrl))), id)
      }
      return {
        ...res,
        data: context
      }
    })
  }

  private dfs(graph: Entity.Status[], rootId: string) {
		// sort the graph first, so that replies come out oldest first
		graph = graph.sort((a, b) => {
			if (a.id < b.id) return -1;
			if (a.id > b.id) return 1;
			return 0;
		});

		// populate stack with all direct replies to the root.
		// notes/children also returns quotes, which are not replies and must not decide the starting point.
		const stack = graph
			.filter((reply) => reply.in_reply_to_id === rootId)
			.reverse();
		const visited = new Set();
		const result = [];

		while (stack.length) {
			const currentPost = stack.pop();

			if (currentPost === undefined) return result;

			if (!visited.has(currentPost)) {
				visited.add(currentPost);
				result.push(currentPost);

				for (const reply of graph
					.filter((reply) => reply.in_reply_to_id === currentPost.id)
					.reverse()) {
					stack.push(reply);
				}
			}
		}

		return result;
	}

  /**
   * GET /api/notes/show
   */
  public async getStatusSource(_id: string): Promise<Response<Entity.StatusSource>> {
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: _id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.notesource(res.data) }))
  }

  /**
   * POST /api/notes/renotes
   */
  public async getStatusRebloggedBy(id: string): Promise<Response<Array<Entity.Account>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/renotes', {
        noteId: id
      })
      .then(res => ({
        ...res,
        data: res.data.map(n => MisskeyAPI.Converter.user(n.user, this.baseUrl))
      }))
  }

  public async getStatusFavouritedBy(_id: string): Promise<Response<Array<Entity.Account>>> {
    return this.client.post<Array<MisskeyAPI.Entity.Reaction>>("/api/notes/reactions", {
      noteId: _id,
    })
    .then(async (res) => ({
      ...res,
      data: (
        await Promise.all(res.data.map((n) => this.getAccount(n.user.id)))
      ).map((p) => p.data),
    }));
  }

  /**
   * POST /api/notes/favorites/create
   */
  public async favouriteStatus(id: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/notes/favorites/create', {
      noteId: id
    }).catch(ignoreApiErrors(['ALREADY_FAVORITED']))
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  /**
   * POST /api/notes/favorites/delete
   */
  public async unfavouriteStatus(id: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/notes/favorites/delete', {
      noteId: id
    }).catch(ignoreApiErrors(['NOT_FAVORITED']))
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  /**
   * POST /api/notes/create
   */
  public async reblogStatus(id: string): Promise<Response<Entity.Status>> {
    return this.client
      .post<MisskeyAPI.Entity.CreatedNote>('/api/notes/create', {
        renoteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data.createdNote, this.baseUrl) }))
  }

  /**
   * POST /api/notes/unrenote
   */
  public async unreblogStatus(id: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/notes/unrenote', {
      noteId: id
    })
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  /**
   * Bookmarks are Misskey favorites, the same ones getBookmarks lists.
   */
  public async bookmarkStatus(id: string): Promise<Response<Entity.Status>> {
    return this.favouriteStatus(id)
  }

  public async unbookmarkStatus(id: string): Promise<Response<Entity.Status>> {
    return this.unfavouriteStatus(id)
  }

  public async muteStatus(_id: string): Promise<Response<Entity.Status>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async unmuteStatus(_id: string): Promise<Response<Entity.Status>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/i/pin
   */
  public async pinStatus(id: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/i/pin', {
      noteId: id
    })
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  /**
   * POST /api/i/unpin
   */
  public async unpinStatus(id: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/i/unpin', {
      noteId: id
    })
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  // ======================================
  // statuses/media
  // ======================================
  /**
   * POST /api/drive/files/create
   */
  public async uploadMedia(file: File, _options?: { description?: string; focus?: string }): Promise<Response<Entity.Attachment>> {
    const formData = new FormData()
    formData.append('file', file);

		if (file.name && file.name !== "file") formData.append("name", file.name);

		if (_options?.description != null) formData.append("comment", _options.description);

    return this.client
      .post<MisskeyAPI.Entity.File>('/api/drive/files/create', formData)
      .then(res => ({ ...res, data: MisskeyAPI.Converter.file(res.data) }))
  }

  public async getMedia(id: string): Promise<Response<Entity.Attachment>> {
    const res = await this.client.post<MisskeyAPI.Entity.File>('/api/drive/files/show', { fileId: id })
    return { ...res, data: MisskeyAPI.Converter.file(res.data) }
  }

  /**
   * POST /api/drive/files/update
   */
  public async updateMedia(
    id: string,
    options?: {
      file?: any
      description?: string
      focus?: string
      is_sensitive?: boolean
    }
  ): Promise<Response<Entity.Attachment>> {
    let params = {
      fileId: id
    }
    if (options) {
      if (options.is_sensitive !== undefined) {
        params = Object.assign(params, {
          isSensitive: options.is_sensitive
        })
      }
      if (options.description !== undefined) {
				params = Object.assign(params, {
					comment: options.description,
				});
			}
    }
    return this.client
      .post<MisskeyAPI.Entity.File>('/api/drive/files/update', params)
      .then(res => ({ ...res, data: MisskeyAPI.Converter.file(res.data) }))
  }

  // ======================================
  // statuses/polls
  // ======================================
  public async getPoll(_id: string): Promise<Response<Entity.Poll>> {
    const res = await this.getStatus(_id);
		if (res.data.poll == null) throw new Error('poll not found');
		return { ...res, data: res.data.poll };
  }

  /**
   * POST /api/notes/polls/vote
   */
  public async votePoll(_id: string, choices: Array<number>): Promise<Response<Entity.Poll>> {
    if (!_id) {
			return new Promise((_, reject) => {
				const err = new ArgumentError('id is required');
				reject(err);
			});
		}

		for (const c of choices) {
			const params = {
				noteId: _id,
				choice: +c,
			};
			await this.client.post<{}>('/api/notes/polls/vote', params);
		}

    const res = await this.client
    .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
      noteId: _id,
    })
    .then(async (res) => {
      const note = await MisskeyAPI.Converter.note(
        res.data,
        this.baseUrl,
      );
      return { ...res, data: note.poll };
    });

    if (!res.data) {
      return new Promise((_, reject) => {
        const err = new UnexpectedError('poll does not exist');
        reject(err);
      });
    }

    return { ...res, data: res.data };
  }

  // ======================================
  // statuses/scheduled_statuses
  // ======================================
  public async getScheduledStatuses(_options?: {
    limit?: number
    max_id?: string
    since_id?: string
    min_id?: string
  }): Promise<Response<Array<Entity.ScheduledStatus>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async getScheduledStatus(_id: string): Promise<Response<Entity.ScheduledStatus>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async scheduleStatus(_id: string, _scheduled_at?: string | null): Promise<Response<Entity.ScheduledStatus>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async cancelScheduledStatus(_id: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // timelines
  // ======================================
  /**
   * POST /api/notes/global-timeline
   */
  public async getPublicTimeline(options?: {
    only_media?: boolean
    limit?: number
    max_id?: string
    since_id?: string
    min_id?: string
  }): Promise<Response<Array<Entity.Status>>> {
    let params = {}
    if (options) {
      if (options.only_media !== undefined) {
        params = Object.assign(params, {
          withFiles: options.only_media
        })
      }
      params = Object.assign(params, pageParams(options))
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/global-timeline', params)
      .then(res => ({ ...res, data: newerThan(res.data, options?.since_id, n => n.id).map(n => MisskeyAPI.Converter.note(n, this.baseUrl)) }))
  }

  /**
   * POST /api/notes/local-timeline
   */
  public async getLocalTimeline(options?: {
    only_media?: boolean
    limit?: number
    max_id?: string
    since_id?: string
    min_id?: string
  }): Promise<Response<Array<Entity.Status>>> {
    let params = {}
    if (options) {
      if (options.only_media !== undefined) {
        params = Object.assign(params, {
          withFiles: options.only_media
        })
      }
      params = Object.assign(params, pageParams(options))
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/local-timeline', params)
      .then(res => ({ ...res, data: newerThan(res.data, options?.since_id, n => n.id).map(n => MisskeyAPI.Converter.note(n, this.baseUrl)) }))
  }

  /**
   * POST /api/notes/search-by-tag
   */
  public async getTagTimeline(
    hashtag: string,
    options?: {
      local?: boolean
      only_media?: boolean
      limit?: number
      max_id?: string
      since_id?: string
      min_id?: string
    }
  ): Promise<Response<Array<Entity.Status>>> {
    let params = {
      tag: hashtag
    }
    if (options) {
      if (options.only_media !== undefined) {
        params = Object.assign(params, {
          withFiles: options.only_media
        })
      }
      params = Object.assign(params, pageParams(options))
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/search-by-tag', params)
      .then(res => ({ ...res, data: newerThan(res.data, options?.since_id, n => n.id).map(n => MisskeyAPI.Converter.note(n, this.baseUrl)) }))
  }

  /**
   * POST /api/notes/timeline
   */
  public async getHomeTimeline(options?: {
    local?: boolean
    limit?: number
    max_id?: string
    since_id?: string
    min_id?: string
  }): Promise<Response<Array<Entity.Status>>> {
    let params = {
      withFiles: false
    }
    if (options) {
      params = Object.assign(params, pageParams(options))
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/timeline', params)
      .then(res => ({ ...res, data: newerThan(res.data, options?.since_id, n => n.id).map(n => MisskeyAPI.Converter.note(n, this.baseUrl)) }))
  }

  /**
   * POST /api/notes/user-list-timeline
   */
  public async getListTimeline(
    list_id: string,
    options?: {
      limit?: number
      max_id?: string
      since_id?: string
      min_id?: string
    }
  ): Promise<Response<Array<Entity.Status>>> {
    let params = {
      listId: list_id,
      withFiles: false
    }
    if (options) {
      params = Object.assign(params, pageParams(options))
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/user-list-timeline', params)
      .then(res => ({ ...res, data: newerThan(res.data, options?.since_id, n => n.id).map(n => MisskeyAPI.Converter.note(n, this.baseUrl)) }))
  }

  // ======================================
  // timelines/conversations
  // ======================================
  /**
   * POST /api/notes/mentions
   */
  public async getConversationTimeline(options?: {
    limit?: number
    max_id?: string
    since_id?: string
    min_id?: string
  }): Promise<Response<Array<Entity.Conversation>>> {
    let params = {
      visibility: 'specified'
    }
    if (options) {
      params = Object.assign(params, pageParams(options))
    }
    return this.client
      .post<Array<MisskeyAPI.Entity.Note>>('/api/notes/mentions', params)
      .then(res => ({ ...res, data: newerThan(res.data, options?.since_id, n => n.id).map(n => MisskeyAPI.Converter.noteToConversation(n)) }))
  }

  public async deleteConversation(_id: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/notes/show
   *
   * Conversations are direct notes, which have no read state in Misskey, so this only returns the conversation.
   */
  public async readConversation(id: string): Promise<Response<Entity.Conversation>> {
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', { noteId: id })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.noteToConversation(res.data) }))
  }

  // ======================================
  // timelines/lists
  // ======================================
  /**
   * POST /api/users/lists/list
   */
  public async getLists(id?: string): Promise<Response<Array<Entity.List>>> {
    if (id) {
      return this.client
        .post<Array<MisskeyAPI.Entity.List>>('/api/users/lists/list', { userId: id })
        .then(res => ({ ...res, data: res.data.map(l => MisskeyAPI.Converter.list(l)) }))
    }

    return this.client
      .post<Array<MisskeyAPI.Entity.List>>('/api/users/lists/list', {})
      .then(res => ({ ...res, data: res.data.map(l => MisskeyAPI.Converter.list(l)) }))
  }

  /**
   * POST /api/users/lists/show
   */
  public async getList(id: string): Promise<Response<Entity.List>> {
    return this.client
      .post<MisskeyAPI.Entity.List>('/api/users/lists/show', {
        listId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.list(res.data) }))
  }

  /**
   * POST /api/users/lists/create
   */
  public async createList(title: string): Promise<Response<Entity.List>> {
    return this.client
      .post<MisskeyAPI.Entity.List>('/api/users/lists/create', {
        name: title
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.list(res.data) }))
  }

  /**
   * POST /api/users/lists/update
   */
  public async updateList(id: string, title: string): Promise<Response<Entity.List>> {
    return this.client
      .post<MisskeyAPI.Entity.List>('/api/users/lists/update', {
        listId: id,
        name: title
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.list(res.data) }))
  }

  /**
   * POST /api/users/lists/delete
   */
  public async deleteList(id: string): Promise<Response<{}>> {
    return this.client.post<{}>('/api/users/lists/delete', {
      listId: id
    })
  }

  /**
   * POST /api/users/lists/show
   */
  public async getAccountsInList(
    id: string,
    _options?: {
      limit?: number
      max_id?: string
      since_id?: string
    }
  ): Promise<Response<Array<Entity.Account>>> {
    const res = await this.client.post<MisskeyAPI.Entity.List>('/api/users/lists/show', {
      listId: id
    })
    const promise = res.data.userIds.map(userId => this.getAccount(userId))
    const accounts = await Promise.all(promise)
    return { ...res, data: accounts.map(r => r.data) }
  }

  /**
   * POST /api/users/lists/push, once per account
   */
  public async addAccountsToList(id: string, account_ids: Array<string>): Promise<Response<{}>> {
    for (const userId of account_ids) {
      await this.client.post<{}>('/api/users/lists/push', { listId: id, userId })
    }
    return { data: {}, status: 200, statusText: 'OK', headers: {} }
  }

  /**
   * POST /api/users/lists/pull, once per account
   */
  public async deleteAccountsFromList(id: string, account_ids: Array<string>): Promise<Response<{}>> {
    for (const userId of account_ids) {
      await this.client.post<{}>('/api/users/lists/pull', { listId: id, userId })
    }
    return { data: {}, status: 200, statusText: 'OK', headers: {} }
  }

  // ======================================
  // timelines/markers
  // ======================================
  public async getMarkers(_timeline: Array<string>): Promise<Response<Entity.Marker | Record<never, never>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async saveMarkers(_options?: {
    home?: { last_read_id: string }
    notifications?: { last_read_id: string }
  }): Promise<Response<Entity.Marker>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // notifications
  // ======================================
  /**
   * POST /api/i/notifications
   */
  public async getNotifications(options?: PageOptions & {
    types?: Array<Entity.NotificationType>
    exclude_types?: Array<Entity.NotificationType>
    account_id?: string
  }): Promise<Response<Array<Entity.Notification>>> {
    // Filter on the Misskey side, which fetches further until something matches, rather than leaving pages empty here.
    // Types without a megalodon counterpart are always left out for the same reason.
    const excluded = new Set(MisskeyAPI.Converter.encodeNotificationTypes(options?.exclude_types ?? []))
    const includeTypes = (options?.types ? MisskeyAPI.Converter.encodeNotificationTypes(options.types) : MisskeyAPI.Converter.decodableNotificationTypes)
      .filter(t => !excluded.has(t))
    if (includeTypes.length === 0) {
      return { data: [], status: 200, statusText: 'OK', headers: {} }
    }

    const params = {
      // Mastodon clients mark notifications as read through markers, not by listing them
      markAsRead: false,
      includeTypes,
      ...pageParams(options)
    }
    const res = await this.client.post<Array<MisskeyAPI.Entity.Notification>>('/api/i/notifications', params)
    const notifications: Array<Entity.Notification> = newerThan(res.data, options?.since_id, n => n.id).flatMap(n => {
      const notify = MisskeyAPI.Converter.notification(n)
      if (notify instanceof UnknownNotificationTypeError) {
        return []
      }
      return notify
    })

    return { ...res, data: notifications }
  }

  public async getNotification(_id: string): Promise<Response<Entity.Notification>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * POST /api/notifications/mark-all-as-read
   */
  public async dismissNotifications(): Promise<Response<{}>> {
    return this.client.post<{}>('/api/notifications/mark-all-as-read')
  }

  public async dismissNotification(_id: string): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async readNotifications(_options: {
    id?: string
    max_id?: string
  }): Promise<Response<Entity.Notification | Array<Entity.Notification>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('mastodon does not support')
      reject(err)
    })
  }

  // ======================================
  // notifications/push
  // ======================================
  public async subscribePushNotification(
    _subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    _data?: { alerts: { follow?: boolean; favourite?: boolean; reblog?: boolean; mention?: boolean; poll?: boolean } } | null
  ): Promise<Response<Entity.PushSubscription>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async getPushSubscription(): Promise<Response<Entity.PushSubscription>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async updatePushSubscription(
    _data?: { alerts: { follow?: boolean; favourite?: boolean; reblog?: boolean; mention?: boolean; poll?: boolean } } | null
  ): Promise<Response<Entity.PushSubscription>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  /**
   * DELETE /api/v1/push/subscription
   */
  public async deletePushSubscription(): Promise<Response<{}>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // search
  // ======================================
  public async search(
    q: string,
    options: {
      type: 'accounts' | 'hashtags' | 'statuses'
      limit?: number
      max_id?: string
      min_id?: string
      resolve?: boolean
      offset?: number
      following?: boolean
      account_id?: string
      exclude_unreviewed?: boolean
    }
  ): Promise<Response<Entity.Results>> {
    switch (options.type) {
      case 'accounts': {
        if (q.startsWith("http://") || q.startsWith("https://")) {
					// Fetching the URL may look up an account this server does not know yet, which only resolve allows
					if (!options.resolve) {
						return { data: emptyResults(), status: 200, statusText: 'OK', headers: {} }
					}
					return this.client
						.post("/api/ap/show", { uri: q })
						.then(async (res) => {
							if (res.status != 200 || res.data.type != "User") {
								res.status = 200;
								res.statusText = "OK";
								res.data = {
									accounts: [],
									statuses: [],
									hashtags: [],
								};

								return res;
							}

							const account = await MisskeyAPI.Converter.userDetail(
								res.data.object as MisskeyAPI.Entity.UserDetail,
								this.baseUrl,
							);

							return {
								...res,
								data: {
									accounts:
										options?.max_id && options?.max_id >= account.id
											? []
											: [account],
									statuses: [],
									hashtags: [],
								},
							};
						});
				}
        let params = {
          query: q,
          limit: options.limit ?? 20
        }
        if (options.offset) {
          params = Object.assign(params, {
            offset: options.offset
          })
        }
        const match = params.query.match(ACCT_PATTERN)
        const host = this.remoteHost(match?.groups?.host)
        if (match?.groups?.user && host) {
          const accounts = await this.findRemoteAccounts(match.groups.user, host, options.resolve, params.limit)
          return { data: { ...emptyResults(), accounts }, status: 200, statusText: 'OK', headers: {} }
        }
        try {
          if (match) {
            const lookupQuery = {
              username: match.groups?.user,
            };

            const result = await this.client.post<MisskeyAPI.Entity.UserDetail>('/api/users/show', lookupQuery).then((res) => ({
              ...res,
              data: {
                accounts: [
                  MisskeyAPI.Converter.userDetail(
                    res.data,
                    this.baseUrl,
                  ),
                ],
                statuses: [],
                hashtags: [],
              },
            }));

            if (result.status !== 200) {
							result.status = 200;
							result.statusText = "OK";
							result.data = {
								accounts: [],
								statuses: [],
								hashtags: [],
							};
						}

						return result;
          }
        } catch {}
        return this.client.post<Array<MisskeyAPI.Entity.UserDetail>>('/api/users/search', params).then(res => ({
          ...res,
          data: {
            accounts: res.data.map(u => MisskeyAPI.Converter.userDetail(u, this.baseUrl)),
            statuses: [],
            hashtags: []
          }
        }))
      }
      case 'statuses': {
        if (q.startsWith("http://") || q.startsWith("https://")) {
					// Fetching the URL may look up a status this server does not know yet, which only resolve allows
					if (!options.resolve) {
						return { data: emptyResults(), status: 200, statusText: 'OK', headers: {} }
					}
					return this.client
						.post("/api/ap/show", { uri: q })
						.then(async (res) => {
							if (res.status != 200 || res.data.type != "Note") {
								res.status = 200;
								res.statusText = "OK";
								res.data = {
									accounts: [],
									statuses: [],
									hashtags: [],
								};

								return res;
							}

							const post = await MisskeyAPI.Converter.note(
								res.data.object as MisskeyAPI.Entity.Note,
								this.baseUrl
							);

							return {
								...res,
								data: {
									accounts: [],
									statuses:
										options?.max_id && options.max_id >= post.id ? [] : [post],
									hashtags: [],
								},
							};
						});
				}
        let params = {
          query: q
        }
        if (options) {
          if (options.limit) {
            params = Object.assign(params, {
              limit: options.limit
            })
          }
          if (options.offset) {
            params = Object.assign(params, {
              offset: options.offset
            })
          }
          if (options.max_id) {
            params = Object.assign(params, {
              untilId: options.max_id
            })
          }
          if (options.min_id) {
            params = Object.assign(params, {
              sinceId: options.min_id
            })
          }
          if (options.account_id) {
            params = Object.assign(params, {
              userId: options.account_id
            })
          }
        }
        return this.client.post<Array<MisskeyAPI.Entity.Note>>('/api/notes/search', params).then(res => ({
          ...res,
          data: {
            accounts: [],
            statuses: res.data.map(n => MisskeyAPI.Converter.note(n, this.baseUrl)),
            hashtags: []
          }
        }))
      }
      case 'hashtags': {
        let params = {
          query: q
        }
        if (options) {
          if (options.limit) {
            params = Object.assign(params, {
              limit: options.limit
            })
          }
          if (options.offset) {
            params = Object.assign(params, {
              offset: options.offset
            })
          }
        }
        return this.client.post<Array<string>>('/api/hashtags/search', params).then(res => ({
          ...res,
          data: {
            accounts: [],
            statuses: [],
            hashtags: res.data.map(h => ({ name: h, url: h, history: [], following: false }))
          }
        }))
      }
			default: {
				return {
					status: 400,
					statusText: 'bad request',
					headers: {},
					data: {
						accounts: [],
						statuses: [],
						hashtags: [],
					}
				}
			}
    }
  }

  // ======================================
  // instance
  // ======================================
  /**
   * POST /api/meta
   * POST /api/stats
   */
  public async getInstance(): Promise<Response<Entity.Instance>> {
    const meta = await this.client
      .post<MisskeyAPI.Entity.Meta>('/api/meta', { detail: true })
      .then(res => res.data)
    return this.client
      .post<MisskeyAPI.Entity.Stats>('/api/stats')
      .then(res => ({ ...res, data: MisskeyAPI.Converter.meta(meta, res.data) }))
  }

  public async getInstancePeers(): Promise<Response<Array<string>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async getInstanceActivity(): Promise<Response<Array<Entity.Activity>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // instance/trends
  // ======================================
  /**
   * POST /api/hashtags/trend
   */
  public async getInstanceTrends(_limit?: number | null): Promise<Response<Array<Entity.Tag>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Hashtag>>('/api/hashtags/trend')
      .then(res => ({ ...res, data: res.data.map(h => MisskeyAPI.Converter.hashtag(h)) }))
  }

  // ======================================
  // instance/directory
  // ======================================
  public async getInstanceDirectory(_options?: {
    limit?: number
    offset?: number
    order?: 'active' | 'new'
    local?: boolean
  }): Promise<Response<Array<Entity.Account>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // instance/custom_emojis
  // ======================================
  /**
   * GET /api/emojis
   */
  public async getInstanceCustomEmojis(): Promise<Response<Array<Entity.Emoji>>> {
    return this.client
      .get<{ emojis: Array<MisskeyAPI.Entity.Emoji> }>('/api/emojis')
      .then(res => ({ ...res, data: res.data.emojis.map(e => MisskeyAPI.Converter.emoji(e)) }))
  }

  // ======================================
  // instance/announcements
  // ======================================
  /**
   * GET /api/announcements
   *
   * @return Array of announcements.
   */
  public async getInstanceAnnouncements(): Promise<Response<Array<Entity.Announcement>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Announcement>>('/api/announcements')
      .then(res => ({ ...res, data: res.data.map(a => MisskeyAPI.Converter.announcement(a)) }))
  }

  public async dismissInstanceAnnouncement(_id: string): Promise<Response<Record<never, never>>> {
    return this.client.post<{}>("/api/i/read-announcement", {
			announcementId: _id,
		});
  }

  public async addReactionToAnnouncement(_id: string, _name: string): Promise<Response<Record<never, never>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  public async removeReactionFromAnnouncement(_id: string, _name: string): Promise<Response<Record<never, never>>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }

  // ======================================
  // Emoji reactions
  // ======================================
  /**
   * POST /api/notes/reactions/create
   *
   * @param {string} id Target note ID.
   * @param {string} emoji Reaction emoji string. This string is raw unicode emoji.
   */
  public async createEmojiReaction(id: string, emoji: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/notes/reactions/create', {
      noteId: id,
      reaction: emoji
    }).catch(ignoreApiErrors(['ALREADY_REACTED']))
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data) }))
  }

  /**
   * POST /api/notes/reactions/delete
   */
  public async deleteEmojiReaction(id: string, _emoji: string): Promise<Response<Entity.Status>> {
    await this.client.post<{}>('/api/notes/reactions/delete', {
      noteId: id
    }).catch(ignoreApiErrors(['NOT_REACTED']))
    return this.client
      .post<MisskeyAPI.Entity.Note>('/api/notes/show', {
        noteId: id
      })
      .then(res => ({ ...res, data: MisskeyAPI.Converter.note(res.data, this.baseUrl) }))
  }

  public async getEmojiReactions(id: string): Promise<Response<Array<Entity.Reaction>>> {
    return this.client
      .post<Array<MisskeyAPI.Entity.Reaction>>('/api/notes/reactions', {
        noteId: id
      })
      .then(res => ({
        ...res,
        data: MisskeyAPI.Converter.reactions(res.data)
      }))
  }

	// TODO implement
  public async getEmojiReaction(_id: string, _emoji: string): Promise<Response<Entity.Reaction>> {
    return new Promise((_, reject) => {
      const err = new NoImplementedError('misskey does not support')
      reject(err)
    })
  }
}
