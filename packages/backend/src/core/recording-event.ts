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
	// 승인 배달이 일부 대상에게만 접수된 실패. 시작을 이미 받은 대상의 종료를 마저 보내야 하므로 결속을 남기되,
	// 승인받지 못한 시작을 새 대상에게 다시 발행하지 않도록 표시한다 (startSent와 달리 배지를 켜지 않는다).
	startPartial?: boolean;
	stopSent?: boolean;
};

// 일부 대상에게는 이미 고지가 접수된 배달 실패. 전혀 접수되지 않은 실패와 달리 결속을 폐기하면 안 된다.
export class PartialRecordingDeliveryError extends Error {
	constructor(cause: unknown) {
		super('Recording delivery partially succeeded', { cause });
		this.name = 'PartialRecordingDeliveryError';
	}
}

// 보관 목록이 상한에 차면 가장 오래된 항목을 축출한다. 보관 목록은 읽히지 않고 수명 계산에만 쓰이며,
// 재시작 방지와 소유권은 결속·활성 키가 지키므로 축출은 안전하다. 축출된 결속은 종료까지 배달한 (stopSent) 경우에만
// 함께 지워 방별 결속 자원을 상한 안에 묶는다. 활성·미전달 결속은 flush의 종료 배달과 소유권 검사가 아직 필요하므로
// 지우지 않고 TTL 만료에 맡긴다.
const EVICT_RECORDING_HISTORY_FUNCTION = `
local function evictRecordingHistory(historyKey, capacity, bindingPrefix)
	if redis.call('ZCARD', historyKey) < capacity then return end
	local oldest = redis.call('ZRANGE', historyKey, 0, 0)
	if not oldest[1] then return end
	redis.call('ZREM', historyKey, oldest[1])
	local raw = redis.call('GET', bindingPrefix .. oldest[1])
	if raw and cjson.decode(raw).stopSent then redis.call('DEL', bindingPrefix .. oldest[1]) end
end
`;

// 세션 검증 후, 인증된 identity/room/session과 서버 시각으로만 전환을 만든다.
// KEYS: ID 결속, 세션의 활성 ID, 소유권 잠금, 미완료 목록, 보관 목록, sweep 목록.
// ARGV: 잠금 토큰, 방, identity, session, 클라이언트 ID, 시작 여부, 시각, TTL, 서버 이벤트 ID, 배송 예산, ID 상한.
export const PREPARE_RECORDING_EVENT_SCRIPT = `-- PREPARE_RECORDING_EVENT
${EVICT_RECORDING_HISTORY_FUNCTION}
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return '' end
local raw = redis.call('GET', KEYS[1])
local binding = raw and cjson.decode(raw) or nil
if binding and (binding.roomId ~= ARGV[2] or binding.identity ~= ARGV[3] or binding.sessionId ~= ARGV[4]) then return '' end
local starting = ARGV[6] == '1'
local active = redis.call('GET', KEYS[2])
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[7])
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
-- 상한에 차면 신규 녹음을 거부하는 대신 가장 오래된 보관 항목을 축출한다. 기존 ID의 재삽입 (축출된 ID의 종료·갱신)도
-- 같은 상한을 지키며, 이미 목록에 있는 ID는 축출 없이 점수만 갱신한다. 거부가 끝난 뒤에만 축출하므로 거부된 시도는 목록을 바꾸지 않는다.
if not redis.call('ZSCORE', KEYS[5], ARGV[5]) then evictRecordingHistory(KEYS[5], tonumber(ARGV[11]), string.sub(KEYS[1], 1, #KEYS[1] - #ARGV[5])) end
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

// 승인 배달이 실패해 시작을 아직 보내지 못한 결속은 폐기한다. 이미 시작을 보낸 (startSent) 결속과 일부 대상에게라도 접수된 (startPartial) 결속은
// flush가 종료를 마저 보내도록 남긴다. 잠금 토큰과 클라이언트 ID가 모두 일치할 때만 지워, 잠금이 만료된 사이 다른 요청이 만든 결속을 건드리지 않는다.
// KEYS: ID 결속, 세션의 활성 ID, 소유권 잠금, 미완료 목록, 보관 목록. ARGV: 잠금 토큰, 클라이언트 ID.
export const ABORT_UNSENT_RECORDING_SCRIPT = `-- ABORT_UNSENT_RECORDING
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local binding = cjson.decode(raw)
if binding.startSent or binding.startPartial or binding.clientId ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
redis.call('SREM', KEYS[4], ARGV[2])
redis.call('ZREM', KEYS[5], ARGV[2])
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

const PUBLICATION_ARGUMENTS_SCRIPT = `
local id, transition = ARGV[1], tonumber(ARGV[2])
local now, deadline, capacity = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
if #id == 0 or #id > 128 or not now or not deadline or not capacity or (transition ~= 1 and transition ~= 2) or capacity < 1 or capacity > ${MAX_RECORDING_IDS} or capacity ~= math.floor(capacity) then
	return redis.error_reply('ERR Invalid recording publication arguments')
end
deadline = deadline + 1000
if now ~= now or deadline ~= deadline or math.abs(now) > 9007199254740991 or math.abs(deadline) > 9007199254740991 or now ~= math.floor(now) or deadline ~= math.floor(deadline) or deadline <= now or deadline - now > ${MAX_RECORDING_TTL_SECONDS * 1000} then
	return redis.error_reply('ERR Invalid recording publication lifetime')
end
local function permitted(commands)
	for _, command in ipairs(commands) do
		if not redis.acl_check_cmd(unpack(command)) then return false end
	end
	return true
end
`;

// pending을 먼저 쓰고 seen을 쓴다. 중간 오류가 나도 미발행 전환을 완료 기록으로 오인하지 않는다.
// KEYS: 기존 기한 sorted set, 기존 seen hash, pending hash. ARGV: ID, 전환 비트, 현재 시각, 수락 기한, ID 상한.
export const PREPARE_RECORDING_PUBLICATION_SCRIPT = `#!lua
-- PREPARE_RECORDING_PUBLICATION
${PUBLICATION_ARGUMENTS_SCRIPT}
local kinds = {'zset', 'hash', 'hash'}
for i, expected in ipairs(kinds) do
	local kind = redis.call('TYPE', KEYS[i]).ok
	if kind ~= 'none' and kind ~= expected then return redis.error_reply('WRONGTYPE Recording publication state') end
end
if not permitted({
	{'HGET', KEYS[2], id}, {'HGET', KEYS[3], id},
	{'HDEL', KEYS[2], id}, {'HDEL', KEYS[3], id}, {'ZREM', KEYS[1], id},
	{'ZADD', KEYS[1], '1', id}, {'PEXPIRE', KEYS[1], '1000'},
	{'HSET', KEYS[3], id, '1'}, {'PEXPIRE', KEYS[3], '1000'},
	{'HSET', KEYS[2], id, '1'}, {'PEXPIRE', KEYS[2], '1000'},
	{'ZRANGEBYSCORE', KEYS[1], '-inf', now}, {'ZSCORE', KEYS[1], id},
	{'ZCARD', KEYS[1]}, {'ZREVRANGE', KEYS[1], '0', '0', 'WITHSCORES'}, {'ZRANGE', KEYS[1], '0', '0'}
}) then return redis.error_reply('NOPERM Recording publication preparation') end
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, old in ipairs(expired) do
	redis.call('HDEL', KEYS[2], old)
	redis.call('HDEL', KEYS[3], old)
	redis.call('ZREM', KEYS[1], old)
end
local flags = tonumber(redis.call('HGET', KEYS[2], id)) or 0
local pending = tonumber(redis.call('HGET', KEYS[3], id)) or 0
if bit.band(flags, transition) ~= 0 and bit.band(pending, transition) == 0 then return 0 end
local previous = tonumber(redis.call('ZSCORE', KEYS[1], id))
-- 상한에 차면 신규 이벤트를 거부하는 대신 기한이 가장 이른 seen 항목을 축출한다. seen은 유한 중복 억제 캐시이므로,
-- 축출은 아주 오래된 이벤트의 재알림을 허용할 뿐 신규 알림 유실보다 낫다.
if not previous and redis.call('ZCARD', KEYS[1]) >= capacity then
	local oldest = redis.call('ZRANGE', KEYS[1], 0, 0)
	if oldest[1] then
		redis.call('HDEL', KEYS[2], oldest[1])
		redis.call('HDEL', KEYS[3], oldest[1])
		redis.call('ZREM', KEYS[1], oldest[1])
	end
end
redis.call('ZADD', KEYS[1], math.max(previous or 0, deadline), id)
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local ttl = math.max(1000, tonumber(latest[2]) - now)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('HSET', KEYS[3], id, bit.bor(pending, transition))
redis.call('PEXPIRE', KEYS[3], ttl)
redis.call('HSET', KEYS[2], id, bit.bor(flags, transition))
redis.call('PEXPIRE', KEYS[2], ttl)
return bit.band(pending, transition) ~= 0 and 2 or 1
`;

// 일반 Redis와 다른 PubSub Redis에서도 쓸 수 있다. 방당 최대 4096개 ID의 두 비트와 기한을 한 값으로 보관한다.
// SET 전에 JSON·타입·권한을 검사하고, PUBLISH 뒤에는 실패할 수 있는 저장 명령을 두지 않는다.
// Redis 7의 기본 script flag는 진입 시 OOM을 거절한다. allow-oom을 켜지 않는다.
// KEYS: 방의 발행 기록. ARGV: ID, 전환 비트, 현재 시각, 수락 기한, ID 상한, main envelope 문자열 배열, PubSub 채널.
export const PUBLISH_RECORDING_EVENT_SCRIPT = `#!lua
-- PUBLISH_RECORDING_EVENT
${PUBLICATION_ARGUMENTS_SCRIPT}
local messages = cjson.decode(ARGV[6])
if type(messages) ~= 'table' then return redis.error_reply('ERR Invalid recording messages') end
local messageCount = 0
for index, message in pairs(messages) do
	if type(index) ~= 'number' or index < 1 or index ~= math.floor(index) or type(message) ~= 'string' then return redis.error_reply('ERR Invalid recording message') end
	messageCount = messageCount + 1
	if not redis.acl_check_cmd('PUBLISH', ARGV[7], message) then return redis.error_reply('NOPERM Recording publication') end
end
if messageCount ~= #messages then return redis.error_reply('ERR Invalid recording message array') end
local raw = redis.call('GET', KEYS[1])
local entries = raw and cjson.decode(raw) or {}
if type(entries) ~= 'table' then return redis.error_reply('ERR Invalid recording publication ledger') end
local count, latest = 0, deadline
for old, held in pairs(entries) do
	if type(held) ~= 'table' or type(held.flags) ~= 'number' or held.flags < 0 or held.flags > 3 or held.flags ~= math.floor(held.flags) or type(held.deadline) ~= 'number' or held.deadline ~= math.floor(held.deadline) or held.deadline - now > ${MAX_RECORDING_TTL_SECONDS * 1000} then return redis.error_reply('ERR Invalid recording publication entry') end
	if held.deadline <= now then entries[old] = nil
	else count = count + 1; latest = math.max(latest, held.deadline) end
end
local held = entries[id]
if held and bit.band(held.flags, transition) ~= 0 then return 0 end
-- 상한에 차면 신규 발행을 거부하는 대신 기한이 가장 이른 기록을 축출한다 (seen 축출과 같은 이유).
if not held and count >= capacity then
	local oldest, oldestDeadline
	for old, entry in pairs(entries) do
		if oldestDeadline == nil or entry.deadline < oldestDeadline then oldest, oldestDeadline = old, entry.deadline end
	end
	if oldest ~= nil then
		entries[oldest] = nil
		-- 축출한 항목이 가장 늦은 기한이었으면 (단일 항목 등) 수명 계산을 다시 맞춘다
		if oldestDeadline >= latest then
			latest = deadline
			for _, entry in pairs(entries) do if entry.deadline > latest then latest = entry.deadline end end
		end
	end
end
entries[id] = {flags = bit.bor(held and held.flags or 0, transition), deadline = math.max(held and held.deadline or 0, deadline)}
local encoded, ttl = cjson.encode(entries), latest - now
if not redis.acl_check_cmd('SET', KEYS[1], encoded, 'PX', ttl) then return redis.error_reply('NOPERM Recording publication ledger') end
redis.call('SET', KEYS[1], encoded, 'PX', ttl)
for _, message in ipairs(messages) do redis.call('PUBLISH', ARGV[7], message) end
return 1
`;

export const ACK_RECORDING_PUBLICATION_SCRIPT = `#!lua
-- ACK_RECORDING_PUBLICATION
local flags = tonumber(redis.call('HGET', KEYS[1], ARGV[1])) or 0
local transition = tonumber(ARGV[2])
if bit.band(flags, transition) == 0 then return redis.error_reply('ERR Recording publication was not prepared') end
local pending = tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or 0
local remaining = bit.band(pending, bit.bnot(transition))
if remaining == 0 then redis.call('HDEL', KEYS[2], ARGV[1])
else redis.call('HSET', KEYS[2], ARGV[1], remaining) end
return 1
`;

// KEYS: ID 결속, 세션의 활성 ID, 미완료 목록, 보관 목록. ARGV: 클라이언트 ID, TTL, 시각, ID 상한.
export const RENEW_ACTIVE_RECORDING_SCRIPT = `-- RENEW_ACTIVE_RECORDING
${EVICT_RECORDING_HISTORY_FUNCTION}
local raw = redis.call('GET', KEYS[1])
if not raw or redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local binding = cjson.decode(raw)
if binding.stop then return 0 end
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ARGV[2]) end
-- 축출됐던 활성 ID의 갱신도 보관 목록 상한을 지킨다 (재삽입 경로에 같은 규칙)
if not redis.call('ZSCORE', KEYS[4], ARGV[1]) then evictRecordingHistory(KEYS[4], tonumber(ARGV[4]), string.sub(KEYS[1], 1, #KEYS[1] - #ARGV[1])) end
redis.call('ZADD', KEYS[4], tonumber(ARGV[3]) + tonumber(ARGV[2]) * 1000, ARGV[1])
local latest = redis.call('ZREVRANGE', KEYS[4], 0, 0, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[4], math.max(1000, tonumber(latest[2]) - tonumber(ARGV[3])))
return 1
`;
