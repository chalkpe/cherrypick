/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { expect, test } from 'vitest';
import type { Config } from '@/config.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import { VoiceRelayClient } from '@/core/VoiceRelayClient.js';
import type { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import type { RelayProvider } from '@/core/voice-relay/selection.js';

const issuer = 'https://consumer.test';
const audience = 'https://provider.test';
const secret = 'x'.repeat(48);
const provider: RelayProvider = { id: 'p', origin: audience, enabled: true, validated: true };

// This verifier models the public JWT contract, not a running relay server.
async function verifyContract(token: string, expectedIssuer: string, expectedAudience: string, key: string): Promise<void> {
 const header = decodeProtectedHeader(token);
 if (header.alg !== 'HS256' || header.typ !== 'voice-relay-client+jwt' || Object.keys(header).length !== 2) throw new Error('invalid header');
 const { payload } = await jwtVerify(token, new TextEncoder().encode(key), { algorithms: ['HS256'], issuer: expectedIssuer, audience: expectedAudience, requiredClaims: ['iat', 'exp'], maxTokenAge: 60, clockTolerance: 5 });
 if (payload.aud !== expectedAudience || payload.sub !== undefined || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat === undefined || payload.exp === undefined || payload.exp <= payload.iat || payload.exp - payload.iat > 60) throw new Error('invalid claims');
}

test('consumer issues the domain JWT accepted by the relay protocol', async () => {
 const config = { url: `${issuer}/some/path` } as Config;
 const http = {} as HttpRequestService;
 const storage = { read: async () => secret } as unknown as VoiceRelayStorage;
 const client = new VoiceRelayClient(config, http, storage);
 const headers = await client.headers(provider, 'POST', '/voice-relay/v1/capacity');
 expect(Object.keys(headers).sort()).toEqual(['authorization']);
 const token = headers.authorization.slice('Bearer '.length);
 await expect(verifyContract(token, issuer, audience, secret)).resolves.toBeUndefined();
 await expect(verifyContract(token, 'https://other.test', audience, secret)).rejects.toThrow();
 await expect(verifyContract(token, issuer, 'https://other.test', secret)).rejects.toThrow();
 await expect(verifyContract(token, issuer, audience, 'z'.repeat(48))).rejects.toThrow();
});
