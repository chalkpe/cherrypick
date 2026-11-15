/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { Injectable } from '@nestjs/common';
import { RecordingStorageService } from '@/core/RecordingStorageService.js';
import { AuthenticateService } from '@/server/api/AuthenticateService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import { bindThis } from '@/decorators.js';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

const DOWNLOAD_USER_LIMIT = { key: 'voiceRecordingDownload', duration: 60 * 1000, max: 30 };

// 드라이브에 넣지 않고 잠시 보관한 최종 녹화를 녹화한 본인만 한 번 내려받는 전용 경로.
// 로그인한 본인 확인(액세스 토큰)과 임시 보관 기록의 소유자가 같아야 하고, 전달이 끝나면 보관을 지운다.
@Injectable()
export class RecordingDownloadServerService {
	constructor(
		private recordingStorage: RecordingStorageService,
		private authenticateService: AuthenticateService,
		private rateLimiterService: RateLimiterService,
	) {
	}

	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		// HEAD가 본문을 내려주지 않고 한 번 내려받기를 소진하지 않도록 자동 HEAD 등록을 끈다.
		fastify.get<{ Params: { id: string } }>('/recording-download/:id', { exposeHeadRoute: false }, async (request, reply) => {
			const authorization = request.headers.authorization;
			const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
			let user, appToken, flashToken;
			try {
				[user, appToken, flashToken] = await this.authenticateService.authenticate(token);
			} catch {
				return reply.code(401).send();
			}
			if (user == null) return reply.code(401).send();
			// 공통 API와 같은 정지 계정·권한 검사를 이 전용 경로에도 적용한다.
			if (user.isSuspended) return reply.code(403).send();
			if (appToken != null && !appToken.permission.some(p => p === 'read:drive')) return reply.code(403).send();
			if (flashToken != null && !flashToken.permissions.some(p => p === 'read:drive')) return reply.code(403).send();
			if (await this.rateLimiterService.limit(DOWNLOAD_USER_LIMIT, user.id) != null) return reply.code(429).send();

			const download = await this.recordingStorage.getDownload(request.params.id);
			if (download == null || download.userId !== user.id || !fs.existsSync(download.path)) {
				return reply.code(404).send();
			}

			reply.header('Content-Type', 'application/octet-stream');
			reply.header('Content-Length', download.size);
			reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`);
			reply.header('Cache-Control', 'no-store');
			const stream = fs.createReadStream(download.path);
			// GET 본문 전달이 끝까지 성공했을 때만 한 번 내려받은 것으로 보고 지운다. 중단되면 기한까지 다시 받을 수 있다.
			// 파일 읽기 오류의 500 응답도 finish가 나므로, 스트림이 오류 없이 끝났는지 함께 확인한다.
			let streamCompleted = false;
			stream.on('end', () => { streamCompleted = true; });
			stream.on('error', () => {
				streamCompleted = false;
				if (!reply.sent) reply.code(500).send();
			});
			reply.raw.on('finish', () => {
				if (request.method !== 'GET') return;
				if (!streamCompleted || reply.statusCode >= 400) return;
				this.recordingStorage.removeDownload(download.id).catch(() => {});
			});
			return reply.send(stream);
		});
		done();
	}
}
