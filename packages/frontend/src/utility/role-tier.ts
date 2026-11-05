/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { genId } from '@/utility/id.js';

export type RoleTierFormula = {
	id: string;
	type: string;
	value?: unknown;
	values?: RoleTierFormula[];
	[key: string]: unknown;
};

export type RoleTierPolicyMeta = {
	useDefault?: boolean;
	priority?: number;
	value?: unknown;
};

export type RoleTierRole = {
	/** 아직 만들어지지 않은 역할은 null */
	id: string | null;
	name: string;
	target: 'manual' | 'conditional';
	isPublic: boolean;
	isAdministrator?: boolean;
	isModerator?: boolean;
	condFormula: RoleTierFormula;
	policies: Record<string, RoleTierPolicyMeta | undefined>;
};

type RoleTierMember = {
	role: RoleTierRole;
	lower: number;
	upper: number | null;
	restKey: string;
};

type RoleTierMetric = typeof TIER_METRICS[number];

export type RoleTierGroup = {
	metric: RoleTierMetric;
	/** lower 오름차순 */
	members: RoleTierMember[];
};

export type RoleTierCap = {
	role: RoleTierRole;
	lower: number;
	previousUpper: number | null;
	upper: number;
	upperType: string;
	valueKey: string;
};

export type LoweredRolePolicy = {
	role: RoleTierRole;
	key: string;
	from: unknown;
	to: unknown;
	copied: RoleTierPolicyMeta;
};

export type RoleTierFix = {
	caps: RoleTierCap[];
	lowered: LoweredRolePolicy[];
};

/**
 * 등급으로 볼 수 있는 조건 항목.
 * gap은 다음 등급 기준값과 상한의 차이다. 개수는 이상/이하 비교라 1을 빼고,
 * 가입 기간은 초과/미만 비교라 다음 등급 기준값을 그대로 상한으로 쓴다.
 */
const TIER_METRICS = [
	{ lowerType: 'notesMoreThanOrEq', upperType: 'notesLessThanOrEq', valueKey: 'value', gap: 1 },
	{ lowerType: 'followersMoreThanOrEq', upperType: 'followersLessThanOrEq', valueKey: 'value', gap: 1 },
	{ lowerType: 'followingMoreThanOrEq', upperType: 'followingLessThanOrEq', valueKey: 'value', gap: 1 },
	{ lowerType: 'createdMoreThan', upperType: 'createdLessThan', valueKey: 'sec', gap: 0 },
];

/** 값이 크거나 켜져 있을수록 사용자에게 더 엄격한 권한 */
const HIGHER_IS_STRICTER = new Set(['rateLimitFactor', 'inviteLimitCycle', 'alwaysMarkNsfw']);
/** 0이 무제한을 뜻하는 권한 */
export const ZERO_IS_UNLIMITED = new Set(['inviteLimit', 'inviteExpirationTime']);
const CHAT_AVAILABILITY_RANK: Record<string, number | undefined> = { unavailable: 0, readonly: 1, available: 2 };

function canonicalTerm(term: RoleTierFormula): string {
	return JSON.stringify(term, (key, value) => {
		if (key === 'id') return undefined;
		if (value != null && typeof value === 'object' && !Array.isArray(value)) {
			return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
		}
		return value;
	});
}

function toTierMember(role: RoleTierRole, metric: RoleTierMetric): RoleTierMember | null {
	if (role.target !== 'conditional' || !role.isPublic) return null;
	// 관리 권한은 policies에 없어 낮아지는 권한으로 안내할 수 없으므로, 상한을 넣어 말없이 잃지 않게 한다.
	if (role.isAdministrator || role.isModerator) return null;

	const terms = role.condFormula.type === 'and' ? role.condFormula.values ?? [] : [role.condFormula];
	const lowers = terms.filter(term => term.type === metric.lowerType);
	const uppers = terms.filter(term => term.type === metric.upperType);
	if (lowers.length !== 1 || uppers.length > 1) return null;

	const lower = lowers[0][metric.valueKey];
	const upper = uppers[0]?.[metric.valueKey] ?? null;
	if (typeof lower !== 'number' || (upper != null && typeof upper !== 'number')) return null;

	const rest = terms.filter(term => term.type !== metric.lowerType && term.type !== metric.upperType);
	return { role, lower, upper: upper as number | null, restKey: JSON.stringify(rest.map(canonicalTerm).sort()) };
}

/**
 * current와 같은 항목의 기준값만 다르고 나머지 조건이 같은 공개 조건부 역할을 묶는다.
 * 복잡한 조건까지 판별하면 잘못 짚기 쉬우므로 최상위 AND 구조만 본다.
 */
export function findRoleTierGroups(current: RoleTierRole, others: RoleTierRole[]): RoleTierGroup[] {
	const groups: RoleTierGroup[] = [];

	for (const metric of TIER_METRICS) {
		const currentMember = toTierMember(current, metric);
		if (currentMember == null) continue;

		const peers = others
			.map(role => toTierMember(role, metric))
			.filter((member): member is RoleTierMember => member?.restKey === currentMember.restKey);
		if (peers.length === 0) continue;

		groups.push({
			metric,
			members: [currentMember, ...peers].sort((a, b) => a.lower - b.lower),
		});
	}

	return groups;
}

/**
 * 위 등급들이 member의 구간 끝까지 빈틈없이 이어지는지 본다.
 * 이어지지 않는데 상한을 넣으면 위 등급 바깥의 사용자가 역할을 모두 잃는다.
 */
function isCoveredByUpperTiers(member: RoleTierMember, upperTiers: RoleTierMember[], gap: number): boolean {
	let reach = upperTiers[0].lower - gap;
	for (const { lower, upper } of upperTiers) {
		if (lower - gap > reach) return false;
		if (upper == null) return true;
		reach = Math.max(reach, upper);
		if (member.upper != null && reach >= member.upper) return true;
	}
	return false;
}

export function planRoleTierCaps(groups: RoleTierGroup[]): RoleTierCap[] {
	return groups.flatMap(group => group.members.flatMap((member): RoleTierCap[] => {
		const upperTiers = group.members.filter(other => other.lower > member.lower);
		if (upperTiers.length === 0) return [];

		const upper = upperTiers[0].lower - group.metric.gap;
		if (member.upper != null && member.upper <= upper) return [];
		if (!isCoveredByUpperTiers(member, upperTiers, group.metric.gap)) return [];

		return [{
			role: member.role,
			lower: member.lower,
			previousUpper: member.upper,
			upper,
			upperType: group.metric.upperType,
			valueKey: group.metric.valueKey,
		}];
	}));
}

export function capRoleCondFormula(formula: RoleTierFormula, cap: Pick<RoleTierCap, 'upperType' | 'upper' | 'valueKey'>): RoleTierFormula {
	const upperTerm: RoleTierFormula = { id: genId(), type: cap.upperType, [cap.valueKey]: cap.upper };

	if (formula.type !== 'and') {
		return { id: genId(), type: 'and', values: [formula, upperTerm] };
	}

	const values = formula.values ?? [];
	return {
		...formula,
		values: values.some(term => term.type === cap.upperType)
			? values.map(term => (term.type === cap.upperType ? { ...term, [cap.valueKey]: cap.upper } : term))
			: [...values, upperTerm],
	};
}

function missingFileTypes(types: string[], reference: string[]): string[] {
	const covers = (type: string, target: string) => {
		if (type === '*' || type === '*/*' || type === target) return true;
		return type.endsWith('/*') && target.startsWith(type.slice(0, -1));
	};
	return reference
		.map(type => type.trim())
		.filter(target => target !== '' && !types.some(type => covers(type.trim(), target)));
}

type RoleTierPolicyState = {
	useDefault: boolean;
	priority: number;
	value: unknown;
};

function policyRank(key: string, { useDefault, value }: RoleTierPolicyState): number | null {
	let rank: number | null = null;
	if (typeof value === 'boolean') rank = value ? 1 : 0;
	// 서버는 겹친 역할의 값을 Math.max로 합치므로, 기본값으로 물려받은 0은 무제한이 아니라 가장 낮은 값처럼 동작한다.
	// 무제한으로 보는 것은 관리자가 0을 직접 지정한 경우뿐이다.
	else if (value === 0 && ZERO_IS_UNLIMITED.has(key)) rank = useDefault ? -Infinity : Infinity;
	else if (typeof value === 'number') rank = value;
	else if (key === 'chatAvailability') rank = CHAT_AVAILABILITY_RANK[String(value)] ?? null;

	if (rank == null) return null;
	return HIGHER_IS_STRICTER.has(key) ? -rank : rank;
}

function isLowerPolicy(key: string, state: RoleTierPolicyState, reference: RoleTierPolicyState): boolean {
	if (state.value === reference.value) return false;
	// 우선순위가 같으면 서버가 이미 더 엄격한 값을 쓰므로, 아래 등급이 빠져도 더 엄격해지지 않는다.
	if (HIGHER_IS_STRICTER.has(key) && state.priority >= reference.priority) return false;
	if (Array.isArray(state.value) && Array.isArray(reference.value)) return missingFileTypes(state.value, reference.value).length > 0;

	const rank = policyRank(key, state);
	const referenceRank = policyRank(key, reference);
	return rank != null && referenceRank != null && rank < referenceRank;
}

/**
 * 더 어려운 조건인데 아래 등급보다 권한이 낮아지는 항목을 찾는다.
 * 상위 역할이 더 높은 우선순위로 지정한 값은 의도한 설정으로 본다.
 */
export function findLoweredRolePolicies(groups: RoleTierGroup[], basePolicies: Record<string, unknown>): LoweredRolePolicy[] {
	const found = new Map<string, LoweredRolePolicy>();

	// 한 역할이 여러 항목의 등급에 속하면 뒤 그룹에서 올린 값이 앞 그룹의 비교 결과를 바꾸므로,
	// 더 올릴 값이 없을 때까지 반복한다. 값은 올라가기만 하고 후보도 정해져 있어 반드시 끝난다.
	let changed = true;
	while (changed) {
		changed = false;

		for (const group of groups) {
			for (const key of Object.keys(basePolicies)) {
				let floor: { useDefault: boolean; priority: number; value: unknown; lower: number } | null = null;

				for (const { role, lower } of group.members) {
					const id = `${role.id}:${key}`;
					// 이미 복사하기로 한 값이 있으면 그 값을 기준으로 비교한다.
					const pending = found.get(id);
					const meta = pending?.copied ?? role.policies[key];
					// 서버처럼 항목이 없으면 기본값으로, useDefault가 없으면 지정된 값으로 읽는다.
					const useDefault = meta == null || meta.useDefault === true;
					const current = { useDefault, priority: meta?.priority ?? 0, value: useDefault ? basePolicies[key] : meta.value };

					if (floor == null || !isLowerPolicy(key, current, floor) || (floor.lower < lower && current.priority > floor.priority)) {
						floor = { ...current, lower };
						continue;
					}
					if (floor.lower === lower) continue;

					const merged: boolean = Array.isArray(current.value) && Array.isArray(floor.value);
					const to: unknown = merged
						? [...current.value as string[], ...missingFileTypes(current.value as string[], floor.value as string[])]
						: floor.value;
					found.set(id, {
						role,
						key,
						from: pending?.from ?? current.value,
						to,
						copied: { useDefault: !merged && floor.useDefault, priority: floor.priority, value: to },
					});
					changed = true;
					floor = { ...floor, value: to };
				}
			}
		}
	}

	return [...found.values()];
}

export function applyRoleTierFix(role: RoleTierRole, fix: RoleTierFix): Pick<RoleTierRole, 'condFormula' | 'policies'> {
	const policies = { ...role.policies };
	for (const item of fix.lowered) {
		if (item.role === role) policies[item.key] = item.copied;
	}

	return {
		condFormula: fix.caps
			.filter(cap => cap.role === role)
			.reduce(capRoleCondFormula, role.condFormula),
		policies,
	};
}
