/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Inject, Injectable, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { VoiceRelayClient, VoiceRelayError } from '@/core/VoiceRelayClient.js';
import { rankProviders, relayCapability, type RelayCapacity, type RelayProvider } from '@/core/voice-relay/selection.js';
import { parseIceServers, type IceServer } from '@/core/CloudflareTurnService.js';
import type { LiveKitParticipant } from '@/core/LiveKitService.js';
import { parseScreenShareLimits, type ScreenShareLimits } from '@/core/voice-relay/screen-share-limits.js';
const BASE = '/voice-relay/v1';
export type RelayCall = { roomId: string; generation: string; provider: RelayProvider; remoteId?: string; state: 'pending' | 'active' | 'ending' | 'ended'; slots: number; renewedAt?: number; revision?: string; refreshedAt?: number; presenceHash?: string; unavailable?: boolean };
type Allocation = { id: string; generation: string; state: RelayCall['state']; reservedSlots: number };
type Snapshot = { allocationId: string; generation: string; state: RelayCall['state']; participants: LiveKitParticipant[]; revision: string };
type RelaySnapshot = Omit<Snapshot, 'participants'> & { participants: (Omit<LiveKitParticipant, 'canScreenShare'> & { allowScreenShare: boolean })[] };
export type RelayRtc = { url: URL; headers: Record<string, string>; roomId: string; generation: string; remoteId: string };
@Injectable()
export class VoiceRelayConsumerService implements OnModuleInit, OnApplicationShutdown {
	public providers: RelayProvider[] = [];
	public hasRetainedCalls = false;
	public readonly changes = new EventEmitter();
	private timer?: ReturnType<typeof setInterval>;
	private busyProviders = new Set<string>();
	private capacityCooldown = new Map<string, number>();
	private capabilities = new Map<string, { includeIceServers: boolean; recordingStatus: boolean; expires: number }>();
	private capabilityRequests = new Map<string, Promise<boolean>>();
	private recordingCapabilityRequests = new Map<string, Promise<boolean>>();
	private tokenCache = new Map<string, { roomId: string | null; generation?: string; expires: number }>();
	private inspections = 0;
	private inspectionWindows = new Map<string, { started: number; count: number }>();
	private lastPrune = 0;
	private capacityKey(provider: RelayProvider): string { return JSON.stringify([provider.id, provider.origin, provider.credentialVersion]); }
	constructor(@Inject(DI.config) private config: Config, public storage: VoiceRelayStorage, public client: VoiceRelayClient) {}
	get isEnabled(): boolean { return relayCapability(this.providers); }
	async onModuleInit(): Promise<void> {
		try { await this.allProviders(); } catch (error) { if (['42P01', '3F000'].includes((error as { code?: string }).code ?? '')) return; }
		this.timer = setInterval(() => { this.poll().catch(() => {}); }, 2000); this.timer.unref();
	}
	onApplicationShutdown(): void { if (this.timer) clearInterval(this.timer); }
	async allProviders(): Promise<RelayProvider[]> { this.providers = await this.storage.read<RelayProvider[]>('providers') ?? []; const records = await this.storage.query('SELECT value FROM consumer_state WHERE key LIKE \'allocation:%\' AND value->>\'state\'<>\'ended\''); this.hasRetainedCalls = records.rows.some(({ value }) => this.providers.some(p => p.id === value.provider.id && p.origin === value.provider.origin)); return this.providers; }
	async authFor(call: RelayCall): Promise<RelayProvider> {
		const current = (await this.storage.read<RelayProvider[]>('providers') ?? []).find(p => p.id === call.provider.id && p.origin === call.provider.origin);
		return current ?? call.provider;
	}
	async saveProvider(input: Omit<RelayProvider, 'validated' | 'deleted' | 'credentialVersion'> & { secret?: string }): Promise<RelayProvider[]> {
		this.client.originOf(input.origin); if (input.origin === new URL(this.config.url).origin) throw new VoiceRelayError('INVALID_PROVIDER', 400);
		return this.storage.lock('providers', async () => {
			const providers = await this.allProviders(), old = providers.find(p => p.id === input.id);
			const secret = input.secret || undefined;
			if (secret && secret.length < 32) throw new VoiceRelayError('MISSING_KEY', 400);
			const priorSecret = await this.storage.read<string>(old?.credentialVersion ? `provider-secret:${encodeURIComponent(input.id)}:${old.credentialVersion}` : `provider-secret:${input.id}`);
			if (!secret && !priorSecret) throw new VoiceRelayError('MISSING_KEY', 400);
			if (!old && providers.length >= 8) throw new VoiceRelayError('PROVIDER_LIMIT', 400);
			if (providers.some(p => p.id !== input.id && p.origin === input.origin)) throw new VoiceRelayError('INVALID_PROVIDER', 400);
			if (old && old.origin !== input.origin) {
				const active = await this.storage.query('SELECT 1 FROM consumer_state WHERE key LIKE \'allocation:%\' AND value->\'provider\'->>\'id\'=$1 AND value->>\'state\'<>\'ended\' LIMIT 1', [input.id]);
				if (active.rowCount) throw new VoiceRelayError('ALLOCATION_CONFLICT', 409);
			}
			const validated = old?.validated === true && !secret && old.origin === input.origin;
			const next = [...providers.filter(p => p.id !== input.id), { id: input.id, origin: input.origin, enabled: input.enabled, validated, credentialVersion: secret ? randomUUID() : old?.credentialVersion }];
			await this.storage.query('BEGIN');
			try { if (secret) await this.storage.write(`provider-secret:${encodeURIComponent(input.id)}:${next[next.length - 1].credentialVersion}`, secret); await this.storage.write('providers', next); await this.storage.query('COMMIT'); } catch (error) { await this.storage.query('ROLLBACK'); throw error; }
			this.providers = next; this.capacityCooldown.clear(); return next;
		});
	}
	async removeProvider(id: string): Promise<void> {
		await this.storage.lock('providers', async () => {
			const providers = await this.allProviders(), old = providers.find(p => p.id === id);
			if (!old) throw new VoiceRelayError('NOT_FOUND', 404);
			const active = await this.storage.query('SELECT 1 FROM consumer_state WHERE key LIKE \'allocation:%\' AND value->\'provider\'->>\'id\'=$1 AND value->>\'state\'<>\'ended\' LIMIT 1', [id]);
			const next = active.rowCount ? providers.map(p => p.id === id ? { ...p, enabled: false, deleted: true } : p) : providers.filter(p => p.id !== id);
			await this.storage.query('BEGIN');
			try { await this.storage.write('providers', next); if (!active.rowCount) await this.storage.query('DELETE FROM consumer_state WHERE key=$1 OR left(key,length($2))=$2', [`provider-secret:${id}`, `provider-secret:${encodeURIComponent(id)}:`]); await this.storage.query('COMMIT'); } catch (error) { await this.storage.query('ROLLBACK'); throw error; }
			this.providers = next;
		});
	}
	async capacity(provider: RelayProvider): Promise<RelayCapacity> {
		const c = await this.client.request<RelayCapacity>(provider, 'GET', `${BASE}/capacity`);
		if (c.protocolVersion !== 1 || typeof c.enabled !== 'boolean' || typeof c.accepting !== 'boolean' || !Number.isSafeInteger(c.maxSlots) || c.maxSlots < 1 || !Number.isSafeInteger(c.reservedSlots) || c.reservedSlots < 0 || !Number.isSafeInteger(c.remainingSlots) || c.remainingSlots < 0 || !Number.isSafeInteger(c.remainingRooms) || c.remainingRooms < 0) throw new VoiceRelayError('INVALID_RESPONSE');
		const screenShareLimits = c.screenShareLimits === undefined ? undefined : parseScreenShareLimits(c.screenShareLimits);
		if (screenShareLimits === null) throw new VoiceRelayError('INVALID_RESPONSE');
		if (this.capabilities.size >= 256) this.capabilities.delete(this.capabilities.keys().next().value!);
		this.capabilities.set(this.capacityKey(provider), { includeIceServers: c.capabilities?.includeIceServers === true, recordingStatus: c.capabilities?.recordingStatus === true, expires: Date.now() + 5000 });
		return { ...c, screenShareLimits };
	}
	private async supportsIceSuppression(provider: RelayProvider): Promise<boolean> {
		const key = this.capacityKey(provider); const cached = this.capabilities.get(key);
		if (cached && cached.expires > Date.now()) return cached.includeIceServers;
		const pending = this.capabilityRequests.get(key);
		if (pending) return pending;
		const request = this.capacity(provider).then(c => c.capabilities?.includeIceServers === true).finally(() => this.capabilityRequests.delete(key));
		this.capabilityRequests.set(key, request);
		return request;
	}
	async supportsRecording(roomId: string): Promise<boolean> {
		const call = await this.get(roomId);
		if (!call || call.state !== 'active') return false;
		const provider = await this.authFor(call);
		const key = this.capacityKey(provider);
		const cached = this.capabilities.get(key);
		if (cached && cached.expires > Date.now()) return cached.recordingStatus;
		const pending = this.recordingCapabilityRequests.get(key);
		if (pending) return pending;
		const request = this.capacity(provider).then(capacity => capacity.capabilities?.recordingStatus === true).finally(() => this.recordingCapabilityRequests.delete(key));
		this.recordingCapabilityRequests.set(key, request);
		return request;
	}
	async checkProvider(id: string): Promise<RelayCapacity> {
		const provider = (await this.allProviders()).find(p => p.id === id); if (!provider) throw new VoiceRelayError('NOT_FOUND', 404);
		const capacity = await this.capacity(provider);
		await this.storage.lock('providers', async () => { this.providers = (await this.allProviders()).map(p => p.id === id && p.credentialVersion === provider.credentialVersion ? { ...p, validated: capacity.enabled === true } : p); await this.storage.write('providers', this.providers); }); return capacity;
	}
	async get(roomId: string): Promise<RelayCall | null> { return this.storage.read<RelayCall>(`allocation:${roomId}`); }
	private path(call: RelayCall, suffix = ''): string { if (!call.remoteId) throw new VoiceRelayError('ALLOCATION_CONFLICT', 409); return `${BASE}/allocations/${encodeURIComponent(call.remoteId)}${suffix}`; }
	async ensure(roomId: string, slots: number): Promise<RelayCall> {
		return this.storage.lock(`allocation:${roomId}`, async () => {
			const call = await this.get(roomId);
			if (call && call.state !== 'ended') {
				if (call.state === 'pending') {
					try { return await this.reserve(call); } catch (error) {
						if (!(error instanceof VoiceRelayError) || error.code !== 'CAPACITY_EXCEEDED' || error.status !== 429) throw error;
						await this.terminatePending(call);
					}
				} else {
					const snapshot = await this.snapshot(call);
					if (snapshot.state !== 'ended') { if (call.state === 'ending') throw new VoiceRelayError('ALLOCATION_CONFLICT', 409); await this.renew(call); return call; }
					call.state = 'ended'; await this.storage.write(`allocation:${roomId}`, call);
				}
			}
			const configured = (await this.allProviders()).filter(p => p.enabled && p.validated);
			const eligible = configured.filter(p => (this.capacityCooldown.get(this.capacityKey(p)) ?? 0) <= Date.now());
			const checked: PromiseSettledResult<RelayProvider & { capacity: RelayCapacity }>[] = [];
			const failures: { provider: RelayProvider; error: unknown }[] = [];
			const queries = eligible.map(async p => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const capacity = await Promise.race([this.capacity(p), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new VoiceRelayError('PROVIDER_UNAVAILABLE')), 2000); })]);
					if (capacity.enabled === false) throw new VoiceRelayError('CLIENT_DISABLED', 403);
					const value = { ...p, capacity }; checked.push({ status: 'fulfilled', value }); return value;
				} catch (error) {
					this.capacityCooldown.set(this.capacityKey(p), Date.now() + 10000);
					checked.push({ status: 'rejected', reason: error });
					failures.push({ provider: p, error }); throw error;
				} finally { if (timer) clearTimeout(timer); }
			});
			const all = Promise.allSettled(queries);
			if (queries.length) {
				try { await Promise.any(queries.map(query => query.then(value => { if (!rankProviders([value], slots).length) throw new Error('capacity unavailable'); return value; }))); await Promise.race([all, new Promise(resolve => setTimeout(resolve, 100))]); } catch { await all; }
			}
			for (const { provider, error } of [...failures]) await this.permanentFailure(provider, error);
			const candidates = checked.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
			if (!candidates.length) {
				if (!configured.length || checked.length > 0 && checked.every(result => result.status === 'rejected' && result.reason instanceof VoiceRelayError && [401, 403].includes(result.reason.status))) throw new VoiceRelayError('CLIENT_DISABLED', 403);
				throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
			}
			for (const candidate of rankProviders(candidates, slots)) {
				const { capacity: _capacity, ...provider } = candidate;
				const next: RelayCall = { roomId, generation: randomUUID(), provider, state: 'pending', slots };
				const accepted = await this.storage.lock('providers', async () => {
					const current = (await this.storage.read<RelayProvider[]>('providers') ?? []).find(p => p.id === provider.id && p.origin === provider.origin && p.credentialVersion === provider.credentialVersion);
					if (!current?.enabled || !current.validated || current.deleted) return false;
					await this.storage.write(`allocation:${roomId}`, next); return true;
				});
				if (!accepted) continue;
				try { return await this.reserve(next); } catch (error) { if (error instanceof VoiceRelayError && error.code === 'CAPACITY_EXCEEDED' && error.status === 429) { next.state = 'ended'; await this.storage.write(`allocation:${roomId}`, next); continue; } throw error; }
			}
			throw new VoiceRelayError('CAPACITY_EXCEEDED', 429);
		});
	}
	private async reserve(call: RelayCall): Promise<RelayCall> {
		const provider = await this.authFor(call);
		let recovered: Allocation | null = null;
		try {
			recovered = await this.client.request<Allocation>(provider, 'GET', `${BASE}/allocations?roomKey=${encodeURIComponent(`${this.config.url}/chat/rooms/${call.roomId}`)}&generation=${encodeURIComponent(call.generation)}`);
		} catch (error) {
			if (!(error instanceof VoiceRelayError) || error.status !== 404) {
				if (error instanceof VoiceRelayError && error.code === 'CAPACITY_EXCEEDED') throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
				throw error;
			}
		}
		if (recovered?.id && recovered.generation === call.generation && recovered.state === 'ended') { call.remoteId = recovered.id; call.state = 'ended'; await this.storage.write(`allocation:${call.roomId}`, call); throw new VoiceRelayError('ALLOCATION_ENDED', 409); }
		let a = recovered;
		if (!recovered || recovered.state === 'pending' && recovered.id && recovered.generation === call.generation && recovered.reservedSlots === call.slots) {
			try { a = await this.client.request<Allocation>(provider, 'POST', `${BASE}/allocations`, { roomKey: `${this.config.url}/chat/rooms/${call.roomId}`, generation: call.generation, slots: call.slots }); } catch (error) { if (recovered && error instanceof VoiceRelayError && error.code === 'CAPACITY_EXCEEDED') throw new VoiceRelayError('PROVIDER_UNAVAILABLE'); throw error; }
		}
		if (!a) throw new VoiceRelayError('INVALID_RESPONSE');
		if (typeof a.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(a.id) || a.generation !== call.generation || a.reservedSlots !== call.slots || a.state !== 'active') throw new VoiceRelayError('INVALID_RESPONSE');
		this.hasRetainedCalls = true; call.remoteId = a.id; call.state = 'active'; call.renewedAt = Date.now(); await this.storage.write(`allocation:${call.roomId}`, call); return call;
	}
	private remember(token: string, call: RelayCall): void {
		let expires = Date.now() + 600_000;
		try { const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); if (typeof payload.exp === 'number') expires = Math.min(expires, payload.exp * 1000); } catch {}
		this.cache(createHash('sha256').update(token).digest('hex'), { roomId: call.roomId, generation: call.generation, expires });
	}
	private cache(key: string, value: { roomId: string | null; generation?: string; expires: number }): void { if (this.tokenCache.size >= 2048) this.tokenCache.delete(this.tokenCache.keys().next().value!); this.tokenCache.set(key, value); }
	async join(roomId: string, params: { identity: string; userId: string; allowScreenShare: boolean }, includeIceServers?: false): Promise<{ token: string; iceServers: IceServer[] | null; mediaProvider: string; screenShareLimits?: ScreenShareLimits }> {
		const call = await this.get(roomId); if (!call || call.state !== 'active') throw new VoiceRelayError('ALLOCATION_CONFLICT', 409);
		const provider = await this.authFor(call);
		if (includeIceServers === false && !await this.supportsIceSuppression(provider)) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
		const result = await this.client.request<{ token: string; iceServers: unknown; generation: string; allocationId: string; mediaProvider: string; screenShareLimits?: unknown }>(provider, 'POST', this.path(call, '/join'), includeIceServers === false ? { ...params, includeIceServers: false } : params);
		if (typeof result.token !== 'string' || result.token.length > 16384 || result.allocationId !== call.remoteId || result.generation !== call.generation || result.mediaProvider !== call.provider.origin) throw new VoiceRelayError('INVALID_RESPONSE');
		const screenShareLimits = result.screenShareLimits === undefined ? undefined : parseScreenShareLimits(result.screenShareLimits);
		if (screenShareLimits === null) throw new VoiceRelayError('INVALID_RESPONSE');
		this.remember(result.token, call);
		return { token: result.token, iceServers: result.iceServers === null ? null : parseIceServers(result.iceServers) ?? [], mediaProvider: result.mediaProvider, screenShareLimits };
	}
	async snapshot(call: RelayCall): Promise<Snapshot> {
		const snapshot = await this.client.request<RelaySnapshot>(await this.authFor(call), 'GET', this.path(call, '/snapshot'));
		if (snapshot.allocationId !== call.remoteId || snapshot.generation !== call.generation || !Array.isArray(snapshot.participants) || snapshot.participants.length > call.slots || !/^\d+$/.test(snapshot.revision) || !['pending', 'active', 'ending', 'ended'].includes(snapshot.state)) throw new VoiceRelayError('INVALID_RESPONSE');
		for (const p of snapshot.participants) if (p == null || typeof p !== 'object' || typeof p.identity !== 'string' || typeof p.userId !== 'string' || typeof p.screenSharing !== 'boolean' || typeof p.allowScreenShare !== 'boolean') throw new VoiceRelayError('INVALID_RESPONSE');
		return { ...snapshot, participants: snapshot.participants.map(({ allowScreenShare, ...participant }) => ({ ...participant, canScreenShare: allowScreenShare })) };
	}
	async participants(roomId: string): Promise<LiveKitParticipant[] | null> { const call = await this.get(roomId); if (!call || call.state === 'ended') return null; return (await this.snapshot(call)).participants; }
	async participant(roomId: string, action: string, data: unknown): Promise<boolean | null> {
		const call = await this.get(roomId);
		if (!call || call.state === 'ended') return null;
		if (action === 'status' && data != null && typeof data === 'object' && 'recording' in data && data.recording !== undefined && !await this.supportsRecording(roomId)) {
			if (data.recording === true) return false;
			// 이전 제공자에서도 종료 시의 일반 mic/deafen 보고는 유지한다.
			const { recording: _recording, ...settings } = data;
			data = settings;
		}
		const result = await this.client.request<{ accepted: boolean }>(await this.authFor(call), 'POST', this.path(call, `/participants/${action}`), data);
		if (action === 'kick' && (result == null || typeof result.accepted !== 'boolean')) throw new VoiceRelayError('INVALID_RESPONSE');
		return result.accepted === true;
	}
	async end(roomId: string): Promise<boolean> {
		return this.storage.lock(`allocation:${roomId}`, async () => {
			const call = await this.get(roomId); if (!call || call.state === 'ended') return false;
			if (call.state === 'pending') { await this.terminatePending(call); return true; }
			call.state = 'ending'; await this.storage.write(`allocation:${roomId}`, call);
			const result = await this.client.request<Allocation>(await this.authFor(call), 'DELETE', this.path(call));
			if (result.state !== 'ended' || result.id !== call.remoteId || result.generation !== call.generation) throw new VoiceRelayError('INVALID_RESPONSE');
			call.state = 'ended'; await this.storage.write(`allocation:${roomId}`, call); return true;
		});
	}
	private async terminatePending(call: RelayCall): Promise<void> {
		const provider = await this.authFor(call);
		const roomKey = `${this.config.url}/chat/rooms/${call.roomId}`;
		let existing: Allocation | null = null;
		try { existing = await this.client.request<Allocation>(provider, 'GET', `${BASE}/allocations?roomKey=${encodeURIComponent(roomKey)}&generation=${encodeURIComponent(call.generation)}`); } catch (error) { if (!(error instanceof VoiceRelayError) || error.status !== 404) throw error; }
		if (existing) {
			if (typeof existing.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(existing.id) || existing.generation !== call.generation || existing.reservedSlots !== call.slots || !['pending', 'active', 'ending', 'ended'].includes(existing.state)) throw new VoiceRelayError('INVALID_RESPONSE');
			call.remoteId = existing.id;
			if (existing.state !== 'ended') {
				call.state = 'ending'; await this.storage.write(`allocation:${call.roomId}`, call);
				const ended = await this.client.request<Allocation>(provider, 'DELETE', this.path(call));
				if (ended.id !== existing.id || ended.generation !== call.generation || ended.state !== 'ended') throw new VoiceRelayError('INVALID_RESPONSE');
			}
		} else {
			const capacity = await this.capacity(provider);
			if (capacity.capabilities?.cancelPending !== true) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
			const ended = await this.client.request<{ state: string }>(provider, 'POST', `${BASE}/allocations/cancel`, { roomKey, generation: call.generation });
			if (ended.state !== 'ended') throw new VoiceRelayError('INVALID_RESPONSE');
		}
		call.state = 'ended'; await this.storage.write(`allocation:${call.roomId}`, call);
	}
	async renew(call: RelayCall): Promise<void> {
		if (Date.now() - (call.renewedAt ?? 0) < 30000) return;
		const result = await this.client.request<Allocation>(await this.authFor(call), 'POST', this.path(call, '/lease'), {});
		if (result.id !== call.remoteId || result.generation !== call.generation || result.state !== 'active') throw new VoiceRelayError('INVALID_RESPONSE');
		call.renewedAt = Date.now(); await this.storage.write(`allocation:${call.roomId}`, call);
	}
	private async permanentFailure(provider: RelayProvider, error: unknown): Promise<void> {
		if (!(error instanceof VoiceRelayError) || ![401, 403].includes(error.status)) return;
		await this.storage.lock('providers', async () => { this.providers = (await this.allProviders()).map(p => p.id === provider.id && p.origin === provider.origin && p.credentialVersion === provider.credentialVersion ? { ...p, validated: false } : p); await this.storage.write('providers', this.providers); });
	}
	private async each<T>(values: T[], operation: (value: T) => Promise<void>): Promise<void> { let index = 0; await Promise.all(Array.from({ length: Math.min(2, values.length) }, async () => { while (index < values.length) await operation(values[index++]); })); }
	private async pruneEnded(): Promise<void> {
		await this.storage.query('DELETE FROM consumer_state WHERE value->>\'state\'=\'ended\' AND updated_at<now()-interval \'7 days\' AND key IN (SELECT key FROM consumer_state WHERE (key LIKE \'allocation:%\' OR key LIKE \'direct:%\') AND value->>\'state\'=\'ended\' AND updated_at<now()-interval \'7 days\' ORDER BY updated_at LIMIT 500)');
	}
	async poll(): Promise<void> {
		if (Date.now() - this.lastPrune >= 60000) { this.lastPrune = Date.now(); await this.pruneEnded(); }
		await this.allProviders();
		for (const provider of this.providers.filter(p => p.deleted)) await this.removeProvider(provider.id);
		const rows = await this.storage.query('SELECT value FROM consumer_state WHERE key LIKE \'allocation:%\' AND value->>\'state\'<>\'ended\'');
		const groups = new Map<string, RelayCall[]>(); for (const { value } of rows.rows) { const call = value as RelayCall; const list = groups.get(call.provider.id) ?? []; list.push(call); groups.set(call.provider.id, list); }
		for (const [id, calls] of groups) {
			if (this.busyProviders.has(id)) continue; this.busyProviders.add(id);
			this.pollProvider(calls).catch(() => {}).finally(() => this.busyProviders.delete(id));
		}
	}
	private async pollProvider(calls: RelayCall[]): Promise<void> {
		// Each provider progresses independently; slow snapshots never postpone another provider's renewals.
		await this.each(calls, async call => {
			await this.storage.lock(`allocation:${call.roomId}`, async () => {
				const current = await this.get(call.roomId); if (!current || current.generation !== call.generation || current.state === 'ended') return;
				try { if (current.state === 'pending') { await this.reserve(current); return; } if (current.state === 'ending') { await this.end(current.roomId); return; } await this.renew(current); } catch (error) { current.unavailable = true; await this.storage.write(`allocation:${current.roomId}`, current); await this.permanentFailure(await this.authFor(current), error); }
			});
		});
		const provider = await this.authFor(calls[0]), key = `events:${provider.id}`;
		const cursor = await this.storage.read<string>(key);
		let feed: { events: { allocationId: string; generation: string }[]; cursor: string; gap: boolean };
		try {
			feed = await this.client.request(provider, 'GET', `${BASE}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
			if (!Array.isArray(feed.events) || feed.events.length > 100 || typeof feed.cursor !== 'string' || feed.cursor.length > 256 || typeof feed.gap !== 'boolean') throw new VoiceRelayError('INVALID_RESPONSE');
		} catch (error) {
			await this.each(calls, async call => this.storage.lock(`allocation:${call.roomId}`, async () => {
				const current = await this.get(call.roomId);
				if (!current || current.state !== 'active' || current.generation !== call.generation) return;
				current.unavailable = true; await this.storage.write(`allocation:${current.roomId}`, current); this.changes.emit('change', current.roomId);
			}));
			await this.permanentFailure(provider, error);
			return;
		}
		let failed = false;
		await this.each(calls, async call => {
			await this.storage.lock(`allocation:${call.roomId}`, async () => {
				const current = await this.get(call.roomId); if (!current || current.state !== 'active' || current.generation !== call.generation) return;
				if (!current.unavailable && !feed.gap && Date.now() - (current.refreshedAt ?? 0) < 60_000 && !feed.events.some(event => event.allocationId === current.remoteId && event.generation === current.generation)) return;
				try { const snapshot = await this.snapshot(current); current.refreshedAt = Date.now(); current.unavailable = false; current.revision = snapshot.revision; if (snapshot.state === 'ended') current.state = 'ended'; await this.storage.write(`allocation:${current.roomId}`, current); this.changes.emit('change', current.roomId); } catch (error) { failed = true; current.unavailable = true; await this.storage.write(`allocation:${current.roomId}`, current); await this.permanentFailure(await this.authFor(current), error); }
			});
		});
		if (!failed) await this.storage.write(key, feed.cursor);
	}
	async rtc(rawUrl: string): Promise<RelayRtc | null> {
		const input = new URL(rawUrl, this.config.url), token = input.searchParams.get('access_token');
		if (!token || input.searchParams.getAll('access_token').length !== 1 || token.length > 16384) return null;
		const path = rawUrl.split('?')[0];
		if (path !== '/livekit/rtc' && !path.startsWith('/livekit/rtc/')) return null;
		try { if (path.includes('\\') || /%(?:2f|5c|25)/i.test(path) || decodeURIComponent(path).split('/').some(p => p === '.' || p === '..')) return null; } catch { return null; }
		const hash = createHash('sha256').update(token).digest('hex'), cached = this.tokenCache.get(hash);
		let call: RelayCall | null = null;
		if (cached && cached.expires > Date.now()) { if (!cached.roomId) return null; call = await this.get(cached.roomId); if (!call || call.generation !== cached.generation || call.state !== 'active') return null; }
		if (!call) {
			let hint: { allocationId?: string; generation?: string; clientId?: string };
			try { const parts = token.split('.'); if (parts.length !== 3) throw new Error(); const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); hint = JSON.parse(claims.metadata); if (typeof hint.allocationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(hint.allocationId) || typeof hint.generation !== 'string' || hint.generation.length < 1 || hint.generation.length > 128 || typeof hint.clientId !== 'string' || hint.clientId.length < 1 || hint.clientId.length > 128) throw new Error(); } catch { this.cache(hash, { roomId: null, expires: Date.now() + 5000 }); return null; }
			// Unverified claims are only a database locator, never authorization or an upstream address.
			const found = await this.storage.query('SELECT value FROM consumer_state WHERE key LIKE \'allocation:%\' AND value->>\'remoteId\'=$1 AND value->>\'generation\'=$2 AND value->>\'state\'=\'active\' LIMIT 9', [hint.allocationId, hint.generation]);
			if (found.rows.length !== 1) { this.cache(hash, { roomId: null, expires: Date.now() + 5000 }); return null; }
			call = found.rows[0].value as RelayCall;
			const budgetKey = `${call.provider.id}:${call.roomId}:${call.generation}`;
			let budget = this.inspectionWindows.get(budgetKey);
			if (!budget || Date.now() - budget.started >= 60000) { budget = { started: Date.now(), count: 0 }; if (this.inspectionWindows.size >= 2048) this.inspectionWindows.delete(this.inspectionWindows.keys().next().value!); this.inspectionWindows.set(budgetKey, budget); }
			if (this.inspections >= 8 || budget.count >= 120) throw new VoiceRelayError('RATE_LIMITED', 429);
			this.inspections++; budget.count++;
			try { const result = await this.client.request<{ allocationId: string; generation: string }>(await this.authFor(call), 'POST', `${BASE}/tokens/inspect`, { token }); if (result.allocationId !== call.remoteId || result.generation !== call.generation) throw new VoiceRelayError('FORBIDDEN', 403); this.remember(token, call); } catch { this.cache(hash, { roomId: null, expires: Date.now() + 5000 }); return null; } finally { this.inspections--; }
		}
		if (!call.remoteId || !/^[a-zA-Z0-9-]+$/.test(call.remoteId)) return null;
		const suffix = rawUrl.slice('/livekit'.length); if (suffix.split('?')[0] !== '/rtc' && !suffix.startsWith('/rtc/')) return null;
		const upstreamPath = `${BASE}/allocations/${call.remoteId}${suffix}`, provider = await this.authFor(call);
		return { url: new URL(upstreamPath, this.client.originOf(provider.origin)), headers: await this.client.headers(provider, 'GET', upstreamPath), roomId: call.roomId, generation: call.generation, remoteId: call.remoteId };
	}
}
