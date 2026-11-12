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

	// Lua 자체는 실제 Redis E2E에서 검증한다. 이 double은 표식 명령의 입출력 계약만 흉내 낸다.
	const evaluate = async (_script: string, numberOfKeys: number, ...values: string[]) => {
		const keys = values.slice(0, numberOfKeys);
		const args = values.slice(numberOfKeys);
		if (keys[0].startsWith('newChatMessagesExists:')) {
			for (const conversation of sets.get(keys[0]) ?? []) {
				const [kind, id] = conversation.split(':');
				const key = `${kind === 'user' ? args[0] : args[1]}${id}`;
				commands.del(key);
				commands.del(`${key}:first`);
			}
			for (const key of keys) commands.del(key);
			return 1;
		}
		if (args.length === 1) {
			commands.del(keys[0]);
			commands.del(keys[1]);
			return commands.srem(keys[2], args[0]) as number;
		}
		if (args.length === 2) {
			const active = sets.get(keys[2])?.has(args[1]);
			const latest = active ? strings.get(keys[0]) : undefined;
			const first = active ? strings.get(keys[1]) : undefined;
			if (!active || first != null) {
				commands.set(keys[1], first != null && first < args[0] ? first : args[0]);
			}
			commands.set(keys[0], latest != null && latest > args[0] ? latest : args[0]);
			commands.sadd(keys[2], args[1]);
			return 1;
		}
		if ((strings.get(keys[0]) ?? '') !== args[0] || (strings.get(keys[1]) ?? '') !== args[1]) return 0;
		if (args[2] !== '') {
			commands.set(keys[0], args[2]);
			return 1;
		}
		commands.del(keys[0]);
		commands.del(keys[1]);
		commands.srem(keys[2], args[3]);
		return 2;
	};
	const client: Record<string, unknown> = {
		pipeline,
		multi: pipeline,
		options: { keyPrefix: '' },
		scan: async (_cursor: string, _match: string, pattern: string) => ['0', [...strings.keys()].filter(key => key.startsWith(pattern.slice(0, -1)))],
	};
	for (const name of names) client[name] = async (...args: string[]) => run(name, args);
	return { ...client, eval: evaluate } as {
		[K in Command]: (...args: Parameters<(typeof commands)[K]>) => Promise<RedisReply>;
	} & { eval: typeof evaluate };
}
