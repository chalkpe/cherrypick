/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class VoiceRelayError extends Error { constructor(public code: string, public status = 503) { super(code); } }
