/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { assertChatDiceNotation, ChatDiceError, DICE_TIMEOUT_MS, parseChatDiceResult } from './chat-dice.js';
import type { ChatDiceResult } from './chat-dice.js';

function workerPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	let directory = dirname(modulePath);
	while (!existsSync(resolve(directory, 'package.json')) || !existsSync(resolve(directory, 'src/core/ChatDiceService.ts')) && !existsSync(resolve(directory, 'built/chat-dice-worker.js'))) {
		const parent = dirname(directory);
		if (parent === directory) throw new Error('Cannot find chat dice worker');
		directory = parent;
	}
	const output = relative(directory, modulePath).split(sep)[0] === 'built-test' ? 'built-test' : 'built';
	return resolve(directory, output, 'chat-dice-worker.js');
}

export function runChatDiceWorker(notation: string, path = workerPath(), timeout = DICE_TIMEOUT_MS): Promise<ChatDiceResult> {
	assertChatDiceNotation(notation);
	return new Promise((resolveResult, reject) => {
		const child = fork(path, [], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
		let result: ChatDiceResult | null = null;
		let error: ChatDiceError | null = null;
		const timer = setTimeout(() => {
			error = new ChatDiceError('limit');
			child.kill('SIGKILL');
		}, timeout);
		child.once('message', (message: unknown) => {
			const reply = message as { result?: unknown; error?: unknown } | null;
			result = parseChatDiceResult(reply?.result);
			if (result?.notation !== notation) result = null;
			if (result == null) error = new ChatDiceError(reply?.error === 'limit' ? 'limit' : reply?.error === 'busy' ? 'busy' : 'invalid');
			child.kill('SIGKILL');
		});
		child.once('error', () => {
			error = new ChatDiceError('busy');
		});
		// 자식 프로세스 종료와 IPC 해제 후 close가 도착할 때까지 실행 자리를 유지한다.
		child.once('close', () => {
			clearTimeout(timer);
			if (error != null || result == null) reject(error ?? new ChatDiceError('invalid'));
			else resolveResult(result);
		});
		child.send(notation, err => {
			if (err != null) {
				error = new ChatDiceError('busy');
				child.kill('SIGKILL');
			}
		});
	});
}

@Injectable()
export class ChatDiceService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,
	) {}

	public async roll(userId: string, notation: string): Promise<ChatDiceResult> {
		assertChatDiceNotation(notation);
		const token = randomUUID();
		const userKey = `chat_dice_user:${userId}`;
		if (await this.redisClient.set(userKey, token, 'PX', 10000, 'NX') !== 'OK') throw new ChatDiceError('busy');
		let slot: string | null = null;
		try {
			const count = await this.redisClient.eval("local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end; return n", 1, `chat_dice_rate:${userId}`);
			if (Number(count) > 10) throw new ChatDiceError('busy');
			for (let index = 0; index < 2; index++) {
				const key = `chat_dice_slot:${index}`;
				if (await this.redisClient.set(key, token, 'PX', 10000, 'NX') === 'OK') {
					slot = key;
					break;
				}
			}
			if (slot == null) throw new ChatDiceError('busy');
			return await runChatDiceWorker(notation);
		} finally {
			const release = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0";
			await Promise.all([userKey, ...(slot != null ? [slot] : [])].map(key => this.redisClient.eval(release, 1, key, token)));
		}
	}
}
