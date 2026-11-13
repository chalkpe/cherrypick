/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type RedisReply = string | number | string[] | null;

/** Just enough of Redis to keep unread marks: strings and sets, one command at a time or in a pipeline. */
export function memoryRedis({ strings = new Map<string, string>(), sets = new Map<string, Set<string>>() } = {}) {
	const commands = {
		set: (key: string, value: string): RedisReply => {
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
	const run = (name: Command, args: string[]) => (commands[name] as (...args: string[]) => RedisReply)(...args);

	const pipeline = () => {
		const queued: (() => RedisReply)[] = [];
		const self: Record<string, unknown> = { exec: async () => queued.map(command => [null, command()]) };
		for (const name of names) {
			self[name] = (...args: string[]) => {
				queued.push(() => run(name, args));
				return self;
			};
		}
		return self;
	};

	// Lua 자체는 실제 Redis 시험에서 검증한다. 이 double은 스크립트 첫 줄의 이름으로 같은 계약을 흉내 낸다.
	const members = (key: string) => [...(sets.get(key) ?? [])];
	const del = (...keys: string[]) => keys.reduce((count, key) => count + (commands.del(key) as number), 0);
	const extremes = (ids: string[]) => ({ first: ids.reduce<string | undefined>((a, b) => (a == null || b < a ? b : a), undefined), latest: ids.reduce<string | undefined>((a, b) => (a == null || b > a ? b : a), undefined) });
	const scripts: Record<string, (keys: string[], args: string[]) => RedisReply | (RedisReply | RedisReply[])[]> = {
		'mark chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey], [id, conversation, revision]) => {
			const active = sets.get(aggregate)?.has(conversation) ?? false;
			const pending = active ? [] : members(pendingKey);
			if (!active) {
				del(messagesKey);
				for (const pendingId of pending) commands.sadd(messagesKey, pendingId);
			}
			const latest = active ? strings.get(latestKey) : extremes(pending).latest;
			let first = active ? strings.get(firstKey) : undefined;
			if (!active) first = extremes(pending).first;
			if (!active || first != null) {
				if (first == null || id < first) first = id;
				commands.set(firstKey, first);
			}
			commands.set(latestKey, latest == null || id > latest ? id : latest);
			commands.sadd(aggregate, conversation);
			commands.sadd(messagesKey, id);
			commands.sadd(pendingKey, id);
			commands.set(revisionKey, revision);
			return 1;
		},
		'settle chat unread': ([, , aggregate, revisionKey, , pendingKey], [id, revision, conversation]) => {
			if (commands.srem(pendingKey, id) === 0) return 0;
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			commands.set(revisionKey, revision);
			return 1;
		},
		'unmark chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey], [conversation, revision, ...ids]) => {
			let removed = 0;
			for (const id of ids) {
				removed += commands.srem(messagesKey, id) as number;
				commands.srem(pendingKey, id);
			}
			if (removed === 0) return 0;
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			if (!sets.has(messagesKey) && strings.has(firstKey)) {
				del(latestKey, firstKey, revisionKey, messagesKey, pendingKey);
				commands.srem(aggregate, conversation);
				return 2;
			}
			commands.set(revisionKey, revision);
			return 1;
		},
		'read chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey, snapshotKey], [conversation, revision, upTo, captured, ...seenIds]) => {
			if (!sets.get(aggregate)?.has(conversation)) {
				if (captured === '1') del(snapshotKey);
				return [0, []];
			}
			const seen = new Set(seenIds);
			const pending = new Set(members(pendingKey));
			let changed = 0;
			for (const id of members(messagesKey)) {
				if (seen.has(id) || (!pending.has(id) && (upTo === '*' || (upTo !== '' && id <= upTo)) && (captured !== '1' || sets.get(snapshotKey)?.has(id)))) {
					commands.srem(messagesKey, id);
					commands.srem(pendingKey, id);
					changed = 1;
				}
			}
			if (captured === '1') del(snapshotKey);
			const { first, latest } = extremes(members(messagesKey));
			if (first == null || latest == null) {
				del(latestKey, firstKey, revisionKey, messagesKey, pendingKey);
				return [commands.srem(aggregate, conversation) === 1 ? 2 : changed, []];
			}
			if (changed === 0 && strings.has(firstKey)) return [0, members(pendingKey)];
			commands.set(latestKey, latest);
			commands.set(firstKey, first);
			commands.set(revisionKey, revision);
			return [1, members(pendingKey)];
		},
		'read all chat unread': ([aggregate, ...scanned], [userPrefix, roomPrefix, revision]) => {
			const suffixes = [':first', ':revision', ':messages', ':pending'];
			const kept = new Set<string>();
			const left: string[] = [];
			for (const conversation of members(aggregate)) {
				const match = /^(\w+):(.+)$/.exec(conversation);
				const base = match ? `${match[1] === 'user' ? userPrefix : roomPrefix}${match[2]}` : null;
				const pending = base != null ? members(`${base}:pending`) : [];
				if (base == null || pending.length === 0) {
					if (base != null) del(base, ...suffixes.map(suffix => `${base}${suffix}`));
					commands.srem(aggregate, conversation);
					continue;
				}
				del(`${base}:messages`);
				for (const id of pending) commands.sadd(`${base}:messages`, id);
				const { first, latest } = extremes(pending);
				commands.set(base, latest!);
				commands.set(`${base}:first`, first!);
				commands.set(`${base}:revision`, revision);
				kept.add(base);
				left.push(conversation);
			}
			for (const key of scanned) {
				const suffix = suffixes.find(candidate => key.endsWith(candidate));
				if (!kept.has(suffix != null ? key.slice(0, -suffix.length) : key)) del(key);
			}
			return left;
		},
		'clear chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey], [conversation]) => {
			del(latestKey, firstKey, revisionKey, messagesKey, pendingKey);
			return commands.srem(aggregate, conversation);
		},
		'snapshot chat unread': ([latestKey, firstKey, revisionKey, messagesKey, pendingKey]) =>
			[strings.get(latestKey) ?? '', strings.get(firstKey) ?? '', strings.get(revisionKey) ?? '', members(messagesKey), members(pendingKey)],
		'capture chat read': ([messagesKey, pendingKey, snapshotKey]) => {
			const pending = sets.get(pendingKey) ?? new Set<string>();
			const captured = members(messagesKey).filter(id => !pending.has(id));
			del(snapshotKey);
			for (const id of captured) commands.sadd(snapshotKey, id);
			return 1;
		},
		'snapshot chat unread head': ([latestKey, firstKey, messagesKey, aggregate], [conversation]) => {
			if (!sets.get(aggregate)?.has(conversation)) return ['', '', 0];
			const latest = strings.get(latestKey) ?? '';
			return [latest, strings.get(firstKey) ?? '', Number(sets.get(messagesKey)?.has(latest) ?? false)];
		},
		'is chat message unread': ([aggregate, messagesKey], [conversation, id]) =>
			Number(Boolean(sets.get(aggregate)?.has(conversation) && sets.get(messagesKey)?.has(id))),
		'reconcile chat unread': ([latestKey, firstKey, aggregate, revisionKey, messagesKey, pendingKey], [marker, first, revision, remaining, conversation, newRevision]) => {
			if (!sets.get(aggregate)?.has(conversation)) return 0;
			if (sets.has(pendingKey)) return 0;
			if ((strings.get(latestKey) ?? '') !== marker || (strings.get(firstKey) ?? '') !== first || (strings.get(revisionKey) ?? '') !== revision) return 0;
			if (remaining !== '') {
				commands.set(latestKey, remaining);
				commands.set(revisionKey, newRevision);
				return 1;
			}
			del(latestKey, firstKey, revisionKey, messagesKey, pendingKey);
			commands.srem(aggregate, conversation);
			return 2;
		},
	};
	const evaluate = async (script: string, numberOfKeys: number, ...values: string[]) => {
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
	};
	for (const name of names) client[name] = async (...args: string[]) => run(name, args);
	return { ...client, eval: evaluate } as {
		[K in Command]: (...args: Parameters<(typeof commands)[K]>) => Promise<RedisReply>;
	} & { eval: typeof evaluate };
}
