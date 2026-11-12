/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type RecordingEvent = { id: string; identity: string; recording: boolean; updatedAt: number; deliveryWindowMs: number };
export type RecordingStatus = { micMuted: boolean; deafened: boolean; recording?: boolean; recordingId?: string };

// Redis EX를 32비트 양수 범위로 제한하고, 방마다 보관하는 ID 수도 제한한다.
export const MAX_RECORDING_TTL_SECONDS = 2_147_483_647;
export const MAX_RECORDING_IDS = 4096;
const MAX_WINDOW_MS = (MAX_RECORDING_TTL_SECONDS - 1) * 1000;
const CLOCK_SKEW_MS = 300_000;
const JOB_RETENTION_MS = 7 * 86_400_000;
export const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// QueueProcessorService의 최대 jitter(20%)와 8시간 backoff 상한을 적용한다.
// queueRetryJob은 attemptsMade를 초기화하지 않는다. 실패 작업의 보관 기간은 운영자가 한 번 다시 실행할 수 있는 여유이며,
// 자동 재시도 전체를 다시 곱하지 않는다. 무기한 pause나 반복 수동 재실행은 이벤트 수명을 연장하지 않는다.
export function recordingDeliveryWindowMs(attempts = 12): number {
	if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('Invalid recording delivery attempts');
	let delay = 0;
	for (let n = 1; n <= Math.min(attempts - 1, 9); n++) delay += Math.ceil(Math.min((2 ** n - 1) * 60_000, 8 * 3_600_000) * 1.2);
	delay += Math.max(0, attempts - 10) * 8 * 3_600_000 * 1.2;
	const window = Math.ceil(delay + attempts * 5000 + JOB_RETENTION_MS + 5000);
	if (!Number.isSafeInteger(window) || window > MAX_WINDOW_MS) throw new RangeError('Recording delivery window exceeds the storage limit');
	return window;
}

export function recordingRetentionSeconds(deliveryWindowMs: number, inboxAttempts = 8): number {
	const window = deliveryWindowMs + recordingDeliveryWindowMs(inboxAttempts) + CLOCK_SKEW_MS;
	if (!Number.isSafeInteger(window) || window > MAX_WINDOW_MS) throw new RangeError('Recording event lifetime exceeds the storage limit');
	return Math.ceil(window / 1000) + 1;
}

export function recordingEventDeadline(event: RecordingEvent, inboxAttempts = 8): number {
	const window = (recordingRetentionSeconds(event.deliveryWindowMs, inboxAttempts) - 1) * 1000;
	const deadline = event.updatedAt + window;
	if (!Number.isSafeInteger(window) || window > MAX_WINDOW_MS || !Number.isSafeInteger(deadline)) throw new RangeError('Recording event lifetime exceeds the storage limit');
	return deadline;
}

export function parseRecordingEvent(value: unknown, now = Date.now(), inboxAttempts = 8): RecordingEvent | null {
	if (typeof value !== 'object' || value == null) return null;
	const { id, identity, recording, updatedAt, deliveryWindowMs } = value as Record<string, unknown>;
	if (typeof id !== 'string' || !RECORDING_ID.test(id) || typeof identity !== 'string' || identity.length > 2048 || typeof recording !== 'boolean') return null;
	if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt > now + CLOCK_SKEW_MS) return null;
	if (typeof deliveryWindowMs !== 'number' || !Number.isSafeInteger(deliveryWindowMs) || deliveryWindowMs <= 0 || deliveryWindowMs > MAX_WINDOW_MS) return null;
	const event = { id, identity, recording, updatedAt, deliveryWindowMs };
	try {
		const deadline = recordingEventDeadline(event, inboxAttempts);
		if (deadline < now || deadline - now > MAX_WINDOW_MS) return null;
		const uri = new URL(identity);
		if (!['https:', 'http:'].includes(uri.protocol) || uri.username || uri.password) return null;
	} catch { return null; }
	return event;
}

export type RecordingBinding = {
	clientId: string;
	roomId: string;
	identity: string;
	sessionId: string;
	start: RecordingEvent;
	stop?: RecordingEvent;
	startSent?: boolean;
	stopSent?: boolean;
};

// 세션 검증 후, 인증된 identity/room/session과 서버 시각으로만 전환을 만든다.
// KEYS: ID 결속, 세션의 활성 ID, 소유권 잠금, 미완료 목록, 보관 목록, sweep 목록.
// ARGV: 잠금 토큰, 방, identity, session, 클라이언트 ID, 시작 여부, 시각, TTL, 서버 이벤트 ID, 배송 예산, ID 상한.
export const PREPARE_RECORDING_EVENT_SCRIPT = `-- PREPARE_RECORDING_EVENT
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return '' end
local raw = redis.call('GET', KEYS[1])
local binding = raw and cjson.decode(raw) or nil
if binding and (binding.roomId ~= ARGV[2] or binding.identity ~= ARGV[3] or binding.sessionId ~= ARGV[4]) then return '' end
local starting = ARGV[6] == '1'
local active = redis.call('GET', KEYS[2])
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[7])
if not binding and redis.call('ZCARD', KEYS[5]) >= tonumber(ARGV[11]) then return '' end
if starting and ((binding and binding.stop) or (active and active ~= ARGV[5])) then return '' end
if not binding then
	if not starting then return '' end
	binding = {clientId=ARGV[5], roomId=ARGV[2], identity=ARGV[3], sessionId=ARGV[4], start={id=ARGV[9], identity=ARGV[3], recording=true, updatedAt=tonumber(ARGV[7]), deliveryWindowMs=tonumber(ARGV[10])}}
end
if starting then
	redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[8])
else
	if not binding.stop then binding.stop = {id=binding.start.id, identity=ARGV[3], recording=false, updatedAt=math.max(tonumber(ARGV[7]), binding.start.updatedAt + 1), deliveryWindowMs=math.max(binding.start.deliveryWindowMs, tonumber(ARGV[10]))} end
	if active == ARGV[5] then redis.call('DEL', KEYS[2]) end
end
redis.call('ZADD', KEYS[5], tonumber(ARGV[7]) + tonumber(ARGV[8]) * 1000, ARGV[5])
local latest = redis.call('ZREVRANGE', KEYS[5], 0, 0, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[5], math.max(1000, tonumber(latest[2]) - tonumber(ARGV[7])))
redis.call('SADD', KEYS[6], ARGV[2])
redis.call('SADD', KEYS[4], ARGV[5])
redis.call('EXPIRE', KEYS[4], ARGV[8])
local result = cjson.encode(binding)
redis.call('SET', KEYS[1], result, 'EX', ARGV[8])
return result
`;

export const MARK_RECORDING_EVENT_SENT_SCRIPT = `-- MARK_RECORDING_EVENT_SENT
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local binding = cjson.decode(raw)
binding[ARGV[2]] = true
redis.call('SET', KEYS[1], cjson.encode(binding), 'EX', ARGV[3])
return 1
`;

// 방당 고정 개수의 ID에 두 전환 비트를 보관한다. start가 보관된 ID의 stop은 상한에 걸리지 않는다.
// KEYS: 만료 시각 sorted set, 전환 비트 hash. ARGV: ID, 전환 비트, 현재 시각, 수락 기한, ID 상한.
export const CLAIM_RECORDING_EVENT_SCRIPT = `-- CLAIM_RECORDING_EVENT
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
for _, id in ipairs(expired) do redis.call('HDEL', KEYS[2], id); redis.call('ZREM', KEYS[1], id) end
local flags = tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or 0
local transition = tonumber(ARGV[2])
if bit.band(flags, transition) ~= 0 then return 0 end
if flags == 0 and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return -1 end
redis.call('HSET', KEYS[2], ARGV[1], bit.bor(flags, transition))
local previous = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1])) or 0
redis.call('ZADD', KEYS[1], math.max(previous, tonumber(ARGV[4]) + 1000), ARGV[1])
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local ttl = math.max(1000, tonumber(latest[2]) - tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
return 1
`;

export const RENEW_ACTIVE_RECORDING_SCRIPT = `-- RENEW_ACTIVE_RECORDING
local raw = redis.call('GET', KEYS[1])
if not raw or redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local binding = cjson.decode(raw)
if binding.stop then return 0 end
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ARGV[2]) end
redis.call('ZADD', KEYS[4], tonumber(ARGV[3]) + tonumber(ARGV[2]) * 1000, ARGV[1])
local latest = redis.call('ZREVRANGE', KEYS[4], 0, 0, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[4], math.max(1000, tonumber(latest[2]) - tonumber(ARGV[3])))
return 1
`;
