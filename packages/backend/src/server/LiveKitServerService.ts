/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type * as stream from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { getIpHash } from '@/misc/get-ip-hash.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { ApSignedRequestVerifierService } from '@/core/activitypub/ApSignedRequestVerifierService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

const PREFIX = '/livekit';
const MAX_PRE_UPGRADE_BYTES = 64 * 1024;

// 他のサーバーからのトークン要求。署名を確かめる前に DB を引くので IP ごとにも絞る
const FEDERATION_TOKEN_IP_LIMIT = { key: 'voiceFederationTokenIp', duration: 60 * 1000, max: 60 };
const FEDERATION_TOKEN_USER_LIMIT = { key: 'voiceFederationToken', duration: 60 * 1000, max: 30 };
// 設定の報告は、一台のサーバーがそのユーザー全員の分を同じ IP から送ってくる。ユーザーごとの予算 (FEDERATION_STATUS_USER_LIMIT) の何人分も入るようにする
const FEDERATION_STATUS_IP_LIMIT = { key: 'voiceFederationStatusIp', duration: 60 * 1000, max: 600 };
const FEDERATION_STATUS_USER_LIMIT = { key: 'voiceFederationStatus', duration: 60 * 1000, max: 30 };
const FEDERATION_TOKEN_BODY_LIMIT = 16 * 1024;

// LiveKit のシグナリングに必要なヘッダーだけを中継する (Cookie などは渡さない)
const FORWARDED_UPGRADE_HEADERS = [
	'upgrade',
	'connection',
	'sec-websocket-key',
	'sec-websocket-version',
	'sec-websocket-extensions',
	'sec-websocket-protocol',
	'authorization',
	'user-agent',
];

// 拒否応答を中継するとき、本文の区切り方を変えるので元のものは捨てる
const DROPPED_RESPONSE_HEADERS = new Set(['transfer-encoding', 'content-length', 'connection', 'keep-alive']);

/**
 * LiveKit のシグナリングを同じドメインの /livekit 配下で中継し、LiveKit からの webhook を受け取る。
 * 運用者がリバースプロキシやサブドメインを追加しなくて済むようにするため。
 */
@Injectable()
export class LiveKitServerService {
	/** LiveKit がこの時間内に応答しなければ 504 を返す */
	public upstreamTimeoutMs = 10_000;

	constructor(
		@Inject(DI.config)
		private config: Config,

		private liveKitService: LiveKitService,
		private chatVoiceService: ChatVoiceService,
		private apSignedRequestVerifierService: ApSignedRequestVerifierService,
		private rateLimiterService: RateLimiterService,
	) {
	}

	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		// 通話が使えないときは、本文を読む前 (大きさや形式を見て 413 / 415 を返す前) に、どの要求にも 404 を返す
		fastify.addHook('onRequest', async (_request, reply) => {
			if (!this.liveKitService.isEnabled) return reply.code(404).send();
		});

		// webhook と他のサーバーからの要求の署名は生の本文に対して検証するので、文字列のまま受け取る
		fastify.removeAllContentTypeParsers();
		for (const type of ['application/webhook+json', 'application/json', 'application/activity+json']) {
			fastify.addContentTypeParser(type, { parseAs: 'string' }, (_request, body, parsed) => parsed(null, body));
		}

		fastify.post('/webhook', async (request, reply) => {
			if (typeof request.body !== 'string') return reply.code(400).send();

			let event;
			try {
				event = await this.liveKitService.receiveWebhook(request.body, request.headers.authorization);
			} catch {
				return reply.code(401).send();
			}

			this.chatVoiceService.handleWebhook(event);
			return reply.code(204).send();
		});

		// 他のサーバーのユーザーが、このサーバーのルームの通話に入るためのトークン。
		// 要求はそのユーザーの鍵で署名されている。
		// 404 は「このサーバーでは通話が使えない」の意味だけに使う (相手のサーバーはそれを覚えておく)
		fastify.post('/federation/token', { bodyLimit: FEDERATION_TOKEN_BODY_LIMIT }, async (request, reply) => {
			// LiveKit や DB のエラーの内容を他のサーバーに見せない
			try {
				if (this.config.enableIpRateLimit) {
					if (await this.rateLimiterService.limit(FEDERATION_TOKEN_IP_LIMIT, getIpHash(request.ip)) != null) return reply.code(429).send();
				}

				const rawBody = typeof request.body === 'string' ? request.body : '';
				const user = await this.apSignedRequestVerifierService.verify({ method: request.method, url: request.url, headers: request.headers }, rawBody);
				if (user == null) return reply.code(401).send();

				if (await this.rateLimiterService.limit(FEDERATION_TOKEN_USER_LIMIT, user.id) != null) return reply.code(429).send();

				const body = parseTokenRequest(rawBody);
				if (body == null) return reply.code(400).send();

				// ルームに関わる拒否はすべて同じ 403 にして、ルームがあるかどうかも分からないようにする
				const roomId = this.localRoomIdOf(body.room);
				const result = roomId != null ? await this.chatVoiceService.issueRemoteJoinToken(user, roomId, body.canScreenShare) : 'forbidden';
				if (result === 'forbidden') return reply.code(403).send();

				// TURN の資格情報も渡す。相手のユーザーのブラウザも、このサーバーの LiveKit に TURN を経由してつなぐことがある
				const { url, token, iceServers, participants, updatedAt } = result;
				return reply.code(200).send({ url, token, iceServers, participants, updatedAt });
			} catch {
				return reply.code(500).send();
			}
		});

		fastify.post('/federation/status', { bodyLimit: FEDERATION_TOKEN_BODY_LIMIT }, async (request, reply) => {
			try {
				if (this.config.enableIpRateLimit && await this.rateLimiterService.limit(FEDERATION_STATUS_IP_LIMIT, getIpHash(request.ip)) != null) return reply.code(429).send();
				const rawBody = typeof request.body === 'string' ? request.body : '';
				const user = await this.apSignedRequestVerifierService.verify({ method: request.method, url: request.url, headers: request.headers }, rawBody);
				if (user == null) return reply.code(401).send();
				if (await this.rateLimiterService.limit(FEDERATION_STATUS_USER_LIMIT, user.id) != null) return reply.code(429).send();
				const body: unknown = JSON.parse(rawBody);
				if (body == null || typeof body !== 'object') return reply.code(400).send();
				const { room, sessionId, micMuted, deafened } = body as Record<string, unknown>;
				if (typeof room !== 'string' || typeof sessionId !== 'string' || sessionId.length > 128 || typeof micMuted !== 'boolean' || typeof deafened !== 'boolean') return reply.code(400).send();
				const roomId = this.localRoomIdOf(room);
				if (roomId == null || !await this.chatVoiceService.reportStatus(user, roomId, sessionId, { micMuted, deafened })) return reply.code(403).send();
				return reply.code(200).send({});
			} catch (err) {
				return reply.code(err instanceof SyntaxError ? 400 : 500).send();
			}
		});

		fastify.get('/rtc/*', async (request, reply) => {
			const target = this.targetOf(request.url);
			if (target == null) return reply.code(404).send();

			const headers: Record<string, string> = {};
			if (request.headers.authorization) headers.authorization = request.headers.authorization;

			let res: Response;
			try {
				res = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(this.upstreamTimeoutMs) });
			} catch (err) {
				return reply.code(err instanceof DOMException && err.name === 'TimeoutError' ? 504 : 502).send();
			}

			const contentType = res.headers.get('content-type');
			if (contentType) reply.header('content-type', contentType);
			return reply.code(res.status).send(await res.text());
		});

		done();
	}

	@bindThis
	public handles(request: http.IncomingMessage): boolean {
		if (!this.liveKitService.isEnabled || request.url == null) return false;
		return request.url.startsWith(`${PREFIX}/`);
	}

	@bindThis
	public handleUpgrade(request: http.IncomingMessage, socket: stream.Duplex, head: Buffer): void {
		// 拒否応答の書き込みも EPIPE になりうる。バッファの監視とは分け、close までは必ずエラーを受ける。
		const onSocketError = () => socket.destroy();
		socket.on('error', onSocketError);
		socket.once('close', () => socket.off('error', onSocketError));
		const target = this.targetOf(request.url ?? '/');
		if (target == null) {
			socket.end(statusLine(404, 'Not Found') + 'Connection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
			return;
		}

		const headers: http.OutgoingHttpHeaders = { host: target.host };
		for (const name of FORWARDED_UPGRADE_HEADERS) {
			const value = request.headers[name];
			if (value != null) headers[name] = value;
		}

		// 101 より前のデータは小さく制限し、head も同じ予算に含める。
		if (head.length > MAX_PRE_UPGRADE_BYTES) {
			socket.end(statusLine(413, 'Payload Too Large') + 'Connection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
			return;
		}
		let proxyRequest: http.ClientRequest;
		try {
			// RoomServiceClient supports an https internalUrl, so the signaling
			// proxy must use the matching request module instead of throwing
			// synchronously on an https: target.
			proxyRequest = target.protocol === 'https:'
				? https.request(target, { method: 'GET', headers })
				: http.request(target, { method: 'GET', headers });
		} catch {
			socket.end(statusLine(502, 'Bad Gateway') + 'Connection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
			return;
		}
		const early: Buffer[] = head.length > 0 ? [head] : [];
		let earlyBytes = head.length;
		let settled = false;
		const stopWatching = () => {
			socket.off('data', keep);
			socket.off('end', abandon);
			socket.off('close', abandon);
			socket.off('error', abandon);
			socket.pause();
			proxyRequest.setTimeout(0);
		};
		const clear = () => {
			early.length = 0;
			earlyBytes = 0;
		};
		const abandon = () => {
			if (settled) return;
			settled = true;
			stopWatching();
			clear();
			proxyRequest.destroy();
			socket.destroy();
		};
		const fail = (status: number, message: string) => {
			if (settled) return;
			settled = true;
			stopWatching();
			clear();
			if (socket.writable) socket.end(statusLine(status, message) + 'Connection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
			else socket.destroy();
			proxyRequest.destroy();
		};
		const keep = (chunk: Buffer) => {
			earlyBytes += chunk.length;
			if (earlyBytes > MAX_PRE_UPGRADE_BYTES) fail(413, 'Payload Too Large');
			else early.push(chunk);
		};
		socket.on('data', keep);
		socket.once('end', abandon);
		socket.once('close', abandon);
		socket.once('error', abandon);
		proxyRequest.setTimeout(this.upstreamTimeoutMs, () => fail(504, 'Gateway Timeout'));

		proxyRequest.on('upgrade', (proxyResponse, proxySocket, proxyHead) => {
			if (settled) { proxySocket.destroy(); return; }
			settled = true;
			stopWatching();
			proxySocket.setTimeout(0);
			proxySocket.on('error', () => socket.destroy());
			socket.on('error', () => proxySocket.destroy());
			proxySocket.on('close', () => socket.destroy());
			socket.on('close', () => proxySocket.destroy());
			socket.write(statusLine(101, 'Switching Protocols') + rawHeaders(proxyResponse) + '\r\n');
			if (proxyHead.length > 0) socket.write(proxyHead);
			for (const chunk of early) proxySocket.write(chunk);
			clear();
			proxySocket.pipe(socket);
			socket.pipe(proxySocket);
		});

		// 拒否応答は本文を中継したら読み側も閉じ、送信し続けるクライアントを残さない。
		proxyRequest.on('response', proxyResponse => {
			if (settled) { proxyResponse.destroy(); return; }
			settled = true;
			stopWatching();
			clear();
			socket.once('finish', () => socket.destroy());
			socket.once('close', () => proxyResponse.destroy());
			socket.once('error', () => proxyResponse.destroy());
			proxyResponse.once('error', () => socket.destroy());
			proxyResponse.once('aborted', () => socket.destroy());
			socket.write(statusLine(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage ?? '') + rawHeaders(proxyResponse, DROPPED_RESPONSE_HEADERS) + 'Connection: close\r\n\r\n');
			proxyResponse.pipe(socket);
		});
		proxyRequest.on('error', () => fail(502, 'Bad Gateway'));

		proxyRequest.end();
	}

	/**
	 * このサーバーのルーム URI (`${config.url}/chat/rooms/${id}`) と完全に一致するときだけ id を返す
	 */
	private localRoomIdOf(uri: string): string | null {
		const prefix = `${this.config.url}/chat/rooms/`;
		if (!uri.startsWith(prefix)) return null;
		const roomId = uri.slice(prefix.length);
		return /^[a-zA-Z0-9]+$/.test(roomId) ? roomId : null;
	}

	/**
	 * 中継先を LiveKit の /rtc 配下に限る。
	 * `/livekit//other.host/...` のような経路は URL として別ホストに解決されるので弾く
	 */
	private targetOf(url: string): URL | null {
		const path = stripPrefix(url).split('?')[0];
		// URL と上流ルーターの正規化の差で RTC 配下を抜けないよう、区切り文字と二重エンコードを断る。
		if (path.includes('\\') || /%(?:2f|5c|25)/i.test(path)) return null;
		try {
			if (decodeURIComponent(path).split('/').some(segment => segment === '.' || segment === '..')) return null;
		} catch {
			return null;
		}
		const base = new URL(this.liveKitService.getInternalUrl());
		let target: URL;
		try {
			target = new URL(stripPrefix(url), base);
		} catch {
			return null;
		}
		if (target.origin !== base.origin) return null;
		if (target.pathname !== '/rtc' && !target.pathname.startsWith('/rtc/')) return null;
		return target;
	}
}

function parseTokenRequest(rawBody: string): { room: string; canScreenShare: boolean } | null {
	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return null;
	}
	if (typeof body !== 'object' || body == null) return null;
	const { room, canScreenShare } = body as Record<string, unknown>;
	if (typeof room !== 'string' || typeof canScreenShare !== 'boolean') return null;
	return { room, canScreenShare };
}

function stripPrefix(url: string): string {
	const stripped = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url;
	return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function statusLine(status: number, message: string): string {
	return `HTTP/1.1 ${status} ${message}\r\n`;
}

function rawHeaders(response: http.IncomingMessage, dropped: Set<string> = new Set()): string {
	let result = '';
	for (let i = 0; i < response.rawHeaders.length; i += 2) {
		if (dropped.has(response.rawHeaders[i].toLowerCase())) continue;
		result += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
	}
	return result;
}
