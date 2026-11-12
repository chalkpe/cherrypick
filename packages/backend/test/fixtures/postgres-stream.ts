/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Duplex } from 'node:stream';

function message(type: string, payload: Buffer) {
	const length = Buffer.alloc(4);
	length.writeInt32BE(payload.length + 4);
	return Buffer.concat([Buffer.from(type), length, payload]);
}

// 실제 pg.Client의 전송 경계만 대체한다. 소켓과 DB 없이 공개 stream 옵션으로 접속한다.
// SQL 실행을 흉내 내지 않고 시작/단순 질의/종료의 프로토콜 응답만 돌려준다.
export class PostgresStream extends Duplex {
	connect() {
		queueMicrotask(() => this.emit('connect'));
		return this;
	}

	setNoDelay() {}

	_read() {}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		callback();
		if (chunk[0] === 0) {
			setImmediate(() => this.push(Buffer.concat([
				message('R', Buffer.alloc(4)),
				message('Z', Buffer.from('I')),
			])));
		} else if (chunk[0] === 81) {
			setImmediate(() => this.push(Buffer.concat([
				message('C', Buffer.from('SELECT 0\0')),
				message('Z', Buffer.from('I')),
			])));
		} else if (chunk[0] === 88) {
			this.push(null);
		} else {
			this.destroy(new Error('Unexpected PostgreSQL wire message.'));
		}
	}
}
