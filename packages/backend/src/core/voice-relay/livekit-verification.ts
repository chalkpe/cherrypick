/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { decodeProtectedHeader } from 'jose';
import { TokenVerifier } from 'livekit-server-sdk';

export type LiveKitVerificationKey = { apiKey: string; apiSecret: string };

export function validateLiveKitVerificationKeys(keys: unknown): asserts keys is LiveKitVerificationKey[] | undefined {
 if (keys === undefined) return;
 if (!Array.isArray(keys) || keys.some(key => key == null || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).some(name => name !== 'apiKey' && name !== 'apiSecret') || typeof key.apiKey !== 'string' || key.apiKey.length === 0 || typeof key.apiSecret !== 'string' || key.apiSecret.length < 32)) throw new Error('Invalid LiveKit verification keys');
}

export async function verifyLiveKitToken(token: string, active: LiveKitVerificationKey, additional?: LiveKitVerificationKey[]) {
 if (decodeProtectedHeader(token).typ === 'voice-relay-client+jwt') throw new Error('Client authentication token is not a LiveKit token');
 for (const { apiKey, apiSecret } of [active, ...(additional ?? [])]) {
  try { return await new TokenVerifier(apiKey, apiSecret).verify(token); } catch { /* Try the next explicitly trusted key. */ }
 }
 throw new Error('Invalid LiveKit token');
}
