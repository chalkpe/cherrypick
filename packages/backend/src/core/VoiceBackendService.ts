/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { DataSource, QueryRunner } from 'typeorm';
import type pg from 'pg';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { Config, VoiceCallConfig } from '@/config.js';
import type { MiMeta } from '@/models/Meta.js';
import { LiveKitService, userIdOfMetadata, type LiveKitParticipant } from '@/core/LiveKitService.js';
import { VoiceRelayConsumerService, type RelayRtc, type RelayCall } from '@/core/VoiceRelayConsumerService.js';
import { VoiceRelayError } from '@/core/VoiceRelayClient.js';
import { withAdmission } from '@/core/voice-relay/admission.js';
import { validateLiveKitVerificationKeys, verifyLiveKitToken } from '@/core/voice-relay/livekit-verification.js';
import type { IceServer } from '@/core/CloudflareTurnService.js';
import type { ScreenShareLimits } from '@/core/voice-relay/screen-share-limits.js';
type DirectServer = { fingerprint: string };
type DirectCall = { generation: string; state: 'pending' | 'active' | 'ended'; slots: number; server?: DirectServer };
export type RtcParticipant = { identity: string; userId: string; canScreenShare: boolean };

/** Call only after the token is verified by the local SFU key or the selected provider. */
function participantOfVerifiedToken(token: string): RtcParticipant | null {
	try {
		const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
		if (claims == null || typeof claims !== 'object') return null;
		const { sub, metadata, video } = claims as Record<string, unknown>;
		const userId = userIdOfMetadata(typeof metadata === 'string' ? metadata : undefined);
		if (typeof sub !== 'string' || !sub || !userId || video == null || typeof video !== 'object') return null;
		const grant = video as Record<string, unknown>;
		if (grant.roomJoin !== true || !Array.isArray(grant.canPublishSources) && grant.canPublishSources != null) return null;
		const sources = grant.canPublishSources as unknown[] | undefined;
		const canScreenShare = grant.canPublish !== false && (!sources || sources.length === 0 || sources.includes('screen_share') || sources.includes('screen_share_audio'));
		return { identity: sub, userId, canScreenShare };
	} catch { return null; }
}

@Injectable()
export class VoiceBackendService extends LiveKitService {
 private readonly rtcIpBudget = new Map<string, { started: number; count: number }>();
	private readonly participantLock = new AsyncLocalStorage<{ roomId: string; identity: string; runner: QueryRunner; digest: string; active: boolean }>();
	private voiceConfig: Config;
	private readonly retainedLivekits: NonNullable<VoiceCallConfig['livekit']>[];
	constructor(@Inject(DI.config) config: Config, private relay: VoiceRelayConsumerService, @Inject(DI.db) private db: DataSource, @Optional() @Inject(DI.meta) private settings?: MiMeta) {
		const livekit = settings?.voiceCallLivekitSource === 'disabled' ? undefined : settings?.voiceCallLivekitSource === 'custom'
			? settings.voiceCallLivekitUrl && settings.voiceCallLivekitApiKey && settings.voiceCallLivekitApiSecret
				? { internalUrl: settings.voiceCallLivekitUrl, apiKey: settings.voiceCallLivekitApiKey, apiSecret: settings.voiceCallLivekitApiSecret }
				: undefined
			: config.voiceCall?.livekit;
		const voiceConfig = settings ? { ...config, voiceCall: { ...config.voiceCall, livekit, preferRelay: settings.voiceCallPreferRelay ?? config.voiceCall?.preferRelay } } : config;
		super(voiceConfig);
		this.voiceConfig = voiceConfig;
		const custom = settings?.voiceCallLivekitUrl && settings.voiceCallLivekitApiKey && settings.voiceCallLivekitApiSecret
			? { internalUrl: settings.voiceCallLivekitUrl, apiKey: settings.voiceCallLivekitApiKey, apiSecret: settings.voiceCallLivekitApiSecret }
			: undefined;
		this.retainedLivekits = [config.voiceCall?.livekit, custom].filter((value): value is NonNullable<VoiceCallConfig['livekit']> => value != null);
		validateLiveKitVerificationKeys(voiceConfig.voiceCall?.livekit?.verificationKeys);
	}
	private async releaseDirectTokenLock(runner: QueryRunner, lock: string, locked: boolean): Promise<void> {
		try {
			if (locked) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1,1794232026))', [lock]);
		} catch (error) {
			// A failed unlock must not return a session holding an advisory lock to the pool.
			await (runner as unknown as { releasePostgresConnection(error: Error): Promise<void> }).releasePostgresConnection(new Error('Direct voice database unlock failed'));
			throw error;
		} finally { await runner.release(); }
	}
	/** A session-level lock serializes mint, admission and kick across application workers. */
	private async withDirectTokenLock<T>(roomId: string, identity: string, run: (runner: QueryRunner, digest: string) => Promise<T>): Promise<T> {
		const existing = this.participantLock.getStore();
		if (existing?.active && existing.roomId === roomId && existing.identity === identity) return run(existing.runner, existing.digest);
		const digest = createHash('sha256').update(identity).digest('hex');
		const lock = `direct-voice-token:${roomId}:${digest}`;
		const pool = (this.db.driver as unknown as { master?: pg.Pool }).master;
		if (!pool) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
		return withAdmission(pool, () => new VoiceRelayError('RATE_LIMITED', 429), async () => {
			const runner = this.db.createQueryRunner();
			await runner.connect();
			let locked = false;
			try {
				await runner.query('SELECT pg_advisory_lock(hashtextextended($1,1794232026))', [lock]);
				locked = true;
				const state = { roomId, identity, runner, digest, active: true };
				try { return await this.participantLock.run(state, () => run(runner, digest)); } finally { state.active = false; }
			} finally { await this.releaseDirectTokenLock(runner, lock, locked); }
		}, true);
	}
	public async withParticipantAdmission<T>(roomId: string, identity: string, authorize: () => Promise<boolean>, run: () => Promise<T>): Promise<T> {
		const digest = createHash('sha256').update(identity).digest('hex');
		const pool = (this.db.driver as unknown as { master?: pg.Pool }).master;
		if (!pool) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
		const observed = await withAdmission(pool, () => new VoiceRelayError('RATE_LIMITED', 429), () => this.db.query('INSERT INTO voice_token_generation(room_id,identity_digest,generation) VALUES($1,$2,$3) ON CONFLICT(room_id,identity_digest) DO UPDATE SET generation=voice_token_generation.generation RETURNING generation,pending', [roomId, digest, randomUUID()]), true);
		if (typeof observed[0]?.generation !== 'string') throw new VoiceRelayError('PARTICIPANT_REVOKED', 403);
		return this.withDirectTokenLock(roomId, identity, async (runner, lockedDigest) => {
			const current = await this.currentDirectGeneration(runner, roomId, lockedDigest);
			if (current.generation !== observed[0].generation || !await authorize()) throw new VoiceRelayError('PARTICIPANT_REVOKED', 403);
			if (current.pending) {
				// Keep the revoked generation until the SFU confirms removal, then recheck permissions.
				await this.removeFromSfu(roomId, identity);
				const cleared = await runner.query('UPDATE voice_token_generation SET pending=false WHERE room_id=$1 AND identity_digest=$2 AND generation=$3 AND pending=true RETURNING generation', [roomId, lockedDigest, current.generation]);
				if (cleared.length !== 1 || !await authorize()) throw new VoiceRelayError('PARTICIPANT_REVOKED', 403);
			}
			return run();
		});
	}
	private async currentDirectGeneration(runner: QueryRunner, roomId: string, digest: string): Promise<{ generation: string; pending: boolean }> {
		await runner.query('INSERT INTO voice_token_generation(room_id,identity_digest,generation) VALUES($1,$2,$3) ON CONFLICT(room_id,identity_digest) DO NOTHING', [roomId, digest, randomUUID()]);
		const rows = await runner.query('SELECT generation,pending FROM voice_token_generation WHERE room_id=$1 AND identity_digest=$2', [roomId, digest]);
		if (typeof rows[0]?.generation !== 'string') throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
		return { generation: rows[0].generation, pending: rows[0].pending === true };
	}
	public override get isEnabled(): boolean { return super.isEnabled || this.relay.isEnabled || this.relay.hasRetainedCalls; }
	public get isDirectEnabled(): boolean { return super.isEnabled; }
	private get hasRelayConfiguration(): boolean { return !!this.relay.providers?.length || this.relay.hasRetainedCalls === true; }
	public async refreshCapability(): Promise<void> {
		try { await this.relay.allProviders(); } catch (error) {
			if (!['42P01', '3F000'].includes((error as { code?: string }).code ?? '')) throw error;
		}
	}
	public onRelayChange(callback: (roomId: string) => void): void { this.relay.changes.on('change', callback); }
	private async relayCall(roomId: string): Promise<RelayCall | null> { return super.isEnabled ? this.relay.storage.directLock(`allocation:${roomId}`, () => this.relay.get(roomId)) : this.relay.get(roomId); }
	private async isLocalRoom(roomId: string): Promise<boolean> { if (!super.isEnabled) return false; const call = await this.relayCall(roomId); return !call || call.state === 'ended'; }
	public async isRoomUnavailable(roomId: string): Promise<boolean> { return this.hasRelayConfiguration && (await this.relayCall(roomId))?.unavailable === true; }
	public async relayCredentials(roomId: string, params: { identity: string; userId: string; canScreenShare: boolean }, getOwnIceServers?: () => Promise<IceServer[] | null>): Promise<{ token: string; iceServers: IceServer[] | null; mediaProvider: string; screenShareLimits?: ScreenShareLimits } | null> { if (!this.hasRelayConfiguration) return null; const call = await this.relayCall(roomId); if (call?.state !== 'active') return null; const own = getOwnIceServers ? await getOwnIceServers() : null; const result = await this.relay.join(roomId, { identity: params.identity, userId: params.userId, allowScreenShare: params.canScreenShare }, own !== null ? false : undefined); return { ...result, iceServers: own ?? result.iceServers }; }
	public async connectionInfo(roomId: string): Promise<{ mediaProvider?: string }> { if (!this.hasRelayConfiguration) return {}; const call = await this.relayCall(roomId); return call?.state === 'active' ? { mediaProvider: call.provider.origin } : {}; }
	public async relayRtc(url: string): Promise<RelayRtc | null> { return this.relay.rtc(url); }
	private async localRoom(roomId: string) {
		if (!super.isEnabled) return undefined;
		return (await this.roomService!.listRooms([this.roomNameOf(roomId)])).find(room => room.name === this.roomNameOf(roomId));
	}
	private directServer(): DirectServer | undefined {
		const livekit = this.voiceConfig.voiceCall?.livekit;
		return livekit ? this.directServerOf(livekit) : undefined;
	}
	private directServerOf(livekit: NonNullable<VoiceCallConfig['livekit']>): DirectServer {
		return { fingerprint: createHash('sha256').update(JSON.stringify([livekit.internalUrl, livekit.apiKey])).digest('hex') };
	}
	private async retainedRoomExists(roomId: string, direct: DirectCall): Promise<boolean | null> {
		let checked = false;
		let unavailable = false;
		for (const livekit of this.retainedLivekits) {
			if (direct.server && this.directServerOf(livekit).fingerprint !== direct.server.fingerprint) continue;
			try {
				const rooms = await new RoomServiceClient(livekit.internalUrl, livekit.apiKey, livekit.apiSecret).listRooms([this.roomNameOf(roomId)]);
				checked = true;
				if (rooms.some(room => room.name === this.roomNameOf(roomId))) return true;
			} catch {
				unavailable = true;
			}
		}
		return checked && !unavailable ? false : null;
	}
	public async retireEndedDirectRooms(): Promise<void> {
		if (!super.isEnabled || !this.hasRelayConfiguration) return;
		const storage = this.relay.storage;
		const rows = await storage.query("SELECT key FROM consumer_state WHERE key LIKE 'direct:%' AND value->>'state' IN ('active', 'pending')");
		for (const { key } of rows.rows as { key: string }[]) {
			const roomId = key.slice('direct:'.length);
			await storage.directLock(`allocation:${roomId}`, async () => {
				const direct = await storage.read<DirectCall>(key);
				if (!direct || direct.state === 'ended') return;
				const server = this.directServer();
				if (direct.server && direct.server.fingerprint !== server?.fingerprint) return;
				// Keep the allocation if the SFU cannot confirm that the room is gone.
				const room = await this.localRoom(roomId).catch(() => null);
				if (room === undefined) await storage.write(key, { ...direct, state: 'ended' });
				else if (room && server && !direct.server) await storage.write(key, { ...direct, server });
			});
		}
	}
	@bindThis
	public override async ensureRoom(roomId: string, maxParticipants: number): Promise<void> {
		if (!this.hasRelayConfiguration) return super.ensureRoom(roomId, maxParticipants);
		const storage = this.relay.storage;
		const lock = super.isEnabled ? storage.directLock.bind(storage) : storage.lock.bind(storage);
		await lock(`allocation:${roomId}`, async () => {
			const direct = await this.relay.storage.read<DirectCall>(`direct:${roomId}`), call = await this.relay.get(roomId);
			if (call && call.state !== 'ended') { await this.relay.ensure(roomId, maxParticipants); return; }
			if (!super.isEnabled && direct && direct.state !== 'ended') {
				if (await this.retainedRoomExists(roomId, direct) !== false) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
				await storage.write(`direct:${roomId}`, { ...direct, state: 'ended' });
				await this.relay.ensure(roomId, maxParticipants);
				return;
			}
			const local = direct?.state === 'pending' ? undefined : await this.localRoom(roomId);
			if (direct?.state === 'pending' || local) {
				const slots = direct?.state === 'pending' || direct?.state === 'active' ? direct.slots : local?.maxParticipants ?? maxParticipants;
				await super.ensureRoom(roomId, slots);
				await this.relay.storage.write(`direct:${roomId}`, { generation: direct?.generation ?? randomUUID(), state: 'active', slots, server: direct?.server ?? this.directServer() });
				return;
			}
			if (direct?.state === 'active' && !super.isEnabled) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
			if (direct?.state === 'active') await this.relay.storage.write(`direct:${roomId}`, { ...direct, state: 'ended' });
			if (!super.isEnabled || this.voiceConfig.voiceCall?.preferRelay && this.relay.isEnabled) { await this.relay.ensure(roomId, maxParticipants); return; }
			const next: DirectCall = { generation: randomUUID(), state: 'pending', slots: maxParticipants, server: this.directServer() };
			await this.relay.storage.write(`direct:${roomId}`, next); await super.ensureRoom(roomId, maxParticipants); next.state = 'active'; await this.relay.storage.write(`direct:${roomId}`, next);
		});
	}
	@bindThis
	public override async createJoinToken(params: { roomId: string; identity: string; userId: string; canScreenShare: boolean }): Promise<string> {
		const result = await this.relayCredentials(params.roomId, params);
		if (result) return result.token;
		return this.withDirectTokenLock(params.roomId, params.identity, async (runner, digest) => {
			const current = await this.currentDirectGeneration(runner, params.roomId, digest);
			if (current.pending) throw new VoiceRelayError('DIRECT_REMOVAL_PENDING');
			const room = await this.localRoom(params.roomId);
			if (!room) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
			const maxParticipants = room.maxParticipants || this.settings?.voiceCallMaxParticipants || 10;
			return super.createJoinToken({ ...params, voiceSessionGeneration: current.generation, maxParticipants });
		});
	}
	@bindThis
	public override async listParticipants(roomId: string): Promise<LiveKitParticipant[]> { if (!this.hasRelayConfiguration || await this.isLocalRoom(roomId)) return super.listParticipants(roomId); const result = await this.relay.participants(roomId); return result ?? (super.isEnabled ? super.listParticipants(roomId) : []); }
	@bindThis
	public override async setParticipantStatus(roomId: string, identity: string, sessionId: string, status: { micMuted: boolean; deafened: boolean }): Promise<boolean> { if (!this.hasRelayConfiguration || await this.isLocalRoom(roomId)) return super.setParticipantStatus(roomId, identity, sessionId, status); const accepted = await this.relay.participant(roomId, 'status', { identity, sessionId, ...status }); return accepted ?? (super.isEnabled ? super.setParticipantStatus(roomId, identity, sessionId, status) : false); }
	@bindThis
	public override async removeParticipant(roomId: string, identity: string): Promise<void> {
		if (!this.isEnabled) return;
		return this.withDirectTokenLock(roomId, identity, async (runner, digest) => {
			// Commit revocation before invoking either SFU; failed removal remains pending.
			await runner.query('INSERT INTO voice_token_generation(room_id,identity_digest,generation,pending) VALUES($1,$2,$3,true) ON CONFLICT(room_id,identity_digest) DO UPDATE SET generation=EXCLUDED.generation,pending=true', [roomId, digest, randomUUID()]);
			await this.removeFromSfu(roomId, identity);
			await runner.query('UPDATE voice_token_generation SET pending=false WHERE room_id=$1 AND identity_digest=$2', [roomId, digest]);
		});
	}
	private async removeFromSfu(roomId: string, identity: string): Promise<void> {
		if (!this.hasRelayConfiguration || await this.isLocalRoom(roomId)) {
			if (!super.isEnabled) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
			await super.removeParticipant(roomId, identity);
		} else {
			const accepted = await this.relay.participant(roomId, 'kick', { identity });
			if (accepted == null) throw new VoiceRelayError('PROVIDER_UNAVAILABLE');
		}
	}
	@bindThis
	public override async muteMicrophone(roomId: string, identity: string): Promise<void> { if (!this.hasRelayConfiguration || await this.isLocalRoom(roomId)) return super.muteMicrophone(roomId, identity); const accepted = await this.relay.participant(roomId, 'mute', { identity }); if (accepted == null && super.isEnabled) await super.muteMicrophone(roomId, identity); }
	@bindThis
	public override async deleteRoom(roomId: string): Promise<void> {
		if (!this.hasRelayConfiguration) return super.deleteRoom(roomId);
		const storage = this.relay.storage;
		const lock = super.isEnabled ? storage.directLock.bind(storage) : storage.lock.bind(storage);
		await lock(`allocation:${roomId}`, async () => {
			const call = await this.relay.get(roomId);
			if (call && call.state !== 'ended') await this.relay.end(roomId);
			if (super.isEnabled) { await super.deleteRoom(roomId); const direct = await this.relay.storage.read<DirectCall>(`direct:${roomId}`); if (direct) await this.relay.storage.write(`direct:${roomId}`, { ...direct, state: 'ended' }); }
		});
	}
 public async withRtcAdmission<T>(rawUrl: string, connect: (route: RelayRtc | null) => Promise<T>, remoteAddress = 'unknown', authorize?: (roomId: string, participant: RtcParticipant) => Promise<boolean>): Promise<T> {
		const input = new URL(rawUrl, this.voiceConfig.url), token = input.searchParams.get('access_token');
		if (!token || token.length > 16384 || input.searchParams.getAll('access_token').length !== 1) throw new VoiceRelayError('FORBIDDEN', 403);
		const authorizeToken = async (roomId: string): Promise<void> => {
			if (!authorize) return;
			const participant = participantOfVerifiedToken(token);
			if (!participant || !await authorize(roomId, participant)) throw new VoiceRelayError('FORBIDDEN', 403);
		};
		const config = this.voiceConfig.voiceCall?.livekit;
		if (config) {
			let roomId: string | null = null;
			try { const claims = await verifyLiveKitToken(token, config, config.verificationKeys); roomId = typeof claims.video?.room === 'string' && claims.video.roomJoin === true ? this.roomIdOf(claims.video.room) : null; } catch {}
			if (roomId) {
				const participant = participantOfVerifiedToken(token);
				let generation: unknown;
				try { const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); generation = JSON.parse(payload.metadata).voiceSessionGeneration; } catch {}
				if (!participant || typeof generation !== 'string') throw new VoiceRelayError('FORBIDDEN', 403);
				const id = roomId;
				return this.withDirectTokenLock(id, participant.identity, async (runner, digest) => {
					const current = await this.currentDirectGeneration(runner, id, digest);
					if (current.pending || generation !== current.generation) throw new VoiceRelayError('FORBIDDEN', 403);
					await authorizeToken(id);
					if (!this.hasRelayConfiguration) {
						if (!await this.localRoom(id)) await super.ensureRoom(id, this.settings?.voiceCallMaxParticipants ?? 10);
						return connect(null);
					}
					return this.relay.storage.directLock(`allocation:${id}`, async () => {
						const remote = await this.relay.get(id), direct = await this.relay.storage.read<DirectCall>(`direct:${id}`);
						if (remote && remote.state !== 'ended' || direct?.state === 'ended') throw new VoiceRelayError('FORBIDDEN', 403);
						if (!await this.localRoom(id)) await super.ensureRoom(id, direct?.slots ?? this.settings?.voiceCallMaxParticipants ?? 10);
						return connect(null);
					});
				});
			}
		}
  let budget = this.rtcIpBudget.get(remoteAddress);
  if (!budget || Date.now() - budget.started >= 60000) { budget = { started: Date.now(), count: 0 }; if (this.rtcIpBudget.size >= 4096) this.rtcIpBudget.delete(this.rtcIpBudget.keys().next().value!); this.rtcIpBudget.set(remoteAddress, budget); }
  if (++budget.count > 600) throw new VoiceRelayError('RATE_LIMITED', 429);
  return withAdmission(this.relay.storage.pool, () => new VoiceRelayError('RATE_LIMITED', 429), async () => {
			const route = await this.relay.rtc(rawUrl); if (!route) throw new VoiceRelayError('FORBIDDEN', 403);
			return this.relay.storage.lock(`allocation:${route.roomId}`, async () => { const current = await this.relay.get(route.roomId); if (!current || current.state !== 'active' || current.generation !== route.generation || current.remoteId !== route.remoteId) throw new VoiceRelayError('FORBIDDEN', 403); await authorizeToken(route.roomId); return connect(route); });
		});
	}
}
