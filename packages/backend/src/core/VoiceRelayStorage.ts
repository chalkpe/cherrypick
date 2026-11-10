/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { withAdmission } from '@/core/voice-relay/admission.js';
import { VoiceRelayError } from '@/core/voice-relay/error.js';
@Injectable()
export class VoiceRelayStorage implements OnApplicationShutdown {
	public readonly pool: pg.Pool;
	private directPool?: pg.Pool;
	private readonly directOptions: pg.PoolConfig;
	private connection = new AsyncLocalStorage<{ client: pg.PoolClient; broken?: Error }>();
	constructor(@Inject(DI.config) config: Config) {
		this.directOptions = { ...config.db.extra, host: config.db.host, port: config.db.port, database: config.db.db, user: config.db.user, password: config.db.pass, options: `-c search_path=voice_relay -c lock_timeout=5000 ${config.db.extra?.options ?? ''}`, max: 6, connectionTimeoutMillis: 10000 };
		this.pool = new pg.Pool(this.directOptions);
		this.pool.on('error', () => { console.error('Voice relay database idle connection failed'); });
	}
	query(text: string, values?: unknown[]) { return (this.connection.getStore()?.client ?? this.pool).query(text, values); }
	async read<T>(key: string): Promise<T | null> { const result = await this.query('SELECT value FROM consumer_state WHERE key=$1', [key]); return result.rows[0]?.value ?? null; }
	async write(key: string, value: unknown): Promise<void> { await this.query('INSERT INTO consumer_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()', [key, JSON.stringify(value)]); }
	async lock<T>(key: string, run: () => Promise<T>): Promise<T> {
		return withAdmission(this.pool, () => new VoiceRelayError('RATE_LIMITED', 429), () => this.lockWithPermit(key, run), true);
	}
	async directLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		if (!this.directPool) { this.directPool = new pg.Pool(this.directOptions); this.directPool.on('error', () => { console.error('Voice relay direct database idle connection failed'); }); }
		return this.lockWithPermit(key, run, this.directPool);
	}
	private async lockWithPermit<T>(key: string, run: () => Promise<T>, pool = this.pool): Promise<T> {
		const existing = this.connection.getStore();
		const state = existing ?? { client: await pool.connect(), broken: undefined as Error | undefined };
		const onError = () => { state.broken = new Error('Voice relay database connection failed'); };
		if (!existing) state.client.on('error', onError);
		let locked = false;
		let failed = false;
		const unlock = async () => {
			try { await state.client.query('SELECT pg_advisory_unlock(hashtextextended($1,1794232026))', [key]); } catch (error) { state.broken = new Error('Voice relay database unlock failed'); if (!failed) throw error; }
		};
		try {
			await state.client.query('SELECT pg_advisory_lock(hashtextextended($1,1794232026))', [key]); locked = true;
			return await this.connection.run(state, run);
		} catch (error) { failed = true; throw error; } finally {
			try {
				if (locked) await unlock();
			} finally {
				if (!existing) { state.client.release(state.broken); state.client.removeListener('error', onError); }
			}
		}
	}
	async onApplicationShutdown(): Promise<void> { await Promise.all([this.pool.end(), this.directPool?.end()]); }
}
