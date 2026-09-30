/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import * as WebSocket from 'ws';
import * as Redis from 'ioredis';
import { Converter } from 'megalodon';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import type { Packed } from '@/misc/json-schema.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { AuthenticateService, AuthenticationError } from '@/server/api/AuthenticateService.js';
import MainStreamConnection from '@/server/api/stream/Connection.js';
import type { ConnectionRequest } from '@/server/api/stream/Connection.js';
import { MastodonConverters } from '@/server/api/mastodon/MastodonConverters.js';
import type { Entity, MisskeyEntity } from 'megalodon';
import type * as http from 'node:http';
import type * as stream from 'node:stream';

export const MASTODON_STREAMING_PATH = '/api/v1/streaming';

// Below the per-connection limit of the Misskey stream Connection
const MAX_WATCHED_NOTES = 1024;

/**
 * A Misskey channel opened on behalf of a Mastodon stream
 */
interface ChannelSubscription {
	/** Misskey channel ID, unique within the connection */
	id: string;
	channel: 'homeTimeline' | 'localTimeline' | 'globalTimeline' | 'hashtag' | 'userList' | 'main';
	params: Record<string, unknown>;
	/** Mastodon "stream" value attached to every event */
	stream: string[];
	filter?: (note: Packed<'Note'>) => boolean;
	/** For main channel subscriptions: which main stream events to forward */
	mainEvents?: ('notification' | 'conversation')[];
}

/**
 * Maps a Mastodon stream name to the Misskey channels that provide it.
 * Returns null for streams that cannot be provided.
 */
function resolveStream(name: string, params: { tag?: string; list?: string }): Omit<ChannelSubscription, 'id'>[] | null {
	const media = name.endsWith(':media');
	const withFiles = media ? { withFiles: true } : {};

	switch (name) {
		case 'user':
			return [
				{ channel: 'homeTimeline', params: {}, stream: ['user'] },
				{ channel: 'main', params: {}, stream: ['user'], mainEvents: ['notification'] },
			];
		case 'user:notification':
			return [{ channel: 'main', params: {}, stream: ['user:notification'], mainEvents: ['notification'] }];
		case 'public':
		case 'public:media':
			return [{ channel: 'globalTimeline', params: withFiles, stream: [name] }];
		case 'public:local':
		case 'public:local:media':
			return [{ channel: 'localTimeline', params: withFiles, stream: [name] }];
		case 'public:remote':
		case 'public:remote:media':
			return [{ channel: 'globalTimeline', params: withFiles, stream: [name], filter: note => note.user.host != null }];
		case 'hashtag':
		case 'hashtag:local':
			if (!params.tag) return null;
			return [{
				channel: 'hashtag',
				params: { q: [[params.tag]] },
				stream: [name, params.tag],
				filter: name === 'hashtag:local' ? note => note.user.host == null : undefined,
			}];
		case 'list':
			if (!params.list) return null;
			return [{ channel: 'userList', params: { listId: params.list }, stream: ['list', params.list] }];
		case 'direct':
			return [{ channel: 'main', params: {}, stream: ['direct'], mainEvents: ['conversation'] }];
		default:
			return null;
	}
}

function streamKey(name: string, params: { tag?: string; list?: string }): string {
	return [name, params.tag ?? '', params.list ?? ''].join('\u0000');
}

/**
 * Mastodon-compatible streaming API (/api/v1/streaming).
 *
 * Each WebSocket connection drives a regular Misskey stream Connection through an in-memory socket,
 * so timeline filtering (visibility, mutes, blocks, role policies) stays identical to the Misskey streaming API.
 */
@Injectable()
export class MastodonStreamingService implements OnApplicationShutdown {
	private readonly logger: Logger;
	#wss: WebSocket.WebSocketServer;
	#globalEv = new EventEmitter();
	#connections = new Map<WebSocket.WebSocket, number>();
	#cleanConnectionsIntervalId: NodeJS.Timeout | null = null;

	constructor(
		@Inject(DI.redisForSub)
		private readonly redisForSub: Redis.Redis,

		private readonly moduleRef: ModuleRef,
		private readonly authenticateService: AuthenticateService,
		private readonly noteEntityService: NoteEntityService,
		private readonly mastoConverters: MastodonConverters,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('masto-streaming');
		this.#globalEv.setMaxListeners(0);

		this.#wss = new WebSocket.WebSocketServer({
			noServer: true,
			// Browser clients pass the access token as the WebSocket subprotocol, which must be echoed back.
			handleProtocols: (protocols) => protocols.values().next().value ?? false,
		});

		this.redisForSub.on('message', this.onRedisMessage);

		// Connections that stopped answering pings are probably gone already
		this.#cleanConnectionsIntervalId = setInterval(() => {
			const now = Date.now();
			for (const [connection, lastActive] of this.#connections.entries()) {
				if (now - lastActive > 1000 * 60 * 2) {
					connection.terminate();
					this.#connections.delete(connection);
				} else {
					connection.ping();
				}
			}
		}, 1000 * 60);
	}

	@bindThis
	private onRedisMessage(_: string, data: string): void {
		if (this.#globalEv.listenerCount('message') === 0) return;
		this.#globalEv.emit('message', JSON.parse(data));
	}

	/**
	 * Whether an upgrade request is for the Mastodon streaming API.
	 */
	@bindThis
	public handles(request: http.IncomingMessage): boolean {
		if (request.url == null) return false;
		const { pathname } = new URL(request.url, 'http://localhost');
		return pathname === MASTODON_STREAMING_PATH || pathname.startsWith(`${MASTODON_STREAMING_PATH}/`);
	}

	@bindThis
	public async handleUpgrade(request: http.IncomingMessage, socket: stream.Duplex, head: Buffer): Promise<void> {
		const url = new URL(request.url ?? '', 'http://localhost');

		const protocol = request.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
		const token = request.headers.authorization?.startsWith('Bearer ')
			? request.headers.authorization.slice(7)
			: url.searchParams.get('access_token') ?? protocol ?? null;

		let user: MiLocalUser | null = null;
		let app: MiAccessToken | null = null;
		try {
			const [authenticatedUser, authenticatedApp, flashToken] = await this.authenticateService.authenticate(token);
			// Plays use the HTTP API with per-operation permissions, not unrestricted streaming sessions.
			if (flashToken != null) throw new AuthenticationError('Flash tokens cannot use the Mastodon streaming API.');
			user = authenticatedUser;
			app = authenticatedApp;

			if (app !== null && !app.permission.some(p => p === 'read:account')) {
				throw new AuthenticationError('Your app does not have necessary permissions to use websocket API.');
			}
		} catch (e) {
			socket.write(e instanceof AuthenticationError
				? 'HTTP/1.1 401 Unauthorized\r\n\r\n'
				: 'HTTP/1.1 500 Internal Server Error\r\n\r\n');
			socket.destroy();
			return;
		}

		if (user?.isSuspended) {
			socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
			socket.destroy();
			return;
		}

		const contextId = ContextIdFactory.create();
		this.moduleRef.registerRequestByContextId<ConnectionRequest>({ user, token: app }, contextId);
		const connection = await this.moduleRef.create(MainStreamConnection, contextId);
		await connection.init();

		this.#wss.handleUpgrade(request, socket, head, (ws) => {
			this.onConnection(ws, connection, user, url.searchParams);
		});
	}

	private async onConnection(ws: WebSocket.WebSocket, connection: MainStreamConnection, me: MiLocalUser | null, query: URLSearchParams): Promise<void> {
		const ev = new EventEmitter();
		const onMessage = (data: { channel: string; message: unknown }) => ev.emit(data.channel, data.message);
		this.#globalEv.on('message', onMessage);

		const bridge = new MastodonStreamBridge(ws, me, this.noteEntityService, this.mastoConverters, this.logger);
		await connection.listen(ev, bridge.misskeySocket as unknown as WebSocket.WebSocket);

		this.#connections.set(ws, Date.now());
		ws.on('pong', () => this.#connections.set(ws, Date.now()));

		ws.once('close', () => {
			ev.removeAllListeners();
			connection.dispose();
			this.#globalEv.off('message', onMessage);
			this.#connections.delete(ws);
		});

		ws.on('message', (data) => bridge.onClientMessage(data.toString()));

		// Mastodon allows choosing the first stream in the URL
		const initialStream = query.get('stream');
		if (initialStream) {
			bridge.subscribe(initialStream, {
				tag: query.get('tag') ?? undefined,
				list: query.get('list') ?? undefined,
			});
		}
	}

	@bindThis
	public onApplicationShutdown(): void {
		if (this.#cleanConnectionsIntervalId) {
			clearInterval(this.#cleanConnectionsIntervalId);
			this.#cleanConnectionsIntervalId = null;
		}
		this.redisForSub.off('message', this.onRedisMessage);
		this.#wss.close();
		this.#wss.clients.forEach(client => client.terminate());
	}
}

/**
 * Translates between one Mastodon streaming client and one Misskey stream Connection.
 */
class MastodonStreamBridge {
	/** The socket the Misskey Connection reads from and writes to */
	public readonly misskeySocket = Object.assign(new EventEmitter(), {
		send: (data: string) => this.onMisskeyMessage(data),
	});

	/** Mastodon stream key -> Misskey channel subscriptions */
	private streams = new Map<string, ChannelSubscription[]>();
	/** Misskey channel ID -> subscription */
	private channels = new Map<string, ChannelSubscription>();
	/** Note ID -> Mastodon streams it was delivered to, to address delete and edit events */
	private deliveredNotes = new Map<string, string[]>();
	private nextChannelId = 0;
	/** Events are converted asynchronously, but must reach the client in order */
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly ws: WebSocket.WebSocket,
		private readonly me: MiLocalUser | null,
		private readonly noteEntityService: NoteEntityService,
		private readonly mastoConverters: MastodonConverters,
		private readonly logger: Logger,
	) {}

	public onClientMessage(raw: string): void {
		let message: { type?: unknown; stream?: unknown; tag?: unknown; list?: unknown };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof message.stream !== 'string') return;

		const params = {
			tag: typeof message.tag === 'string' ? message.tag : undefined,
			list: typeof message.list === 'string' ? message.list : undefined,
		};
		if (message.type === 'subscribe') this.subscribe(message.stream, params);
		if (message.type === 'unsubscribe') this.unsubscribe(message.stream, params);
	}

	public subscribe(name: string, params: { tag?: string; list?: string }): void {
		const key = streamKey(name, params);
		if (this.streams.has(key)) return;

		const resolved = resolveStream(name, params);
		if (resolved == null) {
			this.sendToClient({ error: 'Unknown stream type', status: 400 });
			return;
		}
		if (this.me == null && resolved.some(s => s.channel === 'homeTimeline' || s.channel === 'main')) {
			this.sendToClient({ error: 'Missing access token', status: 401 });
			return;
		}

		const subscriptions = resolved.map(s => ({ ...s, id: `mastodon-${this.nextChannelId++}` }));
		this.streams.set(key, subscriptions);
		for (const subscription of subscriptions) {
			this.channels.set(subscription.id, subscription);
			this.sendToMisskey('connect', { channel: subscription.channel, id: subscription.id, params: subscription.params });
		}
	}

	public unsubscribe(name: string, params: { tag?: string; list?: string }): void {
		const key = streamKey(name, params);
		const subscriptions = this.streams.get(key);
		if (!subscriptions) return;

		this.streams.delete(key);
		for (const subscription of subscriptions) {
			this.channels.delete(subscription.id);
			this.sendToMisskey('disconnect', { id: subscription.id });
		}
	}

	private sendToMisskey(type: string, body: unknown): void {
		this.misskeySocket.emit('message', Buffer.from(JSON.stringify({ type, body })));
	}

	private sendToClient(data: Record<string, unknown>): void {
		if (this.ws.readyState !== WebSocket.WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(data));
	}

	private sendEvent(stream: string[], event: string, payload: unknown): void {
		this.sendToClient({
			stream,
			event,
			payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
		});
	}

	private onMisskeyMessage(raw: string): void {
		this.queue = this.queue
			.then(() => this.handleMisskeyMessage(JSON.parse(raw)))
			.catch(err => this.logger.error('Failed to relay a streaming event', { error: err }));
	}

	private async handleMisskeyMessage(message: { type: string; body: { id: string; type: string; body: unknown } }): Promise<void> {
		if (message.type === 'channel') {
			const subscription = this.channels.get(message.body.id);
			if (subscription == null) return;

			if (subscription.channel === 'main') {
				await this.handleMainEvent(subscription, message.body.type, message.body.body);
			} else if (message.body.type === 'note') {
				await this.handleNote(subscription, message.body.body as Packed<'Note'>);
			}
		} else if (message.type === 'noteUpdated') {
			await this.handleNoteUpdated(message.body.id, message.body.type);
		}
	}

	private async handleNote(subscription: ChannelSubscription, note: Packed<'Note'>): Promise<void> {
		if (subscription.filter && !subscription.filter(note)) return;

		const status = await this.toStatus(note);
		this.sendEvent(subscription.stream, 'update', status);

		// Watch the note so that deletions and edits reach the client
		if (!this.deliveredNotes.has(note.id)) {
			this.deliveredNotes.set(note.id, subscription.stream);
			this.sendToMisskey('s', { id: note.id });

			// Misskey keeps watching only the most recent notes of a connection as well
			if (this.deliveredNotes.size > MAX_WATCHED_NOTES) {
				const [oldest] = this.deliveredNotes.keys();
				this.deliveredNotes.delete(oldest);
				this.sendToMisskey('un', { id: oldest });
			}
		}
	}

	private async handleMainEvent(subscription: ChannelSubscription, type: string, body: unknown): Promise<void> {
		if (type === 'notification' && subscription.mainEvents?.includes('notification')) {
			const entity = Converter.notification(body as MisskeyEntity.Notification);
			if (entity instanceof Error) return; // types Mastodon has no equivalent for
			const notification = await this.mastoConverters.convertNotification(entity, this.me);
			if (notification) this.sendEvent(subscription.stream, 'notification', notification);
		}

		if (type === 'mention' && subscription.mainEvents?.includes('conversation')) {
			const note = body as Packed<'Note'>;
			if (note.visibility !== 'specified') return;
			const conversation = await this.mastoConverters.convertConversation(Converter.noteToConversation(note as unknown as MisskeyEntity.Note), this.me);
			this.sendEvent(subscription.stream, 'conversation', conversation);
		}
	}

	private async handleNoteUpdated(noteId: string, type: string): Promise<void> {
		const stream = this.deliveredNotes.get(noteId) ?? ['user'];

		if (type === 'deleted') {
			this.sendEvent(stream, 'delete', noteId);
			this.deliveredNotes.delete(noteId);
		} else if (type === 'updated') {
			const note = await this.noteEntityService.pack(noteId, this.me).catch(() => null);
			if (note == null) return;
			this.sendEvent(stream, 'status.update', await this.toStatus(note));
		}
	}

	private async toStatus(note: Packed<'Note'>) {
		const status = Converter.note(note as unknown as MisskeyEntity.Note, this.mastoConverters.publicBaseUrl) as Entity.Status;
		return await this.mastoConverters.convertStatus(status, this.me);
	}
}
