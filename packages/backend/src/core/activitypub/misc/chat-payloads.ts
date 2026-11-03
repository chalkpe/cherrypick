/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { escapeHtml } from '@/misc/escape-html.js';
import type { IApDocument, IDelete, ILike, IObject, IPost, ITombstone, IUndo, IUpdate } from '../type.js';

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
	attachment?: IApDocument;
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

export function chatMessageUri(message: ChatMessage, baseUrl: string): string {
	return message.uri ?? `${baseUrl}/chat/messages/${message.id}`;
}

export function chatRoomUri(room: Pick<ChatRoom, 'id'> & { uri?: string | null }, baseUrl: string): string {
	return room.uri ?? `${baseUrl}/chat/rooms/${room.id}`;
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

	const roomUri = options.roomUri ?? (roomId ? chatRoomUri({ id: roomId }, options.baseUrl) : null);
	if (roomUri != null) {
		note.context = roomUri;
		note._misskey_chatRoom = roomUri;
	}

	if (options.attachment) {
		note.attachment = [options.attachment];
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
		object: react,
		published: options.published ?? new Date().toISOString(),
	};
}

export function buildChatRoomUpdate(
	room: ChatRoom,
	owner: ChatActor,
	toUsers: ChatActor[],
	options: ChatPayloadOptions,
): IUpdate {
	const roomUri = chatRoomUri(room, options.baseUrl);
	return {
		id: `${roomUri}#update/${encodeURIComponent(options.updated ?? new Date().toISOString())}`,
		type: 'Update',
		actor: chatActorUri(owner, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		object: {
			id: roomUri,
			type: 'Group',
			name: room.name,
			summary: room.description ?? '',
			attributedTo: chatActorUri(owner, options.baseUrl),
			_misskey_chatArchived: room.isArchived,
		},
		published: options.published ?? new Date().toISOString(),
	};
}

export function buildChatRoomDelete(
	room: Pick<ChatRoom, 'id'> & { uri?: string | null },
	owner: ChatActor,
	toUsers: ChatActor[],
	options: ChatPayloadOptions,
): IDelete {
	const roomUri = chatRoomUri(room, options.baseUrl);
	return {
		id: `${roomUri}#delete`,
		type: 'Delete',
		actor: chatActorUri(owner, options.baseUrl),
		to: toUsers.map(user => chatActorUri(user, options.baseUrl)),
		object: {
			id: roomUri,
			type: 'Tombstone',
			formerType: 'Group',
		} as ITombstone,
		published: options.published ?? new Date().toISOString(),
	};
}
