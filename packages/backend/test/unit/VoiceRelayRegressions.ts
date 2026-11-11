/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { VoiceRelayConsumerService, type RelayCall } from '@/core/VoiceRelayConsumerService.js';
import { VoiceRelayError } from '@/core/VoiceRelayClient.js';
import { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import type { Config } from '@/config.js';
import { loadConfig } from '@/config.js';

function backendPid(client: pg.PoolClient): number {
	const pid: unknown = Reflect.get(client, 'processID');
	if (typeof pid !== 'number') throw new Error('PostgreSQL client has no backend process ID');
	return pid;
}

const provider = (id: string) => ({ id, origin: `https://${id}.test`, enabled: true, validated: true });
const call = (roomId: string, id: string): RelayCall => ({ roomId, generation: roomId, provider: provider(id), remoteId: roomId, state: 'active', slots: 1 });

function fixture(calls: RelayCall[], request: (...args: any[]) => Promise<any>) {
	const values = new Map<string, any>([['providers', calls.map(c => c.provider)]]);
	for (const c of calls) values.set(`allocation:${c.roomId}`, structuredClone(c));
	const storage = {
		read: async (key: string) => structuredClone(values.get(key) ?? null),
		write: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
		query: async () => ({ rows: [...values.entries()].filter(([key, value]) => key.startsWith('allocation:') && value.state !== 'ended').map(([, value]) => ({ value: structuredClone(value) })) }),
		lock: async (_key: string, fn: () => Promise<any>) => fn(),
	};
	return { consumer: new VoiceRelayConsumerService({} as Config, storage as any, { request } as any), values };
}

describe('voice relay regressions', () => {
	test('a slow provider does not prevent another provider renewing', async () => {
		let unblock!: () => void;
		const blocked = new Promise<void>(resolve => { unblock = resolve; });
		const renewed: string[] = [];
		const { consumer } = fixture([call('slow-room', 'slow'), call('healthy-room', 'healthy')], async (p, _method, path) => {
			if (path.endsWith('/lease')) { if (p.id === 'slow') await blocked; renewed.push(p.id); return { id: p.id === 'slow' ? 'slow-room' : 'healthy-room', generation: p.id === 'slow' ? 'slow-room' : 'healthy-room', state: 'active' }; }
			return { events: [], cursor: '0', gap: false };
		});
		try { await consumer.poll(); await vi.waitFor(() => expect(renewed).toContain('healthy')); expect(renewed).not.toContain('slow'); } finally { unblock(); }
	});
	test('failed event feed marks every current room of that provider unavailable', async () => {
		const calls = [call('one', 'broken'), call('two', 'broken')];
		calls.forEach(c => { c.renewedAt = Date.now(); });
		const healthy = call('three', 'healthy');
		let failing = true;
		const { consumer, values } = fixture([...calls, healthy], async (_p, _method, path) => {
			if (failing) throw new VoiceRelayError('RATE_LIMITED', 429);
			if (path.endsWith('/events')) return { events: [], cursor: '1', gap: false };
			const room = path.includes('/one/') ? 'one' : 'two';
			return { allocationId: room, generation: room, state: 'active', participants: [], revision: '1' };
		});
		const changed: string[] = []; consumer.changes.on('change', room => changed.push(room));
		await (consumer as any).pollProvider(calls);
		expect(values.get('allocation:one').unavailable).toBe(true);
		expect(values.get('allocation:two').unavailable).toBe(true);
		expect(values.get('allocation:three').unavailable).toBeUndefined();
		expect(changed.sort()).toEqual(['one', 'two']);
		failing = false; await (consumer as any).pollProvider(calls);
		expect(values.get('allocation:one').unavailable).toBe(false);
		expect(values.get('allocation:two').unavailable).toBe(false);
	});
	test('ambiguous allocation timeout retries the same generation and provider', async () => {
		const pending = { ...call('pending', 'relay'), state: 'pending' as const, remoteId: undefined };
		let posts = 0; const generations: string[] = [];
		const { consumer, values } = fixture([pending], async (_p, method, path, body) => {
			if (method === 'GET' && path.includes('/allocations?')) throw new VoiceRelayError('NOT_FOUND', 404);
			if (method === 'POST' && path.endsWith('/allocations')) {
				generations.push(body.generation); posts++;
				if (posts === 1) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
				return { id: 'remote', generation: body.generation, reservedSlots: 1, state: 'active' };
			}
			throw new Error('unexpected request');
		});
		await expect(consumer.ensure('pending', 1)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
		expect(values.get('allocation:pending').state).toBe('pending');
		expect((await consumer.ensure('pending', 1)).remoteId).toBe('remote');
		expect(generations).toEqual(['pending', 'pending']);
	});
	test('429 ending is retained and retried before the room can be reassigned', async () => {
		const current = call('one', 'relay'); let deletions = 0;
		const { consumer, values } = fixture([current], async (_p, method, path) => {
			if (method === 'DELETE') { deletions++; if (deletions === 1) throw new VoiceRelayError('RATE_LIMITED', 429); return { id: 'one', generation: 'one', state: 'ended' }; }
			if (path.endsWith('/snapshot')) return { allocationId: 'one', generation: 'one', state: 'active', participants: [], revision: '1' };
			if (path.endsWith('/events')) return { events: [], cursor: '1', gap: false };
			throw new Error('unexpected request');
		});
		await expect(consumer.end('one')).rejects.toMatchObject({ status: 429 });
		expect(values.get('allocation:one').state).toBe('ending');
		await expect(consumer.ensure('one', 1)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' });
		await (consumer as any).pollProvider([current]);
		expect(deletions).toBe(2);
		expect(values.get('allocation:one').state).toBe('ended');
	});
});

describe.skipIf(!process.env.VOICE_RELAY_TEST_DATABASE_URL)('voice relay storage with PostgreSQL', () => {
	const url = new URL(process.env.VOICE_RELAY_TEST_DATABASE_URL ?? 'postgres://localhost/test');
	const schema = `storage_${randomUUID().replaceAll('-', '')}`;
	const schemaAdmin = new pg.Pool({ connectionString: url.toString() });
	let config: Config;
	beforeAll(async () => { config = { ...loadConfig(), db: { host: url.hostname, port: Number(url.port), db: url.pathname.slice(1), user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password), extra: { options: `-c search_path=${schema}` } } }; await schemaAdmin.query(`CREATE SCHEMA ${schema}`); });
	afterAll(async () => { await schemaAdmin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await schemaAdmin.end(); });
	test('configured connection options select the isolated schema', async () => {
		const storage = new VoiceRelayStorage(config);
		try { expect((await storage.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema); } finally { await storage.onApplicationShutdown(); }
	});
	test('idle backend termination is handled and the pool recovers', async () => {
		const storage = new VoiceRelayStorage(config); const admin = new pg.Pool({ connectionString: url.toString() });
		try {
			const client = await storage.pool.connect(); const pid = backendPid(client); client.release();
			const hasHandler = storage.pool.listenerCount('error') > 0;
			storage.pool.on('error', () => {});
			await admin.query('SELECT pg_terminate_backend($1)', [pid]);
			await vi.waitFor(() => expect(storage.pool.totalCount).toBe(0));
			expect((await storage.query('SELECT 1 AS n')).rows[0].n).toBe(1);
			expect(hasHandler).toBe(true);
		} finally { await storage.onApplicationShutdown(); await admin.end(); }
	});
	test('checked-out backend termination is handled and discarded', async () => {
		const storage = new VoiceRelayStorage(config); const admin = new pg.Pool({ connectionString: url.toString() });
		let client: pg.PoolClient | undefined;
		storage.pool.on('acquire', c => { client = c; });
		try {
			await expect(storage.lock('checked-out-test', async () => {
				client!.on('error', () => {});
				await admin.query('SELECT pg_terminate_backend($1)', [backendPid(client!)]);
				await vi.waitFor(() => expect((client as any)._queryable).toBe(false));
			})).rejects.toThrow();
			expect(storage.pool.totalCount).toBe(0);
			expect((await storage.query('SELECT 1 AS n')).rows[0].n).toBe(1);
		} finally { await storage.onApplicationShutdown(); await admin.end(); }
	});
	test('unlock failure releases and discards the connection', async () => {
		const storage = new VoiceRelayStorage(config);
		let client: pg.PoolClient | undefined;
		try {
			client = await storage.pool.connect(); const original = client.query.bind(client);
			vi.spyOn(client, 'query').mockImplementation(((sql: string, ...args: any[]) => sql.includes('pg_advisory_unlock') ? Promise.reject(new Error('unlock failed')) : (original as any)(sql, ...args)) as any);
			client.release();
			await expect(storage.lock('unlock-test', async () => {})).rejects.toThrow('unlock failed');
			expect(storage.pool.totalCount).toBe(0);
			expect((await storage.query('SELECT 1 AS n')).rows[0].n).toBe(1);
		} finally { if (storage.pool.totalCount && !storage.pool.idleCount) client?.release(true); await storage.onApplicationShutdown(); }
	});
	test('consumer admissions share provider pool headroom', async () => {
		const storage = new VoiceRelayStorage(config);
		(storage.pool.options as any).connectionTimeoutMillis = 300;
		let unblock!: () => void; const hold = new Promise<void>(resolve => { unblock = resolve; });
		const relay = { storage, rtc: async (raw: string) => { const id = new URL(raw, 'https://local.test').searchParams.get('access_token')!; return { roomId: id, generation: 'g', remoteId: id }; }, get: async (id: string) => ({ state: 'active', generation: 'g', remoteId: id }) } as any;
		const voice = new VoiceBackendService({ ...config, url: 'https://local.test' }, relay, new DataSource({ type: 'postgres', url: url.toString() }));
		let entered = 0;
		const attempts = Array.from({ length: 6 }, (_, i) => voice.withRtcAdmission(`/rtc?access_token=room${i}`, async () => { entered++; await hold; }));
		const settled = Promise.allSettled(attempts);
		try { await vi.waitFor(() => expect(entered).toBeGreaterThanOrEqual(4)); expect((await storage.pool.query('SELECT 1 AS n')).rows[0].n).toBe(1); } finally { unblock(); await settled; await storage.onApplicationShutdown(); }
	});

	test('consumer preserves the original error when unlock also fails', async () => {
		const storage = new VoiceRelayStorage(config); let client: pg.PoolClient | undefined;
		try {
			client = await storage.pool.connect(); const query = client.query.bind(client);
			vi.spyOn(client, 'query').mockImplementation(((sql: string, ...args: any[]) => sql.includes('pg_advisory_unlock') ? Promise.reject(new Error('unlock failed')) : (query as any)(sql, ...args)) as any);
			client.release();
			const run = async () => { throw new Error('original failure'); };
			await expect(storage.lock('failure', run)).rejects.toThrow('original failure');
			expect((await storage.pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);
		} finally { await storage.onApplicationShutdown(); }
	});
});

test('recovers an active allocation without sending a duplicate POST', async () => {
	const pending = { ...call('recovery', 'relay'), state: 'pending' as const, remoteId: undefined };
	const request = vi.fn(async (_provider, method) => {
		if (method === 'GET') return { id: 'remote', generation: 'recovery', state: 'active', reservedSlots: 1 };
		throw new VoiceRelayError('RATE_LIMITED', 429);
	});
	const { consumer, values } = fixture([pending], request);
	expect((await consumer.ensure('recovery', 1)).remoteId).toBe('remote');
	expect(values.get('allocation:recovery').state).toBe('active');
	expect(request).toHaveBeenCalledTimes(1);
});

test('rate limiting cannot move a pending allocation to another provider', async () => {
	const { consumer, values } = fixture([], async (_provider, method, path) => {
		if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10 };
		if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
		throw new VoiceRelayError('RATE_LIMITED', 429);
	});
	values.set('providers', [provider('one'), provider('two')]);
	await expect(consumer.ensure('limited', 1)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
	expect(values.get('allocation:limited').state).toBe('pending');
});

test('a blackhole capacity endpoint does not block a healthy provider', async () => {
	const { consumer, values } = fixture([], async (p, method, path, body) => {
		if (path.endsWith('/capacity')) {
			if (p.id === 'slow') return new Promise(() => {});
			return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10 };
		}
		if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
		return { id: 'remote', generation: body.generation, state: 'active', reservedSlots: body.slots };
	});
	values.set('providers', [provider('slow'), provider('healthy')]);
	const result = await Promise.race([consumer.ensure('fast', 1), new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
	expect(result?.provider.id).toBe('healthy');
});

test('invalid RTC path is rejected before any allocation lookup', async () => {
	const { consumer } = fixture([], async () => { throw new Error('unexpected provider request'); });
	Object.assign(consumer, { config: { url: 'https://consumer.test' } });
	const lookup = vi.spyOn(consumer.storage, 'query');
	const token = `x.${Buffer.from(JSON.stringify({ metadata: JSON.stringify({ allocationId: 'abc', generation: 'g', clientId: 'c' }) })).toString('base64url')}.x`;
	expect(await consumer.rtc(`/livekit/other?access_token=${token}`)).toBeNull();
	expect(await consumer.rtc(`/livekit/rtc/%zz?access_token=${token}`)).toBeNull();
	expect(lookup).not.toHaveBeenCalled();
});

test('ending a pending allocation absent at the provider does not allocate a room', async () => {
	const pending = { ...call('cancel', 'relay'), state: 'pending' as const, remoteId: undefined };
	const request = vi.fn(async (_provider, method, path) => {
		if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10, capabilities: { cancelPending: true } };
		if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
		if (path.endsWith('/allocations/cancel')) return { state: 'ended' };
		throw new Error('must not create a room');
	});
	const { consumer, values } = fixture([pending], request);
	await consumer.end('cancel');
	expect(values.get('allocation:cancel').state).toBe('ended');
	expect(request).toHaveBeenCalledTimes(3);
});

test('legacy providers without cancellation support keep an unknown pending allocation sticky', async () => {
	const pending = { ...call('legacy', 'relay'), state: 'pending' as const, remoteId: undefined };
	const request = vi.fn(async (_provider, method, path) => {
		if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10 };
		if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
		throw new Error('must not create or move the room');
	});
	const { consumer, values } = fixture([pending], request);
	await expect(consumer.end('legacy')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
	expect(values.get('allocation:legacy').state).toBe('pending');
});

test('existing pending provider allocation is never abandoned on a capacity response', async () => {
	const pending = { ...call('pending-remote', 'relay'), state: 'pending' as const, remoteId: undefined };
	const { consumer, values } = fixture([pending], async (_provider, method) => {
		if (method === 'GET') return { id: 'remote', generation: 'pending-remote', state: 'pending', reservedSlots: 1 };
		throw new VoiceRelayError('CAPACITY_EXCEEDED', 429);
	});
	await expect(consumer.ensure('pending-remote', 1)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
	expect(values.get('allocation:pending-remote').state).toBe('pending');
});

test('confirmed capacity rejection moves to the next provider', async () => {
	let rejected: string | undefined;
	const { consumer, values } = fixture([], async (p, method, path, body) => {
		if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10 };
		if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
		if (!rejected) { rejected = p.id; throw new VoiceRelayError('CAPACITY_EXCEEDED', 429); }
		expect(p.id).not.toBe(rejected);
		return { id: 'remote', generation: body.generation, state: 'active', reservedSlots: body.slots };
	});
	values.set('providers', [provider('one'), provider('two')]);
	expect((await consumer.ensure('capacity', 1)).provider.id).not.toBe(rejected);
});

test('inspection traffic for one room does not exhaust another room budget', async () => {
	const calls = [call('one', 'relay'), call('two', 'relay')];
	const { consumer } = fixture(calls, async (_provider, _method, _path, body) => {
		const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
		const hint = JSON.parse(payload.metadata);
		return { allocationId: hint.allocationId, generation: hint.generation };
	});
	Object.assign(consumer, { config: { url: 'https://consumer.test' } });
	consumer.storage.query = async (_text: string, args: any[]) => ({ rows: calls.filter(c => c.remoteId === args[0]).map(value => ({ value })) }) as any;
	Object.assign(consumer.client, { originOf: (origin: string) => origin, headers: () => ({}) });
	const token = (id: string, n: number) => `x.${Buffer.from(JSON.stringify({ metadata: JSON.stringify({ allocationId: id, generation: id, clientId: 'relay' }), n })).toString('base64url')}.x`;
	for (let i = 0; i < 120; i++) expect(await consumer.rtc(`/livekit/rtc?access_token=${token('one', i)}`)).not.toBeNull();
	expect(await consumer.rtc(`/livekit/rtc?access_token=${token('two', 0)}`)).not.toBeNull();
});

test('provider secret can be saved, retained on edit and replaced without appearing in metadata', async () => {
	const { consumer, values } = fixture([], async () => ({}));
	Object.assign(consumer, { config: { url: 'https://consumer.test' } });
	Object.assign(consumer.client, { originOf: (origin: string) => origin });
	const draft = { id: 'configured', origin: 'https://relay.test', enabled: true };
	await consumer.saveProvider({ ...draft, secret: 'a'.repeat(64) } as any);
	const secretKey = () => `provider-secret:configured:${values.get('providers')[0].credentialVersion}`;
	expect(values.get(secretKey())).toBe('a'.repeat(64));
	expect(JSON.stringify(values.get('providers'))).not.toContain('a'.repeat(64));
	values.get('providers')[0].validated = true;
	await consumer.saveProvider({ ...draft, secret: '' } as any);
	expect(values.get(secretKey())).toBe('a'.repeat(64));
	expect(values.get('providers')[0].validated).toBe(true);
	await consumer.saveProvider({ ...draft, secret: 'b'.repeat(64) } as any);
	expect(values.get(secretKey())).toBe('b'.repeat(64));
	expect(values.get('providers')[0].validated).toBe(false);
});

test('an old connection check cannot validate a newly replaced secret', async () => {
 const { consumer, values } = fixture([], async () => ({}));
 Object.assign(consumer, { config: { url: 'https://consumer.test' } });
 Object.assign(consumer.client, { originOf: (origin: string) => origin });
 const draft = { id: 'rotation', origin: 'https://relay.test', enabled: true };
 await consumer.saveProvider({ ...draft, secret: 'a'.repeat(64) } as any);
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 vi.spyOn(consumer, 'capacity').mockImplementation(async () => { entered(); await gate; return { enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 1 }; });
 const check = consumer.checkProvider('rotation');
 await started;
 await consumer.saveProvider({ ...draft, secret: 'b'.repeat(64) } as any);
 release(); await check;
 expect(values.get('providers')[0].validated).toBe(false);
});

test('pending capacity recovery fences the old generation before selecting another provider', async () => {
 const pending = { ...call('move', 'old'), state: 'pending' as const, remoteId: undefined };
 const operations: string[] = [];
 const { consumer, values } = fixture([pending], async (p, method, path, body) => {
  operations.push(`${p.id}:${method}:${path.split('?')[0]}`);
  if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: p.id !== 'old', maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10, capabilities: { cancelPending: true } };
  if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
  if (path.endsWith('/allocations/cancel')) return { state: 'ended' };
  if (p.id === 'old') throw new VoiceRelayError('CAPACITY_EXCEEDED', 429);
  return { id: 'new-remote', generation: body.generation, state: 'active', reservedSlots: body.slots };
 });
 values.set('providers', [provider('old'), provider('new')]);
 const result = await consumer.ensure('move', 1);
 expect(result.provider.id).toBe('new');
 expect(result.generation).not.toBe(pending.generation);
 expect(operations.indexOf('old:POST:/voice-relay/v1/allocations/cancel')).toBeLessThan(operations.indexOf('new:POST:/voice-relay/v1/allocations'));
});

test('failed pending cancellation keeps the original provider and generation', async () => {
 const pending = { ...call('stuck', 'old'), state: 'pending' as const, remoteId: undefined };
 const { consumer, values } = fixture([pending], async (_p, method, path) => {
  if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 10, reservedSlots: 0, remainingSlots: 10, remainingRooms: 10, capabilities: { cancelPending: true } };
  if (method === 'GET') throw new VoiceRelayError('NOT_FOUND', 404);
  throw new VoiceRelayError('PROVIDER_UNAVAILABLE', 503);
 });
 await expect(consumer.end('stuck')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
 expect(values.get('allocation:stuck')).toMatchObject({ state: 'pending', generation: 'stuck', provider: { id: 'old' } });
});
