/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type RedisReply = string | number | string[] | null;

/** Just enough of Redis to keep unread marks: strings and sets, one command at a time or in a pipeline. */
export function memoryRedis({ strings = new Map<string, string>(), sets = new Map<string, Set<string>>() } = {}) {
	// 스크립트 안의 호출까지 세어, 한 작업이 처리하는 양을 시험에서 확인한다.
	const stats: Record<string, number> = {};
	const commands = {
		set: (key: string, value: string, ...options: string[]): RedisReply => {
			if (options.includes('NX') && (strings.has(key) || sets.has(key))) return null;
			strings.set(key, value);
			return 'OK';
		},
		get: (key: string): RedisReply => strings.get(key) ?? null,
		del: (key: string): RedisReply => Number(strings.delete(key)) + Number(sets.delete(key)),
		unlink: (...keys: string[]): RedisReply => keys.reduce((count, key) => count + Number(strings.delete(key)) + Number(sets.delete(key)), 0),
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
	};
	type Command = keyof typeof commands;
	const names = Object.keys(commands) as Command[];
	const run = (name: Command, args: string[]) => {
		stats[name] = (stats[name] ?? 0) + 1;
		return (commands[name] as (...args: string[]) => RedisReply)(...args);
	};
	const counted = Object.fromEntries(names.map(name => [name, (...args: string[]) => run(name, args)])) as typeof commands;

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
		'mark chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey], [id, conversation, revision]) => {
			const active = sets.get(aggregate)?.has(conversation) ?? false;
			const pending = active ? [] : members(pendingKey);
			if (!active) {
				del(messagesKey, trimmedKey);
				for (const pendingId of pending) counted.sadd(messagesKey, pendingId);
			}
			const latest = active ? strings.get(latestKey) : extremes(pending).latest;
			let first = active ? strings.get(firstKey) : undefined;
			if (!active) first = extremes(pending).first;
			if (!active || first != null) {
				if (first == null || id < first) first = id;
				counted.set(firstKey, first);
			}
			counted.set(latestKey, latest == null || id > latest ? id : latest);
			counted.sadd(aggregate, conversation);
			counted.sadd(messagesKey, id);
			counted.sadd(pendingKey, id);
			counted.set(revisionKey, revision);
			let count = sets.get(messagesKey)?.size ?? 0;
			if (first != null && count > 1256) {
				const pendingIds = new Set(members(pendingKey));
				let trimmed = strings.get(trimmedKey);
				for (const candidate of members(messagesKey).sort()) {
					if (count <= 1000) break;
					if (!pendingIds.has(candidate) && candidate !== first) {
						counted.srem(messagesKey, candidate);
						count--;
						if (trimmed == null || candidate > trimmed) trimmed = candidate;
					}
				}
				if (trimmed != null) counted.set(trimmedKey, trimmed);
			}
			return 1;
		},
		'settle chat unread': ([, , aggregate, revisionKey, , pendingKey], [id, revision, conversation]) => {
			if (counted.srem(pendingKey, id) === 0) return 0;
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			counted.set(revisionKey, revision);
			return 1;
		},
		'unmark chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey], [conversation, revision, ...ids]) => {
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
					del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey);
					counted.srem(aggregate, conversation);
					return 2;
				}
			}
			counted.set(revisionKey, revision);
			return 1;
		},
		'read chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey, snapshotKey], [conversation, revision, upTo, captured, ...seenIds]) => {
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
				del(trimmedKey);
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
					counted.set(firstKey, boundary);
					counted.set(revisionKey, revision);
					return [1, pendingLeft];
				}
				del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey);
				return [counted.srem(aggregate, conversation) === 1 ? 2 : changed, []];
			}
			if (trimmed != null) {
				let boundary = oldFirst ?? '';
				if (upTo !== '*' && upTo !== '' && upTo > boundary) boundary = upTo;
				if (changed === 0 && boundary === (oldFirst ?? '') && latest === (oldLatest ?? '')) return [0, pendingLeft];
				counted.set(latestKey, latest);
				counted.set(firstKey, boundary);
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
			const suffixes = [':first', ':revision', ':messages', ':pending', ':trimmed'];
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
				del(`${base}:messages`, `${base}:trimmed`);
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
		'clear chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey], [conversation]) => {
			del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey);
			return counted.srem(aggregate, conversation);
		},
		'snapshot chat unread': ([latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey]) =>
			[strings.get(latestKey) ?? '', strings.get(firstKey) ?? '', strings.get(revisionKey) ?? '', members(messagesKey), members(pendingKey), strings.get(trimmedKey) ?? ''],
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
		'is chat message unread': ([aggregate, messagesKey, firstKey, trimmedKey], [conversation, id]) => {
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			if (sets.get(messagesKey)?.has(id)) return 1;
			const first = strings.get(firstKey);
			if (first == null) return 0;
			const trimmed = strings.get(trimmedKey);
			return trimmed != null && id > first && id <= trimmed ? 1 : 0;
		},
		'reconcile chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, trimmedKey], [marker, first, revision, remaining, conversation, newRevision]) => {
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
			del(latestKey, firstKey, revisionKey, messagesKey, pendingKey, trimmedKey);
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
			return ['0', [...new Set([...strings.keys(), ...sets.keys()])].filter(key => parts.every((part, index) => index === 0 ? key.startsWith(part) : index === parts.length - 1 ? key.endsWith(part) : key.includes(part)))];
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
