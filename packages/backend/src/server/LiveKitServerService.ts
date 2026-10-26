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

/**
 * LiveKit のシグナリングを同じドメインの /livekit 配下で中継し、LiveKit からの webhook を受け取る。
 * 運用者がリバースプロキシやサブドメインを追加しなくて済むようにするため。
 */
@Injectable()
export class LiveKitServerService {
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

			const target = new URL(stripPrefix(request.url), this.liveKitService.getInternalUrl());
			const headers: Record<string, string> = {};
			if (request.headers.authorization) headers.authorization = request.headers.authorization;

			let res: Response;
			try {
				res = await fetch(target, { headers });
			} catch {
				return reply.code(502).send();
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
		const target = new URL(stripPrefix(request.url ?? '/'), this.liveKitService.getInternalUrl());

		const proxyRequest = http.request(target, {
			method: 'GET',
			headers: { ...request.headers, host: target.host },
		});

		proxyRequest.on('upgrade', (proxyResponse, proxySocket, proxyHead) => {
			socket.write(statusLine(101, 'Switching Protocols') + rawHeaders(proxyResponse) + '\r\n');
			if (proxyHead.length > 0) socket.write(proxyHead);
			if (head.length > 0) proxySocket.write(head);

			proxySocket.on('error', () => socket.destroy());
			socket.on('error', () => proxySocket.destroy());
			proxySocket.on('close', () => socket.destroy());
			socket.on('close', () => proxySocket.destroy());

			proxySocket.pipe(socket);
			socket.pipe(proxySocket);
		});

		// LiveKit がアップグレードを拒否した場合(認証エラーなど)はその応答をそのまま返す
		proxyRequest.on('response', proxyResponse => {
			socket.write(statusLine(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage ?? '') + rawHeaders(proxyResponse) + '\r\n');
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
}

function stripPrefix(url: string): string {
	const stripped = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url;
	return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function statusLine(status: number, message: string): string {
	return `HTTP/1.1 ${status} ${message}\r\n`;
}

function rawHeaders(response: http.IncomingMessage): string {
	let result = '';
	for (let i = 0; i < response.rawHeaders.length; i += 2) {
		result += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
	}
	return result;
}
