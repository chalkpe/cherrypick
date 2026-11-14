/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type RedisReply = string | number | string[] | null;

/** Just enough of Redis to keep unread marks: strings, sets and lists, one command at a time or in a pipeline. */
export function memoryRedis({ strings = new Map<string, string>(), sets = new Map<string, Set<string>>(), lists = new Map<string, string[]>() } = {}) {
	// 스크립트 안의 호출까지 세어, 한 작업이 처리하는 양을 시험에서 확인한다.
	const stats: Record<string, number> = {};
	const commands = {
		set: (key: string, value: string, ...options: string[]): RedisReply => {
			if (options.includes('NX') && (strings.has(key) || sets.has(key))) return null;
			strings.set(key, value);
			return 'OK';
		},
		get: (key: string): RedisReply => strings.get(key) ?? null,
		del: (key: string): RedisReply => Number(strings.delete(key)) + Number(sets.delete(key)) + Number(lists.delete(key)),
		unlink: (...keys: string[]): RedisReply => keys.reduce((count, key) => count + Number(strings.delete(key)) + Number(sets.delete(key)) + Number(lists.delete(key)), 0),
		sadd: (key: string, member: string): RedisReply => {
			const set = sets.get(key) ?? new Set<string>();
			const added = !set.has(member);
			sets.set(key, set.add(member));
			return Number(added);
		},
		srem: (key: string, member: string): RedisReply => {
			const removed = sets.get(key)?.delete(member) ?? false;
			if (sets.get(key)?.size === 0) sets.delete(key);
			return Number(removed);
		},
		scard: (key: string): RedisReply => sets.get(key)?.size ?? 0,
		sismember: (key: string, member: string): RedisReply => Number(sets.get(key)?.has(member) ?? false),
		smembers: (key: string): RedisReply => [...(sets.get(key) ?? [])],
		rpush: (key: string, ...values: string[]): RedisReply => {
			const list = lists.get(key) ?? [];
			lists.set(key, list);
			list.push(...values);
			return list.length;
		},
		lindex: (key: string, index: number): RedisReply => {
			const list = lists.get(key);
			if (list == null) return null;
			return list[index < 0 ? list.length + index : index] ?? null;
		},
		lset: (key: string, index: number, value: string): RedisReply => {
			const list = lists.get(key);
			if (list == null) throw new Error('no such key');
			list[index < 0 ? list.length + index : index] = value;
			return 'OK';
		},
		lrange: (key: string, start: number, stop: number): RedisReply => {
			const list = lists.get(key) ?? [];
			const from = start < 0 ? Math.max(list.length + start, 0) : start;
			const to = stop < 0 ? list.length + stop : stop;
			return list.slice(from, to + 1);
		},
		incr: (key: string): RedisReply => {
			const value = Number(strings.get(key) ?? '0') + 1;
			strings.set(key, String(value));
			return value;
		},
	};
	type Command = keyof typeof commands;
	const names = Object.keys(commands) as Command[];
	const run = (name: Command, args: string[]) => {
		stats[name] = (stats[name] ?? 0) + 1;
		return (commands[name] as (...args: string[]) => RedisReply)(...args);
	};
	const counted = Object.fromEntries(names.map(name => [name, (...args: string[]) => run(name, args)])) as unknown as typeof commands;

	const pipeline = () => {
		const queued: (() => RedisReply | (RedisReply | RedisReply[])[] | Promise<RedisReply | (RedisReply | RedisReply[])[]>)[] = [];
		const self: Record<string, unknown> = { exec: async () => {
			const results: [null, RedisReply | (RedisReply | RedisReply[])[]][] = [];
			for (const command of queued) results.push([null, await command()]);
			return results;
		} };
		for (const name of names) {
			self[name] = (...args: string[]) => {
				queued.push(() => run(name, args));
				return self;
			};
		}
		self.eval = (script: string, numberOfKeys: number, ...values: string[]) => {
			queued.push(() => evaluate(script, numberOfKeys, ...values));
			return self;
		};
		return self;
	};

	// Lua 자체는 실제 Redis 시험에서 검증한다. 이 double은 스크립트 첫 줄의 이름으로 같은 계약을 흉내 낸다.
	const members = (key: string) => [...(sets.get(key) ?? [])];
	const del = (...keys: string[]) => keys.reduce((count, key) => count + (counted.del(key) as number), 0);
	const extremes = (ids: string[]) => ({ first: ids.reduce<string | undefined>((a, b) => (a == null || b < a ? b : a), undefined), latest: ids.reduce<string | undefined>((a, b) => (a == null || b > a ? b : a), undefined) });
	const scripts: Record<string, (keys: string[], args: string[]) => RedisReply | (RedisReply | RedisReply[])[]> = {
		'mark chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey], [id, conversation, revision]) => {
			const active = sets.get(aggregate)?.has(conversation) ?? false;
			const pending = active ? [] : members(pendingKey);
			if (!active) {
				del(messagesKey, trimmedKey, excludedKey, readboundKey);
				for (const pendingId of pending) counted.sadd(messagesKey, pendingId);
			}
			const latest = active ? strings.get(latestKey) : extremes(pending).latest;
			let first = active ? strings.get(firstKey) : undefined;
			const readbound = active ? strings.get(readboundKey) : undefined;
			if (!active) first = extremes(pending).first;
			if (!active || first != null) {
				if (first == null || id < first) first = id;
				if (readbound != null && first < readbound) first = readbound;
				counted.set(firstKey, first);
			}
			counted.set(latestKey, latest == null || id > latest ? id : latest);
			counted.sadd(aggregate, conversation);
			counted.sadd(messagesKey, id);
			counted.sadd(pendingKey, id);
			counted.set(revisionKey, revision);
			let count = sets.get(messagesKey)?.size ?? 0;
			if (count > 1256) {
				const pendingIds = new Set(members(pendingKey));
				let trimmed = strings.get(trimmedKey);
				for (const candidate of members(messagesKey).sort()) {
					if (count <= 1000) break;
					if (!pendingIds.has(candidate) && candidate !== first && (readbound == null || candidate > readbound)) {
						counted.srem(messagesKey, candidate);
						count--;
						if (trimmed == null || candidate > trimmed) trimmed = candidate;
					}
				}
				if (trimmed != null) counted.set(trimmedKey, trimmed);
				if (readbound != null && count > 1256) {
					del(firstKey, readboundKey);
					if (trimmed == null || readbound > trimmed) counted.set(trimmedKey, readbound);
				}
			}
			return 1;
		},
		'settle chat unread': ([, , aggregate, revisionKey, , pendingKey], [id, revision, conversation]) => {
			if (counted.srem(pendingKey, id) === 0) return 0;
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			counted.set(revisionKey, revision);
			return 1;
		},
		'unmark chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey], [conversation, revision, ...ids]) => {
			let removed = 0;
			for (const id of ids) {
				removed += counted.srem(messagesKey, id) as number;
				counted.srem(pendingKey, id);
			}
			if (removed === 0) return 0;
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			if (!sets.has(messagesKey)) {
				const trimmed = strings.get(trimmedKey);
				if (trimmed != null) {
					counted.set(latestKey, trimmed);
					counted.set(revisionKey, revision);
					return 1;
				}
				if (strings.has(firstKey)) {
					del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey);
					counted.srem(aggregate, conversation);
					return 2;
				}
			}
			counted.set(revisionKey, revision);
			return 1;
		},
		'read chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey, snapshotKey], [conversation, revision, upTo, captured, ...seenIds]) => {
			if (!sets.get(aggregate)?.has(conversation)) {
				if (captured === '1') del(snapshotKey);
				return [0, []];
			}
			const seen = new Set(seenIds);
			const pending = new Set(members(pendingKey));
			let changed = 0;
			for (const id of members(messagesKey)) {
				if (seen.has(id) || (!pending.has(id) && (upTo === '*' || (upTo !== '' && id <= upTo)) && (captured !== '1' || sets.get(snapshotKey)?.has(id)))) {
					counted.srem(messagesKey, id);
					counted.srem(pendingKey, id);
					changed = 1;
				}
			}
			if (captured === '1') del(snapshotKey);
			let trimmed = strings.get(trimmedKey);
			if (trimmed != null && (upTo === '*' || (upTo !== '' && trimmed <= upTo))) {
				del(trimmedKey, readboundKey);
				trimmed = undefined;
				changed = 1;
			}
			const oldFirst = strings.get(firstKey);
			const oldLatest = strings.get(latestKey);
			const { first, latest } = extremes(members(messagesKey));
			const pendingLeft = members(pendingKey);
			if (first == null || latest == null) {
				if (trimmed != null) {
					let boundary = oldFirst ?? '';
					if (upTo !== '*' && upTo !== '' && upTo > boundary) boundary = upTo;
					if (changed === 0 && boundary === (oldFirst ?? '') && trimmed === (oldLatest ?? '')) return [0, pendingLeft];
					counted.set(latestKey, trimmed);
					if (boundary !== '') {
						counted.set(firstKey, boundary);
						counted.set(readboundKey, boundary);
					}
					counted.set(revisionKey, revision);
					return [1, pendingLeft];
				}
				del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey);
				return [counted.srem(aggregate, conversation) === 1 ? 2 : changed, []];
			}
			if (trimmed != null) {
				let boundary = oldFirst ?? '';
				if (upTo !== '*' && upTo !== '' && upTo > boundary) boundary = upTo;
				if (changed === 0 && boundary === (oldFirst ?? '') && latest === (oldLatest ?? '')) return [0, pendingLeft];
				counted.set(latestKey, latest);
				if (boundary !== '') {
					counted.set(firstKey, boundary);
					counted.set(readboundKey, boundary);
				}
				counted.set(revisionKey, revision);
				return [1, pendingLeft];
			}
			if (changed === 0 && oldFirst != null) return [0, pendingLeft];
			counted.set(latestKey, latest);
			counted.set(firstKey, first);
			counted.set(revisionKey, revision);
			return [1, pendingLeft];
		},
		'read all chat unread': ([aggregate, ...scanned], [userPrefix, roomPrefix, revision]) => {
			const suffixes = [':first', ':revision', ':messages', ':pending', ':trimmed', ':excluded', ':readbound'];
			const kept = new Set<string>();
			const left: string[] = [];
			for (const conversation of members(aggregate)) {
				const match = /^(\w+):(.+)$/.exec(conversation);
				const base = match ? `${match[1] === 'user' ? userPrefix : roomPrefix}${match[2]}` : null;
				const pending = base != null ? members(`${base}:pending`) : [];
				if (base == null || pending.length === 0) {
					if (base != null) del(base, ...suffixes.map(suffix => `${base}${suffix}`));
					counted.srem(aggregate, conversation);
					continue;
				}
				del(`${base}:messages`, `${base}:trimmed`, `${base}:excluded`, `${base}:readbound`);
				for (const id of pending) counted.sadd(`${base}:messages`, id);
				const { first, latest } = extremes(pending);
				counted.set(base, latest!);
				counted.set(`${base}:first`, first!);
				counted.set(`${base}:revision`, revision);
				kept.add(base);
				left.push(conversation);
			}
			for (const key of scanned) {
				const suffix = suffixes.find(candidate => key.endsWith(candidate));
				if (!kept.has(suffix != null ? key.slice(0, -suffix.length) : key)) del(key);
			}
			return left;
		},
		'clear chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey], [conversation]) => {
			del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey);
			return counted.srem(aggregate, conversation);
		},
		'snapshot chat unread': ([latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey, readboundKey]) =>
			[strings.get(latestKey) ?? '', strings.get(firstKey) ?? '', strings.get(revisionKey) ?? '', members(messagesKey), members(pendingKey), strings.get(trimmedKey) ?? '', strings.get(readboundKey) ?? ''],
		'capture chat read': ([messagesKey, pendingKey, snapshotKey]) => {
			const pending = sets.get(pendingKey) ?? new Set<string>();
			const captured = members(messagesKey).filter(id => !pending.has(id));
			del(snapshotKey);
			for (const id of captured) counted.sadd(snapshotKey, id);
			return 1;
		},
		'snapshot chat unread head': ([latestKey, firstKey, messagesKey, aggregate], [conversation]) => {
			if (!sets.get(aggregate)?.has(conversation)) return ['', '', 0];
			const latest = strings.get(latestKey) ?? '';
			return [latest, strings.get(firstKey) ?? '', Number(sets.get(messagesKey)?.has(latest) ?? false)];
		},
		'is chat message unread': ([aggregate, messagesKey, firstKey, trimmedKey, readboundKey, excludedKey], [conversation, id]) => {
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			if (sets.get(messagesKey)?.has(id)) return 1;
			const first = strings.get(firstKey);
			if (first == null) return 0;
			const trimmed = strings.get(trimmedKey);
			if (trimmed == null) return 0;
			const lower = strings.get(readboundKey) ?? first;
			if (id <= lower || id > trimmed) return 0;
			// Lua가 순회하는 구간 수를 시험에서 고정한다. 실제 Lua는 LRANGE 0 -1 전량을 순회한다.
			const intervals = lists.get(excludedKey) ?? [];
			stats.excludedScanned = (stats.excludedScanned ?? 0) + intervals.length;
			stats.excludedScannedMax = Math.max(stats.excludedScannedMax ?? 0, intervals.length);
			for (const interval of intervals) {
				const separator = interval.indexOf('|');
				if (separator === -1) continue;
				const start = interval.slice(0, separator);
				const end = interval.slice(separator + 1);
				if (id > start && (end === '' || id <= end)) return 0;
			}
			return 1;
		},
		'record room mute interval': ([excludedKey, firstKey, readboundKey], [mute, latest]) => {
			const lower = strings.get(readboundKey) ?? strings.get(firstKey);
			const parsed: { start: string; stop: string }[] = [];
			let open = 0;
			for (const item of lists.get(excludedKey) ?? []) {
				const separator = item.indexOf('|');
				if (separator === -1) continue;
				const stop = item.slice(separator + 1);
				if (stop === '') open++;
				parsed.push({ start: item.slice(0, separator), stop });
			}
			let intervals = parsed;
			if (mute === '1') {
				// 같은 뮤트 요청이 다시 와도 구간을 늘리지 않는다.
				if (open === 0) intervals = [...parsed, { start: latest, stop: '' }];
			} else {
				// 해제는 열린 구간을 모두 닫는다. 그사이 새 쪽지가 없으면 빈 구간은 남기지 않는다.
				intervals = parsed.flatMap(interval => interval.stop === ''
					? (latest > interval.start ? [{ start: interval.start, stop: latest }] : [])
					: [interval]);
			}
			// 읽음 경계 아래는 창이 개별 판정하므로 구간에서 뺀다. 아래에서 시작한 구간은 하한으로 올린다.
			const kept = intervals
				.filter(interval => lower == null || interval.stop === '' || interval.stop > lower)
				.map(interval => ({ start: lower != null && interval.start < lower ? lower : interval.start, stop: interval.stop }))
				.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
			// 겹치거나 이어지는 구간은 합친다. 열린 구간은 뒤의 모든 구간을 흡수해 항상 마지막에 하나만 남는다.
			const merged: { start: string; stop: string }[] = [];
			for (const interval of kept) {
				const last = merged[merged.length - 1];
				if (last != null && (last.stop === '' || interval.start <= last.stop)) {
					if (interval.stop === '') last.stop = '';
					else if (last.stop !== '' && interval.stop > last.stop) last.stop = interval.stop;
				} else {
					merged.push({ ...interval });
				}
			}
			// 상한을 넘으면 보수적 덮개 하나로 모은다. 실제 Lua와 같은 상한(64)이다.
			const result = merged.length > 64 ? [{ start: merged[0].start, stop: merged[merged.length - 1].stop }] : merged;
			del(excludedKey);
			if (result.length > 0) counted.rpush(excludedKey, ...result.map(interval => `${interval.start}|${interval.stop}`));
			return result.length;
		},
		'reconcile chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey], [marker, first, revision, remaining, conversation, newRevision]) => {
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			if (sets.has(pendingKey)) return 0;
			if ((strings.get(latestKey) ?? '') !== marker || (strings.get(firstKey) ?? '') !== first || (strings.get(revisionKey) ?? '') !== revision) return 0;
			if (remaining !== '') {
				counted.set(latestKey, remaining);
				const trimmed = strings.get(trimmedKey);
				if (trimmed != null && remaining <= trimmed) counted.set(trimmedKey, remaining);
				counted.set(revisionKey, newRevision);
				return 1;
			}
			del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey, excludedKey, readboundKey);
			counted.srem(aggregate, conversation);
			return 2;
		},
		'clean legacy chat unread': ([aggregate, pendingKey, baseKey, deferred, lock], [conversation, key, token]) => {
			if (strings.get(lock) !== token) return -1;
			if (sets.get(aggregate)?.has(conversation)) {
				counted.srem(deferred, key);
				return 0;
			}
			if ((sets.get(pendingKey)?.size ?? 0) > 0) {
				counted.sadd(deferred, key);
				return 2;
			}
			counted.unlink(baseKey);
			counted.srem(deferred, key);
			return 1;
		},
		'save legacy cleanup cursor': ([lock, cursorKey], [token, cursor]) => {
			if (strings.get(lock) !== token) return 0;
			counted.set(cursorKey, cursor);
			return 1;
		},
		'release legacy cleanup lock': ([lock], [token]) => {
			if (strings.get(lock) === token) return counted.del(lock);
			return 0;
		},
	};
	const evaluate = async (script: string, numberOfKeys: number, ...values: string[]) => {
		stats.eval = (stats.eval ?? 0) + 1;
		const name = /^-- (.+)$/m.exec(script)?.[1];
		const run = name != null ? scripts[name] : undefined;
		if (run == null) throw new Error(`script not known to this test double: ${name}`);
		return run(values.slice(0, numberOfKeys), values.slice(numberOfKeys));
	};
	const client: Record<string, unknown> = {
		pipeline,
		multi: pipeline,
		options: { keyPrefix: '' },
		scan: async (_cursor: string, _match: string, pattern: string) => {
			const parts = pattern.split('*');
			return ['0', [...new Set([...strings.keys(), ...sets.keys(), ...lists.keys()])].filter(key => parts.every((part, index) => index === 0 ? key.startsWith(part) : index === parts.length - 1 ? key.endsWith(part) : key.includes(part)))];
		},
		sscan: async (key: string, _cursor: string) => ['0', [...(sets.get(key) ?? [])]],
	};
	for (const name of names) client[name] = async (...args: string[]) => run(name, args);
	return { ...client, eval: evaluate, stats } as {
		[K in Command]: (...args: Parameters<(typeof commands)[K]>) => Promise<RedisReply>;
	} & {
		eval: typeof evaluate;
		stats: Record<string, number>;
		pipeline: typeof pipeline;
		multi: typeof pipeline;
		options: { keyPrefix: string };
		scan: (cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number) => Promise<[string, string[]]>;
		sscan: (key: string, cursor: string) => Promise<[string, string[]]>;
	};
}
