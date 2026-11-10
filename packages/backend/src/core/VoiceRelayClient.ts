/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { SignJWT } from 'jose';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import type { RelayProvider } from '@/core/voice-relay/selection.js';
import { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { VoiceRelayError } from '@/core/voice-relay/error.js';
export { VoiceRelayError } from '@/core/voice-relay/error.js';
export function publicOrigin(origin: string): string { const url = new URL(origin); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== origin || /^\[|^[\d.]+$/.test(url.hostname) || (url.hostname.toLowerCase().replace(/\.$/, '') === 'localhost' || url.hostname.toLowerCase().replace(/\.$/, '').endsWith('.localhost'))) throw new VoiceRelayError('INVALID_PROVIDER', 400); return url.origin; }
@Injectable()
export class VoiceRelayClient {
	constructor(@Inject(DI.config) private config: Config, public http: HttpRequestService, @Optional() private storage?: VoiceRelayStorage) {}
	public originOf(origin: string): string { return publicOrigin(origin); }
	public async headers(provider: RelayProvider, _method: string, _path: string, body = ''): Promise<Record<string, string>> {
		this.originOf(provider.origin);
		const secretKey = provider.credentialVersion ? `provider-secret:${encodeURIComponent(provider.id)}:${provider.credentialVersion}` : `provider-secret:${provider.id}`;
		const secret = await this.storage?.read<string>(secretKey); if (!secret || secret.length < 32) throw new VoiceRelayError('MISSING_KEY', 400);
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'voice-relay-client+jwt' }).setIssuer(this.originOf(new URL(this.config.url).origin)).setAudience(provider.origin).setIssuedAt(now).setExpirationTime(now + 60).sign(new TextEncoder().encode(secret));
		return { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) };
	}
	public async request<T>(provider: RelayProvider, method: string, path: string, data?: unknown): Promise<T> {
		const body = data === undefined ? '' : JSON.stringify(data);
		try {
			const response = await this.http.send(`${this.originOf(provider.origin)}${path}`, { method, headers: await this.headers(provider, method, path, body), ...(body ? { body } : {}), redirect: 'manual', timeout: 10000, size: 65536 }, { throwErrorWhenResponseNotOk: false });
			const value = await response.json() as Record<string, unknown>;
			if (!response.ok) throw new VoiceRelayError(typeof value.code === 'string' ? value.code : 'PROVIDER_UNAVAILABLE', response.status);
			if (!value || typeof value !== 'object') throw new VoiceRelayError('INVALID_RESPONSE'); return value as T;
		} catch (error) { if (error instanceof VoiceRelayError) throw error; throw new VoiceRelayError('PROVIDER_UNAVAILABLE'); }
	}
}
