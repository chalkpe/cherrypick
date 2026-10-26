/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as http from 'node:http';
import type * as stream from 'node:stream';
import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

const PREFIX = '/livekit';

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
		private liveKitService: LiveKitService,
		private chatVoiceService: ChatVoiceService,
	) {
	}

	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		// webhook の署名は生の本文に対して検証するので、文字列のまま受け取る
		fastify.removeAllContentTypeParsers();
		for (const type of ['application/webhook+json', 'application/json']) {
			fastify.addContentTypeParser(type, { parseAs: 'string' }, (_request, body, parsed) => parsed(null, body));
		}

		fastify.post('/webhook', async (request, reply) => {
			if (!this.liveKitService.isEnabled) return reply.code(404).send();
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

		fastify.get('/rtc/*', async (request, reply) => {
			if (!this.liveKitService.isEnabled) return reply.code(404).send();

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
		const target = this.targetOf(request.url ?? '/');
		if (target == null) {
			socket.end(statusLine(404, 'Not Found') + 'Connection: close\r\nContent-Length: 0\r\n\r\n');
			return;
		}

		const headers: http.OutgoingHttpHeaders = { host: target.host };
		for (const name of FORWARDED_UPGRADE_HEADERS) {
			const value = request.headers[name];
			if (value != null) headers[name] = value;
		}

		const proxyRequest = http.request(target, { method: 'GET', headers });

		// アップグレード前にブラウザが諦めたら、LiveKit への要求も捨てる。
		// upgrade で渡されるソケットは止まっているので、読まないと切断 (end) に気付けない。
		// 101 を返す前にブラウザが送るものは普通ないが、届いたら後で LiveKit に渡す
		const early: Buffer[] = [];
		const keep = (chunk: Buffer) => early.push(chunk);
		const abandon = () => proxyRequest.destroy();
		socket.on('data', keep);
		socket.once('end', abandon);
		socket.once('close', abandon);
		const stopWatching = () => {
			socket.off('data', keep);
			socket.off('end', abandon);
			socket.off('close', abandon);
			socket.pause();
		};

		proxyRequest.setTimeout(this.upstreamTimeoutMs, () => {
			if (socket.writable) {
				socket.end(statusLine(504, 'Gateway Timeout') + 'Connection: close\r\nContent-Length: 0\r\n\r\n');
			}
			proxyRequest.destroy();
		});

		proxyRequest.on('upgrade', (proxyResponse, proxySocket, proxyHead) => {
			stopWatching();
			proxySocket.setTimeout(0);
			socket.write(statusLine(101, 'Switching Protocols') + rawHeaders(proxyResponse) + '\r\n');
			if (proxyHead.length > 0) socket.write(proxyHead);
			if (head.length > 0) proxySocket.write(head);
			for (const chunk of early) proxySocket.write(chunk);

			proxySocket.on('error', () => socket.destroy());
			socket.on('error', () => proxySocket.destroy());
			proxySocket.on('close', () => socket.destroy());
			socket.on('close', () => proxySocket.destroy());

			proxySocket.pipe(socket);
			socket.pipe(proxySocket);
		});

		// LiveKit がアップグレードを拒否した場合(認証エラーなど)はその応答を返す。
		// 本文は分割を解いた状態で届くので、接続の終わりで区切る
		proxyRequest.on('response', proxyResponse => {
			stopWatching();
			socket.write(statusLine(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage ?? '') + rawHeaders(proxyResponse, DROPPED_RESPONSE_HEADERS) + 'Connection: close\r\n\r\n');
			proxyResponse.pipe(socket);
		});

		proxyRequest.on('error', () => {
			if (socket.writable) {
				socket.end(statusLine(502, 'Bad Gateway') + 'Connection: close\r\nContent-Length: 0\r\n\r\n');
			} else {
				socket.destroy();
			}
		});

		socket.on('error', () => proxyRequest.destroy());

		proxyRequest.end();
	}

	/**
	 * 中継先を LiveKit の /rtc 配下に限る。
	 * `/livekit//other.host/...` のような経路は URL として別ホストに解決されるので弾く
	 */
	private targetOf(url: string): URL | null {
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
