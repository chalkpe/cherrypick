/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { escapeHtml } from '@/misc/escape-html.js';
import { parseChatDiceResult } from '@/core/chat-dice.js';
import type { ChatDiceResult } from '@/core/chat-dice.js';
import type { IAnnounce, IApDocument, IDelete, ILike, IObject, IPost, ITombstone, IUndo, IUpdate } from '../type.js';

type ChatActor = {
	id: string;
	host: string | null;
	uri?: string | null;
};

type ChatMessage = {
	id: string;
	uri?: string | null;
	text?: string | null;
	editedAt?: Date | null;
	dice?: ChatDiceResult | null;
};

type ChatRoom = {
	id: string;
	name: string;
	description?: string | null;
	uri?: string | null;
	isArchived?: boolean;
};

export type ChatPayloadOptions = {
	baseUrl: string;
	published?: string;
	updated?: string;
	roomUri?: string;
	channelUri?: string;
	channelRefs?: { id: string; start: number; length: number }[];
	channels?: { id: string; name: string }[];
	legacyChannel?: string | null;
	attachment?: IApDocument[];
	tag?: IObject[];
	activityId?: string;
};

export type ChatScope = 'everyone' | 'followers' | 'following' | 'mutual' | 'none';

const CHAT_SCOPES: readonly ChatScope[] = ['everyone', 'followers', 'following', 'mutual', 'none'];

export function normalizeChatScope(value: unknown): ChatScope {
	return CHAT_SCOPES.includes(value as ChatScope) ? value as ChatScope : 'mutual';
}

export function chatActorUri(actor: ChatActor, baseUrl: string): string {
	return actor.host == null ? `${baseUrl}/users/${actor.id}` : actor.uri!;
}

export function chatMessageUri(message: Pick<ChatMessage, 'id'> & { uri?: string | null }, baseUrl: string): string {
	return message.uri ?? `${baseUrl}/chat/messages/${message.id}`;
}

/** The ID of a message stored here, read from the URI this server gave it. */
export function localChatMessageIdFromUri(uri: string, baseUrl: string): string | null {
	const prefix = `${baseUrl}/chat/messages/`;
	return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
}

export function chatRoomUri(room: Pick<ChatRoom, 'id'> & { uri?: string | null }, baseUrl: string): string {
	return room.uri ?? `${baseUrl}/chat/rooms/${room.id}`;
}

/** A room lives on its owner's server, which matters for mirrors stored before they had a URI. */
export function chatRoomUriForOwner(room: Pick<ChatRoom, 'id'> & { uri?: string | null }, owner: Pick<ChatActor, 'host' | 'uri'> | null, baseUrl: string): string {
	const ownerBase = owner?.host != null ? owner.uri?.replace(/\/users\/.*$/, '') : null;
	return chatRoomUri(room, ownerBase ?? baseUrl);
}

export function buildChatNote(
	message: ChatMessage,
	fromUser: ChatActor,
	toUsers: ChatActor[],
	roomId: string | undefined,
	options: ChatPayloadOptions,
): IPost {
	const text = message.text ?? '';
	const note: IPost = {
		id: chatMessageUri(message, options.baseUrl),
		type: 'Note',
		attributedTo: chatActorUri(fromUser, options.baseUrl),
		content: escapeHtml(text),
		_misskey_content: text,
		source: { content: text, mediaType: 'text/x.misskeymarkdown' },
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		published: options.published ?? new Date().toISOString(),
		updated: message.editedAt?.toISOString(),
		_misskey_talk: true,
	};
	const dice = parseChatDiceResult(message.dice);
	if (dice != null) note._misskey_dice = dice;

	const roomUri = options.roomUri ?? (roomId ? chatRoomUri({ id: roomId }, options.baseUrl) : null);
	if (roomUri != null) {
		note.context = roomUri;
		note._misskey_chatRoom = roomUri;
		if (options.channelUri != null) note._misskey_chatChannel = options.channelUri;
		if (options.channelRefs?.length) note._misskey_chatChannelRefs = options.channelRefs;
	}

	if (options.attachment != null && options.attachment.length > 0) {
		note.attachment = options.attachment;
	}

	if (options.tag && options.tag.length > 0) {
		note.tag = options.tag;
	}

	return note;
}

export function buildChatUpdate(
	message: ChatMessage,
	fromUser: ChatActor,
	toUsers: ChatActor[],
	roomId: string | undefined,
	options: ChatPayloadOptions,
): IUpdate {
	const updated = message.editedAt?.toISOString() ?? options.updated ?? new Date().toISOString();
	const note = buildChatNote(message, fromUser, toUsers, roomId, { ...options, updated });
	note.updated = updated;

	return {
		id: `${chatMessageUri(message, options.baseUrl)}#update/${encodeURIComponent(updated)}`,
		type: 'Update',
		actor: chatActorUri(fromUser, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		object: note,
		published: options.published ?? new Date().toISOString(),
	};
}

/**
 * Lets a server that never got the message tell that its room is gone, rather than retrying for it.
 * A receiver goes no further on these: the sender could name any room.
 */
function chatRoomFields(options: ChatPayloadOptions): Pick<IObject, 'context' | '_misskey_chatRoom'> {
	return options.roomUri != null ? { context: options.roomUri, _misskey_chatRoom: options.roomUri } : {};
}

export function buildChatDelete(
	message: ChatMessage,
	fromUser: ChatActor,
	toUsers: ChatActor[],
	options: ChatPayloadOptions,
): IDelete {
	const messageUri = chatMessageUri(message, options.baseUrl);
	return {
		id: `${messageUri}#delete`,
		type: 'Delete',
		actor: chatActorUri(fromUser, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		...chatRoomFields(options),
		object: {
			id: messageUri,
			type: 'Tombstone',
			formerType: 'Note',
		} as ITombstone,
		published: options.published ?? new Date().toISOString(),
	};
}

export function buildChatReaction(
	message: ChatMessage,
	actor: ChatActor,
	toUsers: ChatActor[],
	reaction: string,
	options: ChatPayloadOptions,
): ILike {
	const messageUri = chatMessageUri(message, options.baseUrl);
	const federatedReaction = toFederatedChatReaction(reaction);
	return {
		id: options.activityId ?? `${chatActorUri(actor, options.baseUrl)}/chat-reactions/${encodeURIComponent(messageUri)}/${encodeURIComponent(federatedReaction)}`,
		type: 'EmojiReact',
		actor: chatActorUri(actor, options.baseUrl),
		object: messageUri,
		content: federatedReaction,
		_misskey_reaction: federatedReaction,
		...(options.tag?.length ? { tag: options.tag } : {}),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		...chatRoomFields(options),
		published: options.published ?? new Date().toISOString(),
	};
}

/**
 * Custom emoji travel as `:name:` plus an Emoji tag, the same as note reactions in renderLike.
 * Receivers scope the name to the actor's host themselves, and Mastodon rejects `:name@host:`.
 */
function toFederatedChatReaction(reaction: string): string {
	return reaction.replace(/^:([\w+-]+)@\.:$/, ':$1:');
}

export function buildChatReactionUndo(
	message: ChatMessage,
	actor: ChatActor,
	toUsers: ChatActor[],
	reaction: string,
	options: ChatPayloadOptions,
): IUndo {
	const react = buildChatReaction(message, actor, toUsers, reaction, options);
	return {
		id: `${react.id}/undo`,
		type: 'Undo',
		actor: chatActorUri(actor, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		...chatRoomFields(options),
		object: react,
		published: options.published ?? new Date().toISOString(),
	};
}

/** Names nobody: someone only invited gets this too, and must not learn from it who is in the room. */
export function buildChatRoomUpdate(
	room: ChatRoom,
	owner: ChatActor,
	options: ChatPayloadOptions,
): IUpdate {
	const roomUri = chatRoomUri(room, options.baseUrl);
	const updated = options.updated ?? new Date().toISOString();
	return {
		id: `${roomUri}#update/${encodeURIComponent(updated)}`,
		type: 'Update',
		actor: chatActorUri(owner, options.baseUrl),
		object: {
			id: roomUri,
			type: 'Group',
			name: room.name,
			summary: room.description ?? '',
			attributedTo: chatActorUri(owner, options.baseUrl),
			_misskey_chatArchived: room.isArchived,
			...(options.channels != null ? { _misskey_chatChannels: options.channels, _misskey_chatLegacyChannel: options.legacyChannel ?? null } : {}),
			updated,
		},
		published: options.published ?? new Date().toISOString(),
	};
}

/**
 * The owner's server is the only one that knows every member, so it passes on what a remote member sent.
 * This names the message instead of carrying it: the owner must not be able to speak for its author.
 * An edit gets an ID of its own, with the time it was made, because the message has been relayed before.
 */
export function buildChatRoomRelay(
	message: Pick<ChatMessage, 'id' | 'uri'>,
	room: Pick<ChatRoom, 'id'> & { uri?: string | null },
	owner: ChatActor,
	toUsers: ChatActor[],
	options: ChatPayloadOptions,
	editedAt?: Date,
): IAnnounce {
	const roomUri = chatRoomUri(room, options.baseUrl);
	const messageUri = chatMessageUri(message, options.baseUrl);
	return {
		id: `${roomUri}#relay/${encodeURIComponent(messageUri)}${editedAt != null ? `/${editedAt.getTime()}` : ''}`,
		type: 'Announce',
		actor: chatActorUri(owner, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		object: messageUri,
		context: roomUri,
		_misskey_chatRoom: roomUri,
		published: options.published ?? new Date().toISOString(),
	};
}

/**
 * A deletion or a reaction has no object of its own to fetch from its author's server, so the activity itself travels.
 * The receiver checks it against the room, and its signature would not survive the trip anyway.
 */
export function buildChatRoomActivityRelay(
	activity: IObject & { id: string },
	room: Pick<ChatRoom, 'id'> & { uri?: string | null },
	owner: ChatActor,
	toUsers: ChatActor[],
	options: ChatPayloadOptions,
): IAnnounce {
	const roomUri = chatRoomUri(room, options.baseUrl);
	const { '@context': _context, signature: _signature, ...original } = activity as IObject & { id: string; signature?: unknown };
	return {
		id: `${roomUri}#relay/${encodeURIComponent(activity.id)}`,
		type: 'Announce',
		actor: chatActorUri(owner, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		object: original,
		context: roomUri,
		_misskey_chatRoom: roomUri,
		published: options.published ?? new Date().toISOString(),
	};
}

/** Names nobody, for the same reason as buildChatRoomUpdate. */
export function buildChatRoomDelete(
	room: Pick<ChatRoom, 'id'> & { uri?: string | null },
	owner: ChatActor,
	options: ChatPayloadOptions,
): IDelete {
	const roomUri = chatRoomUri(room, options.baseUrl);
	return {
		id: `${roomUri}#delete`,
		type: 'Delete',
		actor: chatActorUri(owner, options.baseUrl),
		object: {
			id: roomUri,
			type: 'Tombstone',
			formerType: 'Group',
		} as ITombstone,
		published: options.published ?? new Date().toISOString(),
	};
}
