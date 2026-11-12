/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fork } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { chatDiceNotation, parseChatDiceResult } from '@/core/chat-dice.js';
import { ChatDiceService, runChatDiceWorker } from '@/core/ChatDiceService.js';

const result = { version: 1, engine: '@dice-roller/rpg-dice-roller', engineVersion: '5.5.1', notation: '1d6', total: 4, output: '1d6: [4] = 4' };

function runDiceChild(notation: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = fork(new URL('../../built/chat-dice-worker.js', import.meta.url), [], {
			execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
		});
		let reply: unknown;
		const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
		child.once('message', message => { reply = message; });
		child.once('error', reject);
		child.once('close', () => {
			clearTimeout(timer);
			if (reply == null) reject(new Error('Dice child closed without a reply'));
			else resolve(reply);
		});
		child.send(notation);
	});
}

describe('chat dice command boundary', () => {
	test.each(['/dice', '/dice ', ' /dice\n'])('uses 1d6 for %j', text => {
		expect(chatDiceNotation(text)).toBe('1d6');
	});
	test.each(['/dicefoo', '/DICE', 'roll /dice', '`/dice`', '```\n/dice\n```', null])('does not run %j', text => {
		expect(chatDiceNotation(text)).toBeNull();
	});
	test('passes native syntax through without interpreting it', () => {
		expect(chatDiceNotation('/dice 2d20kh1 + 1d4')).toBe('2d20kh1 + 1d4');
	});
});

describe('server-wide dice admission (Redis boundary double)', () => {
	function admission() {
		const leases = new Map<string, string>();
		const counts = new Map<string, number>();
		const redis = {
			set: async (key: string, value: string) => {
				if (leases.has(key)) return null;
				leases.set(key, value);
				return 'OK';
			},
			eval: async (_script: string, _keys: number, key: string, token?: string) => {
				if (token != null) {
					if (leases.get(key) === token) leases.delete(key);
					return 1;
				}
				const count = (counts.get(key) ?? 0) + 1;
				counts.set(key, count);
				return count;
			},
		};
		return { leases, counts, service: new ChatDiceService(redis as never) };
	}

	test('allows only two active jobs across service instances, with no waiting queue', async () => {
		const f = admission();
		const first = f.service.roll('one', '1d6');
		const second = f.service.roll('two', '1d6');

		await expect(f.service.roll('three', '1d6')).rejects.toMatchObject({ reason: 'busy' });
		await Promise.all([first, second]);
		expect(f.leases.size).toBe(0);
		await expect(f.service.roll('three', '1d6')).resolves.toHaveProperty('total');
	});
	test('rejects a second outstanding job from one user and releases on engine error', async () => {
		const f = admission();
		const first = f.service.roll('one', 'bad notation');

		await expect(f.service.roll('one', '1d6')).rejects.toMatchObject({ reason: 'busy' });
		await expect(first).rejects.toMatchObject({ reason: 'invalid' });
		expect(f.leases.size).toBe(0);
	});
	test('rejects attempt eleven in a minute without running a child', async () => {
		const f = admission();
		f.counts.set('chat_dice_rate:one', 10);

		await expect(f.service.roll('one', '1d6')).rejects.toMatchObject({ reason: 'busy' });
		expect(f.leases.size).toBe(0);
	});
});

describe('isolated native engine', () => {
	test('rejects depth hidden by bracket descriptions at the service boundary', async () => {
		const notation = '(1d6 [)] + '.repeat(40) + '1d6' + ')'.repeat(40);

		await expect(Promise.resolve().then(() => runChatDiceWorker(notation))).rejects.toMatchObject({ reason: 'limit' });
	});
	test('rejects depth hidden by bracket descriptions in the actual child', async () => {
		const notation = '(1d6 [)] + '.repeat(40) + '1d6' + ')'.repeat(40);

		await expect(runDiceChild(notation)).resolves.toEqual({ error: 'limit' });
	});
	test.each(['[)]', '/*)*/', '# )\n', '// )\n', '[}]'])('rejects depth hidden by %j in the actual child', async description => {
		const notation = `(1d6 ${description} + `.repeat(33) + '1d6' + ')'.repeat(33);

		await expect(runDiceChild(notation)).resolves.toEqual({ error: 'limit' });
	});
	test.each([
		[`1d1 [${'('.repeat(40)}]`, 1],
		[`1d1 /* ${'{'.repeat(40)} */`, 1],
		[`1d1 # ${'('.repeat(40)}`, 1],
		[`1d1 // ${'('.repeat(40)}`, 1],
		['1d1 [/* )] + 1d1', 2],
		['1d1 /* [ ) */ + 1d1', 2],
		['1d1 [# // )] + 1d1', 2],
		['1d1 /* ) */ [)] // )\n + 1d1', 2],
		['1d1 # )\r\n + 1d1', 2],
		['1d1 // )\r + 1d1', 2],
	] as const)('preserves native descriptions in %j', async (notation, total) => {
		const rolled = await runChatDiceWorker(notation);

		expect(rolled.notation).toBe(notation);
		expect(rolled.output).toContain(`${notation}: `);
		expect(rolled.total).toBe(total);
	});
	test('accepts a 512-byte notation including its description', async () => {
		const notation = `1d1 [${'x'.repeat(506)}]`;

		await expect(runChatDiceWorker(notation)).resolves.toHaveProperty('notation', notation);
	});
	test('counts descriptions toward the 512-byte limit in the actual child', async () => {
		const notation = `1d1 [${'x'.repeat(507)}]`;

		await expect(runDiceChild(notation)).resolves.toEqual({ error: 'limit' });
	});
	test.each([
		'('.repeat(31) + '1d1' + ')'.repeat(31),
		'('.repeat(32) + '1d1' + ')'.repeat(32),
		'('.repeat(32) + '1d1 [)]' + ')'.repeat(32),
		'abs('.repeat(32) + '1d1' + ')'.repeat(32),
		'pow(1,'.repeat(32) + '1d1' + ')'.repeat(32),
		'('.repeat(31) + '{1d1,1d1}kh1' + ')'.repeat(31),
		'('.repeat(31) + '(1+1)d1' + ')'.repeat(31),
		'('.repeat(31) + '1d(1+1)' + ')'.repeat(31),
	])('accepts native syntax up to depth 32 in %j', async notation => {
		await expect(runChatDiceWorker(notation)).resolves.toHaveProperty('notation', notation);
	});
	test.each([
		'('.repeat(33) + '1d1' + ')'.repeat(33),
		'abs('.repeat(33) + '1d1' + ')'.repeat(33),
		'pow(1,'.repeat(33) + '1d1' + ')'.repeat(33),
		'('.repeat(32) + '{1d1,1d1}kh1' + ')'.repeat(32),
		'('.repeat(32) + '(1+1)d1' + ')'.repeat(32),
		'('.repeat(32) + '1d(1+1)' + ')'.repeat(32),
	])('rejects native syntax above depth 32 in the actual child: %j', async notation => {
		await expect(runDiceChild(notation)).resolves.toEqual({ error: 'limit' });
	});
	test.each(['1d6', '1d20+1', '2d20kh1', '2d20kl1', '{2d6+1,1d8}kh1', '4d6dl1'])('preserves engine output for %s', async notation => {
		const rolled = await runChatDiceWorker(notation);

		expect(rolled).toMatchObject({ version: 1, engineVersion: '5.5.1', notation });
		expect(Number.isFinite(rolled.total)).toBe(true);
		expect(rolled.output).toContain(`${notation}: `);
		expect(rolled.output).toContain(` = ${rolled.total}`);
	});
	test.each(['not a roll', '1d6/0', '999d6+999d6', '2d6!>0', '('.repeat(33) + '1d6' + ')'.repeat(33), '1'.repeat(513)])('rejects all of invalid or excessive %s', async notation => {
		await expect(Promise.resolve().then(() => runChatDiceWorker(notation))).rejects.toThrow();
	});
	test('reaps a timed out child and a subsequent roll succeeds', async () => {
		await expect(runChatDiceWorker('1d6', undefined, 1)).rejects.toMatchObject({ reason: 'limit' });
		await expect(runChatDiceWorker('1d6')).resolves.toHaveProperty('notation', '1d6');
	});
	test('rejects a missing worker without hanging', async () => {
		await expect(runChatDiceWorker('1d6', '/does-not-exist-dice-worker.js')).rejects.toThrow();
	});
	test('accepts a native maximum-sized dice pool without extra evaluation', async () => {
		const rolled = await runChatDiceWorker('999d6');

		expect(rolled.notation).toBe('999d6');
		expect(rolled.total).toBeGreaterThanOrEqual(999);
		expect(rolled.total).toBeLessThanOrEqual(5994);
	});
});

describe('untrusted dice result', () => {
	test('copies only a valid flat versioned result', () => {
		expect(parseChatDiceResult(result)).toEqual(result);
		expect(parseChatDiceResult(result)).not.toBe(result);
	});
	test.each([
		null, [], {}, { ...result, version: 2 }, { ...result, total: Infinity }, { ...result, total: NaN },
		{ ...result, total: Number.MAX_SAFE_INTEGER + 1 }, { ...result, output: { html: '<script>' } },
		{ ...result, notation: 'x'.repeat(513) }, { ...result, output: 'x'.repeat(12289) },
		{ ...result, engine: 'other' }, { ...result, engineVersion: 'latest' }, { ...result, extra: [] },
	])('ignores malformed payload %j', value => {
		expect(parseChatDiceResult(value)).toBeNull();
	});
	test('preserves text without parsing HTML or MFM', () => {
		expect(parseChatDiceResult({ ...result, output: '<b>$(spin 4)</b>' })?.output).toBe('<b>$(spin 4)</b>');
	});
	test.each(['notation', 'output'] as const)('ignores %s strings PostgreSQL jsonb cannot store', field => {
		for (const value of ['bad\0text', '\ud800', '\udfff']) {
			expect(parseChatDiceResult({ ...result, [field]: value })).toBeNull();
		}
	});
	test('preserves valid Unicode surrogate pairs', () => {
		const value = { ...result, notation: '1d6 # 🦊', output: '1d6: [4] = 4 # 🦊' };

		expect(parseChatDiceResult(value)).toEqual(value);
	});
});
