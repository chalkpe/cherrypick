/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { aidRegExp, genAid, isSafeAidT, parseAid, parseAidFull } from '@/misc/id/aid.js';
import { aidxRegExp, genAidx, isSafeAidxT, parseAidx, parseAidxFull } from '@/misc/id/aidx.js';
import { genMeid, isSafeMeidT, meidRegExp, parseMeid, parseMeidFull } from '@/misc/id/meid.js';
import { genMeidg, isSafeMeidgT, meidgRegExp, parseMeidg, parseMeidgFull } from '@/misc/id/meidg.js';
import { genObjectId, isSafeObjectIdT, objectIdRegExp, parseObjectId, parseObjectIdFull } from '@/misc/id/object-id.js';
import { bindThis } from '@/decorators.js';
import { parseUlid, parseUlidFull, ulidRegExp } from '@/misc/id/ulid.js';

const AID_EPOCH = 946684800000;
const AID_TIME_LENGTH = 8;
const AID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const idPatterns: Record<string, RegExp> = {
	aid: aidRegExp,
	aidx: aidxRegExp,
	meid: meidRegExp,
	meidg: meidgRegExp,
	objectid: objectIdRegExp,
	ulid: ulidRegExp,
};

@Injectable()
export class IdService {
	private method: string;

	constructor(
		@Inject(DI.config)
		private config: Config,
	) {
		this.method = config.id.toLowerCase();
	}

	@bindThis
	public isSafeT(t: number): boolean {
		switch (this.method) {
			case 'aid': return isSafeAidT(t);
			case 'aidx': return isSafeAidxT(t);
			case 'meid': return isSafeMeidT(t);
			case 'meidg': return isSafeMeidgT(t);
			case 'ulid': return t > 0;
			case 'objectid': return isSafeObjectIdT(t);
			default: throw new Error('unrecognized id generation method');
		}
	}

	/**
	 * 時間を元にIDを生成します(省略時は現在日時)
	 * @param time 日時
	 */
	@bindThis
	public gen(time?: number): string {
		const t = (!time || (time > Date.now())) ? Date.now() : time;

		switch (this.method) {
			case 'aid': return genAid(t);
			case 'aidx': return genAidx(t);
			case 'meid': return genMeid(t);
			case 'meidg': return genMeidg(t);
			case 'ulid': return ulid(t);
			case 'objectid': return genObjectId(t);
			default: throw new Error('unrecognized id generation method');
		}
	}

	@bindThis
	public parse(id: string): { date: Date; } {
		switch (this.method) {
			case 'aid': return parseAid(id);
			case 'aidx': return parseAidx(id);
			case 'objectid': return parseObjectId(id);
			case 'meid': return parseMeid(id);
			case 'meidg': return parseMeidg(id);
			case 'ulid': return parseUlid(id);
			default: throw new Error('unrecognized id generation method');
		}
	}

	public parseCursorTime(id: string): number | undefined {
		if (!idPatterns[this.method]?.test(id)) return undefined;
		const time = this.parse(id).date.getTime();
		return Number.isFinite(time) ? time : undefined;
	}

	/** Prefix before every AID or AIDX with this time in bytewise ID order. */
	public aidTimePrefix(time: number): string | undefined {
		if (this.method !== 'aid' && this.method !== 'aidx') return undefined;
		const elapsed = time - AID_EPOCH;
		if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed >= AID_ALPHABET.length ** AID_TIME_LENGTH) return undefined;
		return elapsed.toString(AID_ALPHABET.length).padStart(AID_TIME_LENGTH, '0');
	}

	/** Returns the same creation time as parse(), in milliseconds, for a PostgreSQL ID column. */
	public timestampSql(column: string): string {
		const decode = (start: number, length: number, alphabet: string) => {
			const digits = Array.from({ length }, (_, i) =>
				`(strpos('${alphabet}', substr(${column}, ${start + i}, 1)) - 1) * ${alphabet.length ** (length - i - 1)}::bigint`);
			return `(${digits.join(' + ')})`;
		};
		const hex = '0123456789abcdef';
		switch (this.method) {
			case 'aid':
			case 'aidx': return `(${decode(1, AID_TIME_LENGTH, AID_ALPHABET)} + ${AID_EPOCH})`;
			case 'objectid': return `(${decode(1, 8, hex)} * 1000)`;
			case 'meid': return `(${decode(1, 12, hex)} - 140737488355328)`;
			case 'meidg': return decode(2, 11, hex);
			case 'ulid': return decode(1, 10, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
			default: throw new Error('unrecognized id generation method');
		}
	}

	// Note: additional is at most 64 bits
	@bindThis
	public parseFull(id: string): { date: number; additional: bigint; } {
		switch (this.method) {
			case 'aid': return parseAidFull(id);
			case 'aidx': return parseAidxFull(id);
			case 'objectid': return parseObjectIdFull(id);
			case 'meid': return parseMeidFull(id);
			case 'meidg': return parseMeidgFull(id);
			case 'ulid': return parseUlidFull(id);
			default: throw new Error('unrecognized id generation method');
		}
	}
}
