/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import type { RoleTierPolicyMeta, RoleTierRole } from '@/utility/role-tier.js';
import {
	applyRoleTierFix,
	capRoleCondFormula,
	findLoweredRolePolicies,
	findRoleTierGroups,
	planRoleTierCaps,
} from '@/utility/role-tier.js';

type Policies = Record<string, RoleTierPolicyMeta>;

function policy(value: unknown, priority = 0): RoleTierPolicyMeta {
	return { useDefault: false, priority, value };
}

function tierRole(name: string, lower: number, upper: number | null = null, policies: Policies = {}): RoleTierRole {
	const lowerTerm = { id: `${name}-lower`, type: 'notesMoreThanOrEq', value: lower };
	return {
		id: name,
		name,
		target: 'conditional',
		isPublic: true,
		policies,
		condFormula: upper == null ? lowerTerm : {
			id: `${name}-and`,
			type: 'and',
			values: [lowerTerm, { id: `${name}-upper`, type: 'notesLessThanOrEq', value: upper }],
		},
	};
}

function capsOf(current: RoleTierRole, others: RoleTierRole[]) {
	return planRoleTierCaps(findRoleTierGroups(current, others))
		.map(cap => [cap.role.name, cap.lower, cap.previousUpper, cap.upper]);
}

describe('planRoleTierCaps', () => {
	test('상위 역할을 저장하면 아래 등급 전체에 상한을 제안한다', () => {
		const caps = capsOf(tierRole('5만', 50000), [tierRole('5천', 5000), tierRole('1.5만', 15000), tierRole('3만', 30000)]);
		expect(caps).toEqual([
			['5천', 5000, null, 14999],
			['1.5만', 15000, null, 29999],
			['3만', 30000, null, 49999],
		]);
	});

	test('중간 등급을 끼워 넣으면 아래 역할의 기존 상한도 줄인다', () => {
		const caps = capsOf(tierRole('1만', 10000), [tierRole('5천', 5000, 14999), tierRole('1.5만', 15000)]);
		expect(caps).toEqual([
			['5천', 5000, 14999, 9999],
			['1만', 10000, null, 14999],
		]);
	});

	test('일부만 겹치는 구간도 고친다', () => {
		expect(capsOf(tierRole('높음', 15000), [tierRole('낮음', 5000, 20000)])).toEqual([['낮음', 5000, 20000, 14999]]);
	});

	test('겹치지 않으면 제안하지 않고, 일부러 비워 둔 구간도 건드리지 않는다', () => {
		expect(capsOf(tierRole('높음', 15000), [tierRole('낮음', 5000, 14999)])).toEqual([]);
		expect(capsOf(tierRole('높음', 15000), [tierRole('낮음', 5000, 9999)])).toEqual([]);
	});

	test('기준값이 같은 역할끼리는 서로 상한을 걸지 않는다', () => {
		const caps = capsOf(tierRole('높음', 15000), [tierRole('낮음A', 5000), tierRole('낮음B', 5000)]);
		expect(caps).toEqual([
			['낮음A', 5000, null, 14999],
			['낮음B', 5000, null, 14999],
		]);
	});

	test('나머지 조건이 같으면 순서와 id가 달라도 같은 등급으로 본다', () => {
		const low: RoleTierRole = {
			...tierRole('낮음', 5000),
			condFormula: { id: 'a', type: 'and', values: [{ id: 'b', type: 'isLocal' }, { id: 'c', type: 'isCat' }, { id: 'd', type: 'notesMoreThanOrEq', value: 5000 }] },
		};
		const high: RoleTierRole = {
			...tierRole('높음', 15000),
			condFormula: { id: 'e', type: 'and', values: [{ id: 'f', type: 'notesMoreThanOrEq', value: 15000 }, { id: 'g', type: 'isCat' }, { id: 'h', type: 'isLocal' }] },
		};
		expect(capsOf(high, [low])).toEqual([['낮음', 5000, null, 14999]]);
	});

	test.each<[string, Partial<RoleTierRole>]>([
		['비공개 역할', { isPublic: false }],
		['수동 역할', { target: 'manual' }],
		['다른 항목 조건', { condFormula: { id: 'x', type: 'followersMoreThanOrEq', value: 5000 } }],
		['나머지 조건이 다른 역할', { condFormula: { id: 'x', type: 'and', values: [{ id: 'y', type: 'isLocal' }, { id: 'z', type: 'notesMoreThanOrEq', value: 5000 }] } }],
		['OR 조건', { condFormula: { id: 'x', type: 'or', values: [{ id: 'y', type: 'notesMoreThanOrEq', value: 5000 }] } }],
		['NOT 조건', { condFormula: { id: 'x', type: 'not', value: { id: 'y', type: 'notesMoreThanOrEq', value: 5000 } } }],
		['같은 항목의 하한이 둘인 조건', { condFormula: { id: 'x', type: 'and', values: [{ id: 'y', type: 'notesMoreThanOrEq', value: 5000 }, { id: 'z', type: 'notesMoreThanOrEq', value: 6000 }] } }],
	])('%s은 등급으로 보지 않는다', (_, override) => {
		expect(capsOf(tierRole('높음', 15000), [{ ...tierRole('낮음', 5000), ...override }])).toEqual([]);
		expect(capsOf({ ...tierRole('낮음', 5000), ...override }, [tierRole('높음', 15000)])).toEqual([]);
	});

	test('팔로워 수 등급도 같은 방식으로 처리한다', () => {
		const low: RoleTierRole = { ...tierRole('낮음', 0), condFormula: { id: 'a', type: 'followersMoreThanOrEq', value: 100 } };
		const high: RoleTierRole = { ...tierRole('높음', 0), condFormula: { id: 'b', type: 'followersMoreThanOrEq', value: 1000 } };
		const [cap] = planRoleTierCaps(findRoleTierGroups(high, [low]));
		expect(capRoleCondFormula(low.condFormula, { ...cap })).toEqual({
			id: expect.any(String),
			type: 'and',
			values: [
				{ id: 'a', type: 'followersMoreThanOrEq', value: 100 },
				{ id: expect.any(String), type: 'followersLessThanOrEq', value: 999 },
			],
		});
	});
});

describe('가입 기간 등급', () => {
	const YEAR = 31536000;

	function ageRole(name: string, lower: number, upper: number | null = null, policies: Policies = {}): RoleTierRole {
		const lowerTerm = { id: `${name}-lower`, type: 'createdMoreThan', sec: lower };
		return {
			id: name,
			name,
			target: 'conditional',
			isPublic: true,
			policies,
			condFormula: upper == null ? lowerTerm : {
				id: `${name}-and`,
				type: 'and',
				values: [lowerTerm, { id: `${name}-upper`, type: 'createdLessThan', sec: upper }],
			},
		};
	}

	test('초과/미만 비교이므로 다음 등급 기준값을 그대로 상한으로 쓴다', () => {
		expect(capsOf(ageRole('3년', 3 * YEAR), [ageRole('1년', YEAR), ageRole('2년', 2 * YEAR)])).toEqual([
			['1년', YEAR, null, 2 * YEAR],
			['2년', 2 * YEAR, null, 3 * YEAR],
		]);
	});

	test('상한이 다음 등급 기준값과 같으면 겹치지 않는 것으로 본다', () => {
		expect(capsOf(ageRole('2년', 2 * YEAR), [ageRole('1년', YEAR, 2 * YEAR)])).toEqual([]);
	});

	test('상한이 다음 등급 기준값보다 크면 줄인다', () => {
		expect(capsOf(ageRole('2년', 2 * YEAR), [ageRole('1년', YEAR, 3 * YEAR)])).toEqual([['1년', YEAR, 3 * YEAR, 2 * YEAR]]);
	});

	test('상한 조건은 sec 값으로 더한다', () => {
		const low = ageRole('1년', YEAR);
		const [cap] = planRoleTierCaps(findRoleTierGroups(ageRole('2년', 2 * YEAR), [low]));

		expect(capRoleCondFormula(low.condFormula, cap)).toEqual({
			id: expect.any(String),
			type: 'and',
			values: [
				{ id: '1년-lower', type: 'createdMoreThan', sec: YEAR },
				{ id: expect.any(String), type: 'createdLessThan', sec: 2 * YEAR },
			],
		});
	});

	test('이미 있는 상한은 sec 값만 바꾼다', () => {
		const low = ageRole('1년', YEAR, 3 * YEAR);
		const [cap] = planRoleTierCaps(findRoleTierGroups(ageRole('2년', 2 * YEAR), [low]));

		expect(capRoleCondFormula(low.condFormula, cap)).toEqual({
			id: '1년-and',
			type: 'and',
			values: [
				{ id: '1년-lower', type: 'createdMoreThan', sec: YEAR },
				{ id: '1년-upper', type: 'createdLessThan', sec: 2 * YEAR },
			],
		});
	});

	test('권한도 가입 기간 순서로 비교한다', () => {
		const groups = findRoleTierGroups(ageRole('2년', 2 * YEAR), [ageRole('1년', YEAR, null, { clipLimit: policy(200) })]);

		expect(findLoweredRolePolicies(groups, { clipLimit: 10 }).map(item => [item.role.name, item.to])).toEqual([['2년', 200]]);
	});

	test('노트 수 등급과는 섞지 않는다', () => {
		expect(capsOf(ageRole('2년', 2 * YEAR), [tierRole('낮음', 5000)])).toEqual([]);
	});
});

describe('capRoleCondFormula', () => {
	const cap = { upperType: 'notesLessThanOrEq', valueKey: 'value', upper: 14999 };

	test('단일 조건은 AND로 감싼다', () => {
		expect(capRoleCondFormula({ id: 'a', type: 'notesMoreThanOrEq', value: 5000 }, cap)).toEqual({
			id: expect.any(String),
			type: 'and',
			values: [
				{ id: 'a', type: 'notesMoreThanOrEq', value: 5000 },
				{ id: expect.any(String), type: 'notesLessThanOrEq', value: 14999 },
			],
		});
	});

	test('AND 조건에는 나머지 조건을 유지한 채 상한을 더한다', () => {
		const formula = { id: 'a', type: 'and', values: [{ id: 'b', type: 'isLocal' }, { id: 'c', type: 'notesMoreThanOrEq', value: 5000 }] };
		expect(capRoleCondFormula(formula, cap)).toEqual({
			id: 'a',
			type: 'and',
			values: [
				{ id: 'b', type: 'isLocal' },
				{ id: 'c', type: 'notesMoreThanOrEq', value: 5000 },
				{ id: expect.any(String), type: 'notesLessThanOrEq', value: 14999 },
			],
		});
		expect(formula.values).toHaveLength(2);
	});

	test('이미 상한이 있으면 값만 바꾼다', () => {
		const formula = { id: 'a', type: 'and', values: [{ id: 'b', type: 'notesMoreThanOrEq', value: 5000 }, { id: 'c', type: 'notesLessThanOrEq', value: 20000 }] };
		expect(capRoleCondFormula(formula, cap)).toEqual({
			id: 'a',
			type: 'and',
			values: [
				{ id: 'b', type: 'notesMoreThanOrEq', value: 5000 },
				{ id: 'c', type: 'notesLessThanOrEq', value: 14999 },
			],
		});
	});
});

describe('findLoweredRolePolicies', () => {
	function lowered(base: Record<string, unknown>, ...roles: RoleTierRole[]) {
		const [current, ...others] = roles;
		return findLoweredRolePolicies(findRoleTierGroups(current, others), base)
			.map(item => [item.role.name, item.key, item.from, item.to]);
	}

	test('상위 역할이 기본값으로 낮아지는 권한을 찾는다', () => {
		expect(lowered(
			{ driveCapacityMb: 1024, clipLimit: 10 },
			tierRole('높음', 50000),
			tierRole('낮음', 30000, null, { driveCapacityMb: policy(20480) }),
		)).toEqual([['높음', 'driveCapacityMb', 1024, 20480]]);
	});

	test('이미 구간이 나뉜 역할도 비교한다', () => {
		expect(lowered(
			{ clipLimit: 10 },
			tierRole('높음', 50000),
			tierRole('낮음', 30000, 49999, { clipLimit: policy(200) }),
		)).toEqual([['높음', 'clipLimit', 10, 200]]);
	});

	const term = (type: string, value: number) => ({ id: `${type}-${value}`, type, value });
	const multiTierRole = (name: string, notes: number, followers: number, policies: Policies = {}): RoleTierRole => ({
		...tierRole(name, 0, null, policies),
		condFormula: {
			id: `${name}-and`,
			type: 'and',
			values: [term('notesMoreThanOrEq', notes), term('followersMoreThanOrEq', followers)],
		},
	});

	test.each([
		['먼저 비교한 항목의 값이 더 높아도', 100, 50],
		['나중에 비교한 항목의 값이 더 높아도', 50, 100],
	])('한 역할이 두 항목의 등급에 함께 속하면 %s 가장 높은 값으로 복사한다', (_, notesPeerValue, followersPeerValue) => {
		expect(lowered(
			{ clipLimit: 10 },
			multiTierRole('높음', 1000, 1000),
			multiTierRole('노트 낮음', 10, 1000, { clipLimit: policy(notesPeerValue) }),
			multiTierRole('팔로워 낮음', 1000, 10, { clipLimit: policy(followersPeerValue) }),
		)).toEqual([['높음', 'clipLimit', 10, 100]]);
	});

	test('다른 항목의 등급에서 올린 값이 앞서 비교한 상위 역할보다 높아지면 그 역할도 올린다', () => {
		expect(lowered(
			{ clipLimit: 1 },
			multiTierRole('중간', 100, 100, { clipLimit: policy(10) }),
			multiTierRole('노트 높음', 1000, 100, { clipLimit: policy(50) }),
			multiTierRole('팔로워 낮음', 100, 10, { clipLimit: policy(100) }),
		)).toEqual([
			['중간', 'clipLimit', 10, 100],
			['노트 높음', 'clipLimit', 50, 100],
		]);
	});

	test('상위 역할의 권한이 같거나 높으면 찾지 않는다', () => {
		expect(lowered(
			{ clipLimit: 10 },
			tierRole('높음', 50000, null, { clipLimit: policy(200) }),
			tierRole('낮음', 30000, null, { clipLimit: policy(200) }),
		)).toEqual([]);
	});

	test('중간 등급까지 지금까지의 가장 높은 값과 비교한다', () => {
		expect(lowered(
			{ clipLimit: 10 },
			tierRole('3만', 30000, null, { clipLimit: policy(150) }),
			tierRole('5천', 5000, null, { clipLimit: policy(200) }),
			tierRole('1.5만', 15000, null, { clipLimit: policy(100) }),
		)).toEqual([
			['1.5만', 'clipLimit', 100, 200],
			['3만', 'clipLimit', 150, 200],
		]);
	});

	test('기준값이 같은 역할끼리는 비교하지 않되, 다음 등급은 그중 높은 값과 비교한다', () => {
		expect(lowered(
			{ clipLimit: 10 },
			tierRole('높음', 15000, null, { clipLimit: policy(50) }),
			tierRole('낮음A', 5000, null, { clipLimit: policy(200) }),
			tierRole('낮음B', 5000, null, { clipLimit: policy(100) }),
		)).toEqual([['높음', 'clipLimit', 50, 200]]);
	});

	test.each<[string, string, unknown, unknown, boolean]>([
		['값이 클수록 엄격한 요청 빈도 제한: 낮아짐', 'rateLimitFactor', 0.5, 1, true],
		['값이 클수록 엄격한 요청 빈도 제한: 높아짐', 'rateLimitFactor', 2, 1, false],
		['값이 클수록 엄격한 초대 발급 간격: 낮아짐', 'inviteLimitCycle', 60, 1440, true],
		['값이 클수록 엄격한 초대 발급 간격: 높아짐', 'inviteLimitCycle', 1440, 60, false],
		['켜질수록 제약인 NSFW 강제: 낮아짐', 'alwaysMarkNsfw', false, true, true],
		['켜질수록 제약인 NSFW 강제: 높아짐', 'alwaysMarkNsfw', true, false, false],
		['0이 무제한인 초대 한도: 낮아짐', 'inviteLimit', 0, 5, true],
		['0이 무제한인 초대 한도: 높아짐', 'inviteLimit', 5, 0, false],
		['0이 무기한인 초대 만료: 낮아짐', 'inviteExpirationTime', 0, 60, true],
		['0이 무기한인 초대 만료: 높아짐', 'inviteExpirationTime', 60, 0, false],
		['켜진 권한이 꺼짐', 'canSearchNotes', true, false, true],
		['꺼진 권한이 켜짐', 'canSearchNotes', false, true, false],
		['채팅 사용이 읽기 전용으로', 'chatAvailability', 'available', 'readonly', true],
		['채팅 읽기 전용이 사용 불가로', 'chatAvailability', 'readonly', 'unavailable', true],
		['채팅 읽기 전용이 사용으로', 'chatAvailability', 'readonly', 'available', false],
		['업로드 가능 종류가 빠짐', 'uploadableFileTypes', ['image/*', 'video/*'], ['image/*'], true],
		['업로드 와일드카드가 개별 종류를 포함', 'uploadableFileTypes', ['image/png'], ['image/*'], false],
		['업로드 전체 허용이 모두 포함', 'uploadableFileTypes', ['image/*', 'video/*'], ['*/*'], false],
		['개별 종류가 와일드카드를 대신하지 못함', 'uploadableFileTypes', ['image/*'], ['image/png'], true],
	])('%s', (_, key, lowerValue, upperValue, expected) => {
		const result = lowered(
			{ [key]: upperValue },
			tierRole('높음', 50000, null, { [key]: policy(upperValue) }),
			tierRole('낮음', 30000, null, { [key]: policy(lowerValue) }),
		);
		expect(result.length > 0).toBe(expected);
	});

	test('상위 역할이 더 높은 우선순위로 지정한 값은 의도로 보고 건드리지 않는다', () => {
		expect(lowered(
			{ clipLimit: 10 },
			tierRole('높음', 50000, null, { clipLimit: policy(50, 1) }),
			tierRole('낮음', 30000, null, { clipLimit: policy(200) }),
		)).toEqual([]);
	});

	test('useDefault가 없는 권한은 서버처럼 지정된 값으로 읽는다', () => {
		expect(lowered(
			{ clipLimit: 10 },
			tierRole('높음', 50000),
			tierRole('낮음', 30000, null, { clipLimit: { value: 200 } }),
		)).toEqual([['높음', 'clipLimit', 10, 200]]);
	});

	test('모르는 형태의 권한 값은 건드리지 않는다', () => {
		expect(lowered(
			{ unknownPolicy: 'a' },
			tierRole('높음', 50000, null, { unknownPolicy: policy('b') }),
			tierRole('낮음', 30000, null, { unknownPolicy: policy('c') }),
		)).toEqual([]);
	});
});

describe('applyRoleTierFix', () => {
	test('상한과 복사할 권한을 해당 역할에만 반영하고 다른 권한은 유지한다', () => {
		const low = tierRole('낮음', 30000, null, { driveCapacityMb: policy(20480, 1) });
		const high = tierRole('높음', 50000, null, { pinLimit: policy(30) });
		const groups = findRoleTierGroups(high, [low]);
		const fix = {
			caps: planRoleTierCaps(groups),
			lowered: findLoweredRolePolicies(groups, { driveCapacityMb: 1024, pinLimit: 5 }),
		};

		expect(applyRoleTierFix(high, fix)).toEqual({
			condFormula: high.condFormula,
			policies: {
				pinLimit: policy(30),
				driveCapacityMb: { useDefault: false, priority: 1, value: 20480 },
			},
		});
		expect(applyRoleTierFix(low, fix)).toEqual({
			condFormula: {
				id: expect.any(String),
				type: 'and',
				values: [
					{ id: '낮음-lower', type: 'notesMoreThanOrEq', value: 30000 },
					{ id: expect.any(String), type: 'notesLessThanOrEq', value: 49999 },
				],
			},
			policies: low.policies,
		});
	});

	test('기본값을 따르던 역할의 권한을 복사하면 기본값 따르기도 유지한다', () => {
		const low = tierRole('낮음', 30000);
		const high = tierRole('높음', 50000, null, { clipLimit: policy(5) });
		const groups = findRoleTierGroups(high, [low]);
		const fix = { caps: [], lowered: findLoweredRolePolicies(groups, { clipLimit: 10 }) };

		expect(applyRoleTierFix(high, fix).policies.clipLimit).toEqual({ useDefault: true, priority: 0, value: 10 });
	});

	test('업로드 종류는 빠진 항목만 더한다', () => {
		const low = tierRole('낮음', 30000, null, { uploadableFileTypes: policy(['image/*', 'video/*']) });
		const high = tierRole('높음', 50000, null, { uploadableFileTypes: policy(['image/png', 'audio/*']) });
		const groups = findRoleTierGroups(high, [low]);
		const fix = { caps: [], lowered: findLoweredRolePolicies(groups, { uploadableFileTypes: [] }) };

		expect(applyRoleTierFix(high, fix).policies.uploadableFileTypes).toEqual({
			useDefault: false,
			priority: 0,
			value: ['image/png', 'audio/*', 'image/*', 'video/*'],
		});
	});
});
