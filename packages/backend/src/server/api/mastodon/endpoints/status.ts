/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Converter } from 'megalodon';
import { parseTimelineArgs, TimelineArgs, toBoolean, toInt, unflattenFormBody } from '@/server/api/mastodon/argsUtils.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { MastodonDataService } from '@/server/api/mastodon/MastodonDataService.js';
import { MastodonPreferenceService } from '@/server/api/mastodon/MastodonPreferenceService.js';
import { attachMinMaxPagination } from '@/server/api/mastodon/pagination.js';
import { promiseMap } from '@/misc/promise-map.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import { convertAttachment, convertPoll, escapeMFM, isUnicodeEmojiReaction, MastodonConverters, toMisskeyReaction } from '../MastodonConverters.js';
import type { Entity, MastodonEntity, Misskey, MisskeyEntity } from 'megalodon';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type Visibility = 'public' | 'unlisted' | 'private' | 'direct' | 'local';

interface PostStatusBody {
	media_ids?: string[],
	poll?: {
		options?: string[],
		expires_in?: string,
		multiple?: string,
		hide_totals?: string,
	},
	in_reply_to_id?: string,
	sensitive?: string,
	spoiler_text?: string,
	visibility?: Visibility,
	local_only?: string,
	scheduled_at?: string,
	language?: string,
	quote_id?: string,
	quoted_status_id?: string,
	status?: string,
}

/**
 * Whether a note quotes the renoted note, rather than being a pure renote. Mirrors isQuote in MastodonConverters.
 */
function isQuoteNote(note: MisskeyEntity.Note): boolean {
	return note.renoteId != null && (note.text != null || note.cw != null || note.fileIds.length > 0 || note.poll != null || note.replyId != null);
}

/** Validate before sensitive media updates fan out into one internal request per file. */
function isValidMediaIds(value: unknown): boolean {
	return value == null || (Array.isArray(value) && value.length <= 16
		&& value.every(id => typeof id === 'string' && id.length > 0)
		&& new Set(value).size === value.length);
}

@Injectable()
export class ApiStatusMastodon {
	constructor(
		private readonly mastoConverters: MastodonConverters,
		private readonly clientService: MastodonClientService,
		private readonly mastodonDataService: MastodonDataService,
		private readonly preferenceService: MastodonPreferenceService,
	) {}

	/**
	 * A scheduled Misskey note draft as a Mastodon ScheduledStatus.
	 */
	private convertScheduledStatus(draft: Packed<'NoteDraft'>): MastodonEntity.ScheduledStatus {
		const scheduledAt = draft.scheduledAt ?? Date.now();
		const poll = draft.poll;
		// A poll of a draft lasts either for a while or until a fixed time
		const pollSeconds = poll?.expiredAfter != null
			? poll.expiredAfter / 1000
			: poll?.expiresAt != null ? (new Date(poll.expiresAt).getTime() - scheduledAt) / 1000 : 0;
		return {
			id: draft.id,
			scheduled_at: new Date(scheduledAt).toISOString(),
			params: {
				text: draft.text ?? '',
				in_reply_to_id: draft.replyId ?? null,
				media_ids: draft.fileIds.length > 0 ? draft.fileIds : null,
				sensitive: (draft.files ?? []).some(f => f.isSensitive),
				spoiler_text: draft.cw ?? null,
				visibility: Converter.visibility(draft.visibility),
				scheduled_at: null,
				application_id: 0,
				poll: poll ? {
					options: poll.choices,
					expires_in: String(Math.max(0, Math.round(pollSeconds))),
					multiple: poll.multiple,
					hide_totals: false,
				} : null,
				language: null,
			},
			media_attachments: (draft.files ?? []).map(f => this.mastoConverters.encodeFile(f)),
		};
	}

	/**
	 * Posts a status later, as a scheduled Misskey note draft.
	 */
	private async scheduleStatus(client: Misskey, body: PostStatusBody, scheduledAt: Date): Promise<MastodonEntity.ScheduledStatus> {
		const mediaIds = body.media_ids?.length ? body.media_ids : undefined;
		if (mediaIds && toBoolean(body.sensitive)) {
			await Promise.all(mediaIds.map(fileId => client.callApi('/api/drive/files/update', { fileId, isSensitive: true })));
		}

		const { data } = await client.callApi<{ createdDraft: Packed<'NoteDraft'> }>('/api/notes/drafts/create', {
			text: body.status?.trim() ? body.status : null,
			cw: body.spoiler_text || null,
			visibility: body.visibility ? Converter.encodeVisibility(body.visibility) : 'public',
			localOnly: body.visibility === 'local' || toBoolean(body.local_only) === true,
			replyId: body.in_reply_to_id ?? null,
			renoteId: body.quoted_status_id ?? body.quote_id ?? null,
			fileIds: mediaIds ?? [],
			poll: body.poll?.options ? {
				choices: body.poll.options,
				multiple: toBoolean(body.poll.multiple) ?? false,
				expiredAfter: (toInt(body.poll.expires_in) ?? 86400) * 1000,
			} : null,
			scheduledAt: scheduledAt.getTime(),
			isActuallyScheduled: true,
		});
		return this.convertScheduledStatus(data.createdDraft);
	}

	private async listScheduledDrafts(request: FastifyRequest, params: Record<string, unknown>): Promise<Packed<'NoteDraft'>[]> {
		return await this.clientService.callApi<Packed<'NoteDraft'>[]>(request, 'notes/drafts/list', { ...params, scheduled: true });
	}

	public register(fastify: FastifyInstance): void {
		this.registerScheduled(fastify);

		fastify.get<{ Params: { id?: string } }>('/v1/statuses/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const note = await this.mastodonDataService.requireNote(_request.params.id, me, { user: true });

			const data = await client.getStatus(note.id);
			const response = await this.mastoConverters.convertStatus(data.data, me, { note, user: note.user });

			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/statuses/:id/source', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getStatusSource(_request.params.id);

			return reply.send(data.data);
		});

		fastify.get<{ Params: { id?: string }, Querystring: TimelineArgs }>('/v1/statuses/:id/context', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const { data } = await client.getStatusContext(_request.params.id, parseTimelineArgs(_request.query));
			const ancestors = await this.mastoConverters.convertStatuses(data.ancestors, me);
			const descendants = await this.mastoConverters.convertStatuses(data.descendants, me);
			const response = { ancestors, descendants };

			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/statuses/:id/history', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const user = await this.clientService.getAuth(_request);
			const edits = await this.mastoConverters.getEdits(_request.params.id, user);

			return reply.send(edits);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/statuses/:id/reblogged_by', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getStatusRebloggedBy(_request.params.id);
			const response = await promiseMap(data.data, async (account: Entity.Account) => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/statuses/:id/favourited_by', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getStatusFavouritedBy(_request.params.id);
			const response = await promiseMap(data.data, async (account: Entity.Account) => await this.mastoConverters.convertAccount(account), { limiter: 4 });

			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/media/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getMedia(_request.params.id);
			const response = convertAttachment(data.data);

			return reply.send(response);
		});

		fastify.get<{ Params: { id?: string } }>('/v1/polls/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.getPoll(_request.params.id);
			const response = convertPoll(data.data);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string }, Body: { choices?: number[] } }>('/v1/polls/:id/votes', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			if (!_request.body.choices) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "choices"' });

			const client = this.clientService.getClient(_request);
			const data = await client.votePoll(_request.params.id, _request.body.choices);
			const response = convertPoll(data.data);

			return reply.send(response);
		});

		fastify.post<{
			Body?: PostStatusBody,
		}>('/v1/statuses', async (_request, reply) => {
			// Form clients send "media_ids[]" and "poll[options][]" instead of nested values
			const body = unflattenFormBody((_request.body ?? {}) as Record<string, unknown>) as PostStatusBody;
			if (!isValidMediaIds(body.media_ids)) return reply.code(400).send({ error: 'media_ids must be an array of at most 16 unique file IDs' });
			const text = body.status ??= ' ';
			const removed = text.replace(/@\S+/g, '').replace(/\s|/g, '');
			const isDefaultEmoji = isUnicodeEmojiReaction(removed);
			const isCustomEmoji = /^:[a-zA-Z0-9@_]+:$/.test(removed);

			const { client, me } = await this.clientService.getAuthClient(_request);
			if ((body.in_reply_to_id && isDefaultEmoji) || (body.in_reply_to_id && isCustomEmoji)) {
				const a = await client.createEmojiReaction(
					body.in_reply_to_id,
					removed,
				);
				return reply.send(a.data);
			}
			if (body.in_reply_to_id && removed === '/unreact') {
				const id = body.in_reply_to_id;
				const post = await client.getStatus(id);
				const react = post.data.emoji_reactions.filter((e: Entity.Reaction) => e.me)[0].name;
				const data = await client.deleteEmojiReaction(id, react);
				return reply.send(data.data);
			}
			body.media_ids ??= undefined;
			if (body.media_ids && !body.media_ids.length) body.media_ids = undefined;
			// Mastodon posts with the default visibility of the user when none is given
			if (!body.visibility && me) body.visibility = await this.preferenceService.getDefaultVisibility(me.id);

			if (body.scheduled_at) {
				const scheduledAt = new Date(body.scheduled_at);
				if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
					return reply.code(422).send({ error: 'Validation failed: Scheduled at must be in the future' });
				}
				return reply.send(await this.scheduleStatus(client, body, scheduledAt));
			}

			if (body.poll && !body.poll.options) {
				return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "poll.options"' });
			}
			if (body.poll && !body.poll.expires_in) {
				return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required payload "poll.expires_in"' });
			}

			const options = {
				...body,
				sensitive: toBoolean(body.sensitive),
				local_only: toBoolean(body.local_only),
				poll: body.poll ? {
					options: body.poll.options!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
					expires_in: toInt(body.poll.expires_in)!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
					multiple: toBoolean(body.poll.multiple),
					hide_totals: toBoolean(body.poll.hide_totals),
				} : undefined,
			};

			const data = await client.postStatus(text, options);
			const response = await this.mastoConverters.convertStatus(data.data as Entity.Status, me);

			return reply.send(response);
		});

		fastify.put<{
			Params: { id: string },
			Body: {
				status?: string,
				spoiler_text?: string,
				sensitive?: string,
				media_ids?: string[],
				poll?: {
					options?: string[],
					expires_in?: string,
					multiple?: string,
					hide_totals?: string,
				},
			}
		}>('/v1/statuses/:id', async (_request, reply) => {
			if (!isValidMediaIds(_request.body.media_ids)) return reply.code(400).send({ error: 'media_ids must be an array of at most 16 unique file IDs' });
			const { client, me } = await this.clientService.getAuthClient(_request);
			const body = _request.body;

			if (!body.media_ids || !body.media_ids.length) {
				body.media_ids = undefined;
			}

			const options = {
				...body,
				sensitive: toBoolean(body.sensitive),
				poll: body.poll ? {
					options: body.poll.options,
					expires_in: toInt(body.poll.expires_in),
					multiple: toBoolean(body.poll.multiple),
					hide_totals: toBoolean(body.poll.hide_totals),
				} : undefined,
			};

			const data = await client.editStatus(_request.params.id, options);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/favourite', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.createEmojiReaction(_request.params.id, '❤');
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/unfavourite', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.deleteEmojiReaction(_request.params.id, '❤');
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/reblog', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			// Misskey can renote a note many times, while boosting again on Mastodon returns the boost there is
			const existing = me ? await this.mastodonDataService.findReblogId(_request.params.id, me) : null;
			const data = existing ? await client.getStatus(existing) : await client.reblogStatus(_request.params.id);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/unreblog', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.unreblogStatus(_request.params.id);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/bookmark', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.bookmarkStatus(_request.params.id);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/unbookmark', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.unbookmarkStatus(_request.params.id);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});
		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/pin', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.pinStatus(_request.params.id);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string } }>('/v1/statuses/:id/unpin', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.unpinStatus(_request.params.id);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string, name?: string } }>('/v1/statuses/:id/react/:name', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			if (!_request.params.name) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "name"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.createEmojiReaction(_request.params.id, toMisskeyReaction(_request.params.name));
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.post<{ Params: { id?: string, name?: string } }>('/v1/statuses/:id/unreact/:name', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			if (!_request.params.name) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "name"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.deleteEmojiReaction(_request.params.id, _request.params.name);
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		// Pleroma / Akkoma emoji reaction API, used by clients such as Moshidon to list who reacted
		for (const path of ['/v1/pleroma/statuses/:id/reactions', '/v1/pleroma/statuses/:id/reactions/:name']) {
			fastify.get<{ Params: { id?: string, name?: string } }>(path, async (_request, reply) => {
				if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

				const me = await this.clientService.getAuth(_request);
				const records = await this.clientService.callApi<MisskeyEntity.Reaction[]>(_request, 'notes/reactions', {
					noteId: _request.params.id,
					type: _request.params.name ? toMisskeyReaction(_request.params.name) : null,
					limit: 100,
				});
				const response = await this.mastoConverters.convertReactionUsers(records, me);

				return reply.send(response);
			});
		}

		fastify.put<{ Params: { id?: string, name?: string } }>('/v1/pleroma/statuses/:id/reactions/:name', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });
			if (!_request.params.name) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "name"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.createEmojiReaction(_request.params.id, toMisskeyReaction(_request.params.name));
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		fastify.delete<{ Params: { id?: string, name?: string } }>('/v1/pleroma/statuses/:id/reactions/:name', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.deleteEmojiReaction(_request.params.id, _request.params.name ?? '');
			const response = await this.mastoConverters.convertStatus(data.data, me);

			return reply.send(response);
		});

		// Muting a conversation is a Misskey thread muting
		for (const [path, endpoint] of [['/v1/statuses/:id/mute', 'notes/thread-muting/create'], ['/v1/statuses/:id/unmute', 'notes/thread-muting/delete']] as const) {
			fastify.post<{ Params: { id?: string } }>(path, async (request, reply) => {
				if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

				const { client, me } = await this.clientService.getAuthClient(request);
				const note = await this.mastodonDataService.requireNote(request.params.id, me);
				const { muted } = await this.mastodonDataService.getNoteState(note, me);
				// Both endpoints fail when the thread already is in the requested state
				if (muted !== (endpoint === 'notes/thread-muting/create')) {
					await client.callApi(`/api/${endpoint}`, { noteId: note.id });
				}
				const data = await client.getStatus(note.id);

				return reply.send(await this.mastoConverters.convertStatus(data.data, me));
			});
		}

		fastify.post<{ Params: { id?: string }, Body?: { lang?: string } }>('/v1/statuses/:id/translate', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			// Mastodon translates into the language of the user, which the client passes or the browser tells
			const lang = request.body?.lang ?? request.headers['accept-language']?.split(/[,;]/)[0]?.trim() ?? 'en';
			const client = this.clientService.getClient(request);
			const { data } = await client.callApi<{ sourceLang: string, text: string, translator?: string } | ''>('/api/notes/translate', { noteId: request.params.id, targetLang: lang })
				.catch(err => {
					// Mastodon answers 503 when there is no translation service to use
					const code = (err as { response?: { data?: { error?: { code?: string } } } }).response?.data?.error?.code;
					if (code === 'NO_TRANSLATE_SERVICE' || code === 'UNAVAILABLE') return { data: null };
					throw err;
				});
			if (data === null) return reply.code(503).send({ error: 'Translation is not available on this server' });
			if (!data) return reply.code(422).send({ error: 'This status has no text to translate' });

			// Misskey translates the content warning and the text together, separated by a line of dashes
			const [spoilerText, content] = data.text.includes('\n-----\n') ? data.text.split('\n-----\n', 2) : ['', data.text];
			return reply.send({
				content: `<p>${escapeMFM(content)}</p>`,
				spoiler_text: spoilerText,
				poll: null,
				media_attachments: [],
				detected_source_language: data.sourceLang,
				provider: data.translator ?? '',
			});
		});

		// Quotes of a status (Mastodon 4.5), from its Misskey renotes
		fastify.get<{ Params: { id?: string }, Querystring: TimelineArgs }>('/v1/statuses/:id/quotes', async (request, reply) => {
			if (!request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const me = await this.clientService.getAuth(request);
			const args = parseTimelineArgs(request.query);
			const renotes = await this.clientService.callApi<MisskeyEntity.Note[]>(request, 'notes/renotes', {
				noteId: request.params.id,
				limit: args.limit ?? 20,
				untilId: args.max_id,
				sinceId: args.min_id ?? args.since_id,
			});
			const baseUrl = this.clientService.getPublicBaseUrl();
			const response = await this.mastoConverters.convertStatuses(renotes.filter(isQuoteNote).map(note => Converter.note(note, baseUrl)), me);

			// Paginate by the renotes, as pure renotes among them are left out
			attachMinMaxPagination(request, reply, renotes, baseUrl);
			return reply.send(response);
		});

		// Misskey lets anyone quote public notes, and neither revoking quotes nor changing the policy is possible
		fastify.post('/v1/statuses/:id/quotes/:quoteId/revoke', async (_request, reply) => {
			return reply.code(422).send({ error: 'Revoking quotes is not supported by this server' });
		});
		fastify.put('/v1/statuses/:id/interaction_policy', async (_request, reply) => {
			return reply.code(422).send({ error: 'Changing who can quote is not supported by this server' });
		});

		fastify.delete<{ Params: { id?: string } }>('/v1/statuses/:id', async (_request, reply) => {
			if (!_request.params.id) return reply.code(400).send({ error: 'BAD_REQUEST', error_description: 'Missing required parameter "id"' });

			const client = this.clientService.getClient(_request);
			const data = await client.deleteStatus(_request.params.id);

			return reply.send(data.data);
		});
	}

	/**
	 * Scheduled statuses, which are scheduled Misskey note drafts.
	 */
	private registerScheduled(fastify: FastifyInstance): void {
		fastify.get<{ Querystring: TimelineArgs }>('/v1/scheduled_statuses', async (request, reply) => {
			const args = parseTimelineArgs(request.query);
			const drafts = await this.listScheduledDrafts(request, {
				limit: Math.min(args.limit ?? 20, 40),
				untilId: args.max_id,
				sinceId: args.min_id ?? args.since_id,
			});
			const response = drafts.map(d => this.convertScheduledStatus(d));

			attachMinMaxPagination(request, reply, response, this.clientService.getPublicBaseUrl());
			return reply.send(response);
		});

		fastify.get<{ Params: { id: string } }>('/v1/scheduled_statuses/:id', async (request, reply) => {
			const draft = (await this.listScheduledDrafts(request, { limit: 100 })).find(d => d.id === request.params.id);
			if (!draft) return reply.code(404).send({ error: 'Record not found' });

			return reply.send(this.convertScheduledStatus(draft));
		});

		fastify.put<{ Params: { id: string }, Body?: { scheduled_at?: string } }>('/v1/scheduled_statuses/:id', async (request, reply) => {
			const scheduledAt = new Date(request.body?.scheduled_at ?? '');
			if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
				return reply.code(422).send({ error: 'Validation failed: Scheduled at must be in the future' });
			}

			const { updatedDraft } = await this.clientService.callApi<{ updatedDraft: Packed<'NoteDraft'> }>(request, 'notes/drafts/update', {
				draftId: request.params.id,
				scheduledAt: scheduledAt.getTime(),
				isActuallyScheduled: true,
			});

			return reply.send(this.convertScheduledStatus(updatedDraft));
		});

		fastify.delete<{ Params: { id: string } }>('/v1/scheduled_statuses/:id', async (request, reply) => {
			await this.clientService.requireAuth(request);
			await this.clientService.callApi(request, 'notes/drafts/delete', { draftId: request.params.id });
			return reply.send({});
		});
	}
}
