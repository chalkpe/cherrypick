/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type RedisReply = string | number | string[] | null;

/** Just enough of Redis to keep per-conversation unread marks: strings and sets, one command at a time or in a pipeline. */
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
		smembers: (key: string): RedisReply => [...(sets.get(key) ?? [])],
		incr: (key: string): RedisReply => {
			const value = Number(strings.get(key) ?? '0') + 1;
			strings.set(key, String(value));
			return value;
		},
	};
	type Command = keyof typeof commands;
	const names = Object.keys(commands) as Command[];
	const run = (name: Command, args: string[]) => (commands[name] as (...args: string[]) => RedisReply)(...args);

	const pipeline = () => {
		const queued: (() => RedisReply)[] = [];
		const self: Record<string, unknown> = { exec: async () => queued.map(command => [null, command()] as [null, RedisReply]) };
		for (const name of names) {
			self[name] = (...args: string[]) => {
				queued.push(() => run(name, args));
				return self;
			};
		}
		return self;
	};

	const client: Record<string, unknown> = { pipeline, multi: pipeline };
	for (const name of names) client[name] = async (...args: string[]) => run(name, args);
	return client as {
		[K in Command]: (...args: Parameters<(typeof commands)[K]>) => Promise<RedisReply>;
	} & {
		pipeline: typeof pipeline;
		multi: typeof pipeline;
	};
}
