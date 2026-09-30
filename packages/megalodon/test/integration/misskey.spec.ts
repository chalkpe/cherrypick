import * as MisskeyEntity from '../../src/misskey/entity.js'
import * as MisskeyNotificationType from '../../src/misskey/notification.js'
import * as Misskey from '../../src/misskey.js'
import * as MegalodonNotificationType from '../../src/notification.js'
import * as Entity from '../../src/entity.js'
import axios, {
	AxiosHeaders,
	type AxiosResponse,
	type InternalAxiosRequestConfig,
	type CancelTokenSource
} from 'axios'
import { describe, expect, it, vi } from 'vitest';

vi.mock('axios')

const user: MisskeyEntity.User = {
  id: '1',
  name: 'test_user',
  username: 'TestUser',
  host: 'misskey.io',
  avatarUrl: 'https://example.com/icon.png',
  avatarColor: '#000000',
  emojis: []
}

const note: MisskeyEntity.Note = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: '1',
  user: user,
  text: 'hogehoge',
  cw: null,
  visibility: 'public',
  renoteCount: 0,
  repliesCount: 0,
  reactions: {},
  reactionEmojis: {},
  emojis: [],
  fileIds: [],
  files: [],
  replyId: null,
  renoteId: null
}

const follow: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Follow
}

const mention: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Mention,
  note: note
}

const reply: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Reply,
  note: note
}

const renote: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Renote,
  note: note
}

const quote: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Quote,
  note: note
}

const reaction: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Reaction,
  note: note,
  reaction: '♥'
}

const pollVote: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.PollVote,
  note: note
}

const receiveFollowRequest: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.ReceiveFollowRequest
}

const followRequestAccepted: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.FollowRequestAccepted
}

const pollEnded: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.PollEnded,
  note: note
}

const noteNotification: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.Note,
  note: note
}

const groupInvited: MisskeyEntity.Notification = {
  id: '1',
  createdAt: '2021-02-01T01:49:29',
  userId: user.id,
  user: user,
  type: MisskeyNotificationType.GroupInvited
}

vi.spyOn(axios.CancelToken, 'source').mockImplementation(() => {
  return {
    token: {
      throwIfRequested: () => {},
      promise: new Promise<never>(() => {}),
			reason: undefined,
			subscribe: () => {},
			unsubscribe: () => {},
			toAbortSignal: () => new AbortController().signal,
    },
		cancel: () => {},
  } satisfies CancelTokenSource;
});

describe('getNotifications', () => {
  const client = new Misskey.default('http://localhost', 'sample token')
  const cases: Array<{ event: MisskeyEntity.Notification; expected: Entity.NotificationType; title: string }> = [
    {
      event: follow,
      expected: MegalodonNotificationType.Follow,
      title: 'follow'
    },
    {
      event: mention,
      expected: MegalodonNotificationType.Mention,
      title: 'mention'
    },
    {
      event: reply,
      expected: MegalodonNotificationType.Mention,
      title: 'reply'
    },
    {
      event: renote,
      expected: MegalodonNotificationType.Reblog,
      title: 'renote'
    },
    {
      event: quote,
      expected: MegalodonNotificationType.Quote,
      title: 'quote'
    },
    {
      event: reaction,
      expected: MegalodonNotificationType.EmojiReaction,
      title: 'reaction'
    },
    {
      event: pollVote,
      expected: MegalodonNotificationType.PollVote,
      title: 'pollVote'
    },
    {
      event: receiveFollowRequest,
      expected: MegalodonNotificationType.FollowRequest,
      title: 'receiveFollowRequest'
    },
    {
      event: pollEnded,
      expected: MegalodonNotificationType.PollExpired,
      title: 'pollEnded'
    },
    {
      event: noteNotification,
      expected: MegalodonNotificationType.Status,
      title: 'note'
    }
  ]
  cases.forEach(c => {
    it(`should be ${c.title} event`, async () => {
      const config: InternalAxiosRequestConfig<any> = {
        headers: new AxiosHeaders()
      }
      const mockResponse: AxiosResponse<Array<MisskeyEntity.Notification>> = {
        data: [c.event],
        status: 200,
        statusText: '200OK',
        headers: {},
        config: config
      }
			vi.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse);
      const res = await client.getNotifications()
      expect(res.data[0].type).toEqual(c.expected)
    })
  })
  it('followRequestAccepted event should be ignored, as Mastodon has no such notification', async () => {
    const config: InternalAxiosRequestConfig<any> = {
      headers: new AxiosHeaders()
    }
    const mockResponse: AxiosResponse<Array<MisskeyEntity.Notification>> = {
      data: [followRequestAccepted],
      status: 200,
      statusText: '200OK',
      headers: {},
      config: config
    }
		vi.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse);
    const res = await client.getNotifications()
    expect(res.data).toEqual([])
  })
  it('groupInvited event should be ignored', async () => {
    const config: InternalAxiosRequestConfig<any> = {
      headers: new AxiosHeaders()
    }
    const mockResponse: AxiosResponse<Array<MisskeyEntity.Notification>> = {
      data: [groupInvited],
      status: 200,
      statusText: '200OK',
      headers: {},
      config: config
    }
		vi.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse);
    const res = await client.getNotifications()
    expect(res.data).toEqual([])
  })
})

function respond<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: '200OK',
    headers: {},
    config: { headers: new AxiosHeaders() }
  }
}

const noteWithId = (id: string): MisskeyEntity.Note => ({ ...note, id })

// An error of the Misskey API as axios rejects with it
const apiError = (code: string): Error => Object.assign(new Error(code), { response: { data: { error: { code } } } })

describe('getNotifications filters', () => {
  const client = new Misskey.default('http://localhost', 'sample token')

  it('should ask Misskey only for the types behind the requested ones', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.getNotifications({ types: [MegalodonNotificationType.Reblog, MegalodonNotificationType.Mention], exclude_types: [MegalodonNotificationType.Mention] })
    expect((post.mock.lastCall?.[1] as { includeTypes: Array<string> }).includeTypes.sort()).toEqual([MisskeyNotificationType.Renote])
  })

  it('should leave out Misskey types that have no counterpart', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.getNotifications()
    const { includeTypes } = post.mock.lastCall?.[1] as { includeTypes: Array<string> }
    expect(includeTypes).not.toContain(MisskeyNotificationType.GroupInvited)
    expect(includeTypes).toContain(MisskeyNotificationType.Note)
  })

  it('should not call Misskey when every type is excluded', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    const res = await client.getNotifications({ types: [MegalodonNotificationType.Update] })
    expect(post).not.toHaveBeenCalled()
    expect(res.data).toEqual([])
  })
})

describe('pagination', () => {
  const client = new Misskey.default('http://localhost', 'sample token')

  it('should send min_id as sinceId', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.getHomeTimeline({ min_id: '5', max_id: '9' })
    expect(post.mock.lastCall?.[1]).toMatchObject({ sinceId: '5', untilId: '9' })
  })

  it('should cut the newest page at since_id instead of sending it', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([noteWithId('3'), noteWithId('2'), noteWithId('1')]))
    const res = await client.getHomeTimeline({ since_id: '1' })
    expect(post.mock.lastCall?.[1]).not.toHaveProperty('sinceId')
    expect(res.data.map(s => s.id)).toEqual(['3', '2'])
  })

  it('should paginate follow requests by the request records, newest first', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(
      respond([
        { id: 'r1', follower: { ...user, id: 'u9' }, followee: user },
        { id: 'r2', follower: { ...user, id: 'u8' }, followee: user }
      ])
    )
    const res = await client.getFollowRequests({ min_id: 'r0', limit: 2 })
    expect(post.mock.lastCall?.[1]).toMatchObject({ sinceId: 'r0', limit: 2 })
    expect(res.pageIds).toEqual(['r2', 'r1'])
    expect(res.data.map(a => a.id)).toEqual(['u8', 'u9'])
  })
})

describe('search', () => {
  const client = new Misskey.default('http://localhost', 'sample token')

  it('should not fetch a URL without resolve', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    const res = await client.search('https://remote.example/@alice', { type: 'accounts' })
    expect(post).not.toHaveBeenCalled()
    expect(res.data.accounts).toEqual([])
  })

  it('should look up only known accounts for user@host without resolve', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.search('alice@remote.example', { type: 'accounts' })
    expect(post.mock.lastCall?.[0]).toEqual('http://localhost/api/users/search-by-username-and-host')
    expect(post.mock.lastCall?.[1]).toMatchObject({ username: 'alice', host: 'remote.example' })
  })

  it('should resolve user@host with resolve', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValueOnce(new Error('not found'))
    const res = await client.search('alice@remote.example', { type: 'accounts', resolve: true })
    expect(post.mock.lastCall?.[0]).toEqual('http://localhost/api/users/show')
    expect(res.data.accounts).toEqual([])
  })

  it('should look up user@host by username and host in the account search too', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.searchAccount('@alice@remote.example', { resolve: false })
    expect(post.mock.lastCall?.[0]).toEqual('http://localhost/api/users/search-by-username-and-host')
  })
})

describe('client options', () => {
  it('should pass proxy: false to axios', async () => {
    const client = new Misskey.default('http://localhost', 'sample token', null, { proxy: false })
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.getHomeTimeline()
    expect(post.mock.lastCall?.[2]).toMatchObject({ proxy: false })
  })
})

describe('accounts', () => {
  const client = new Misskey.default('http://localhost', 'sample token')
  const relation = (overrides: Partial<MisskeyEntity.Relation> = {}): MisskeyEntity.Relation => ({
    id: '2',
    isFollowing: true,
    hasPendingFollowRequestFromYou: false,
    hasPendingFollowRequestToYou: false,
    isFollowed: false,
    isBlocking: false,
    isBlocked: false,
    isMuted: false,
    isRenoteMuted: false,
    following: { notify: 'none' },
    ...overrides
  })

  it('should change the options of an existing follow instead of following again', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    post
      .mockResolvedValueOnce(respond([relation()]))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond([relation({ isRenoteMuted: true, following: { notify: 'normal' } })]))
    const res = await client.followAccount('2', { reblogs: false, notify: true })
    const paths = post.mock.calls.map(c => c[0])
    expect(paths).not.toContain('http://localhost/api/following/create')
    expect(paths).toContain('http://localhost/api/renote-mute/create')
    expect(paths).toContain('http://localhost/api/following/update')
    expect(res.data.notifying).toBe(true)
    expect(res.data.showing_reblogs).toBe(false)
  })

  it('should include replies and boosts of an account unless they are excluded', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.getAccountStatuses('2', { exclude_replies: true })
    expect(post.mock.lastCall?.[1]).toMatchObject({ withReplies: false, withRenotes: true })
  })

  it('should not ask for replies along with the media of an account', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([]))
    await client.getAccountStatuses('2', { only_media: true })
    expect(post.mock.lastCall?.[1]).toMatchObject({ withFiles: true, withReplies: false })
  })

  it('should mute for the given duration, replacing an existing mute', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    post
      .mockRejectedValueOnce(apiError('ALREADY_MUTING'))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond([relation({ isMuted: true })]))
    const before = Date.now()
    const res = await client.muteAccount('2', true, { duration: 3600 })
    const calls = post.mock.calls.map(c => [c[0], c[1]] as [string, { expiresAt?: number | null }])
    expect(calls.map(c => c[0]).slice(0, 3)).toEqual(['http://localhost/api/mute/create', 'http://localhost/api/mute/delete', 'http://localhost/api/mute/create'])
    const expiresAt = calls[2][1].expiresAt ?? 0
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
    expect(res.data.muting).toBe(true)
  })

  it('should mute indefinitely without a duration', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    post.mockResolvedValueOnce(respond({})).mockResolvedValueOnce(respond([relation({ isMuted: true })]))
    await client.muteAccount('2', true)
    expect(post.mock.calls[0][1]).toMatchObject({ userId: '2', expiresAt: null })
  })

  it('should tell when each mute ends', async () => {
    vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([
      { id: 'm2', createdAt: '', expiresAt: '2030-01-01T00:00:00.000Z', muteeId: 'u2', mutee: { ...user, id: 'u2' } },
      { id: 'm1', createdAt: '', expiresAt: null, muteeId: 'u1', mutee: { ...user, id: 'u1' } }
    ]))
    const res = await client.getMutes()
    expect(res.data.map(a => [a.id, a.mute_expires_at])).toEqual([['u2', '2030-01-01T00:00:00.000Z'], ['u1', null]])
  })

  it('should withdraw a pending follow request when unfollowing', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    post
      .mockResolvedValueOnce(respond([relation({ isFollowing: false, hasPendingFollowRequestFromYou: true })]))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond([relation({ isFollowing: false })]))
    const res = await client.unfollowAccount('2')
    const paths = post.mock.calls.map(c => c[0])
    expect(paths).toContain('http://localhost/api/following/requests/cancel')
    expect(paths).not.toContain('http://localhost/api/following/delete')
    expect(res.data.requested).toBe(false)
  })

  it('should succeed when blocking an account that is already blocked', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    post.mockRejectedValueOnce(apiError('ALREADY_BLOCKING')).mockResolvedValueOnce(respond([relation({ isBlocking: true })]))
    const res = await client.blockAccount('2')
    expect(res.data.blocking).toBe(true)
  })

  it('should list the lists that contain an account', async () => {
    vi.spyOn(axios, 'post').mockResolvedValueOnce(respond([
      { id: 'l1', createdAt: '', name: 'with', userIds: ['2'] },
      { id: 'l2', createdAt: '', name: 'without', userIds: ['3'] }
    ]))
    const res = await client.getAccountLists('2')
    expect(res.data.map(l => l.id)).toEqual(['l1'])
  })

  it('should answer a hashtag that has not been used yet', async () => {
    vi.spyOn(axios, 'post').mockRejectedValueOnce(new Error('NO_SUCH_HASHTAG'))
    const res = await client.getTag('#new')
    expect(res.data).toMatchObject({ name: 'new', following: false })
  })
})

describe('postStatus', () => {
  const client = new Misskey.default('http://localhost', 'sample token')
  const created = respond({ createdNote: note })

  it('should keep local posts on this server', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(created)
    await client.postStatus('hi', { visibility: 'local' })
    expect(post.mock.lastCall?.[1]).toMatchObject({ visibility: 'public', localOnly: true })
  })

  it('should mark the media sensitive instead of adding a content warning', async () => {
    const post = vi.spyOn(axios, 'post')
    post.mockClear()
    post.mockResolvedValueOnce(respond({})).mockResolvedValueOnce(created)
    await client.postStatus('hi', { media_ids: ['f1'], sensitive: true })
    expect(post.mock.calls[0][0]).toEqual('http://localhost/api/drive/files/update')
    expect(post.mock.calls[0][1]).toEqual({ fileId: 'f1', isSensitive: true })
    expect(post.mock.lastCall?.[1]).not.toHaveProperty('cw')
  })

  it('should quote with quoted_status_id', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce(created)
    await client.postStatus('hi', { quoted_status_id: 'q1' })
    expect(post.mock.lastCall?.[1]).toMatchObject({ renoteId: 'q1' })
  })
})
