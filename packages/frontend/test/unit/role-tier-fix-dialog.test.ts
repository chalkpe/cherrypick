/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import * as mfm from 'mfm-js';
import type { RoleTierRole } from '@/utility/role-tier.js';
import { confirmRoleTierFix } from '@/pages/admin/roles.tier-fix.js';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({ actions: vi.fn() }));
vi.mock('@/os.js', () => ({ actions: mocks.actions }));

const base = { driveCapacityMb: 1024 };

function tierRole(name: string, lower: number, driveCapacityMb?: number): RoleTierRole {
	return {
		id: name,
		name,
		target: 'conditional',
		isPublic: true,
		condFormula: { id: `${name}-lower`, type: 'notesMoreThanOrEq', value: lower },
		policies: driveCapacityMb == null ? {} : { driveCapacityMb: { useDefault: false, priority: 0, value: driveCapacityMb } },
	};
}

const high = tierRole('높음', 50000);
const low = tierRole('낮음', 30000, 20480);

function answer(...results: (string | null)[]) {
	for (const result of results) {
		mocks.actions.mockResolvedValueOnce(result == null ? { canceled: true, result: undefined } : { canceled: false, result });
	}
}

beforeEach(() => {
	mocks.actions.mockReset();
});

test('겹침도 낮아지는 권한도 없으면 묻지 않는다', async () => {
	const fix = await confirmRoleTierFix(high, [{ ...low, isPublic: false }], base);

	expect(mocks.actions).not.toHaveBeenCalled();
	expect(fix).toEqual({ caps: [], lowered: [] });
});

test('겹침 안내를 바깥을 눌러 닫으면 저장을 취소한다', async () => {
	answer(null);

	expect(await confirmRoleTierFix(high, [low], base)).toBeNull();
	expect(mocks.actions).toHaveBeenCalledTimes(1);
});

test('그대로 저장을 고르면 권한 안내 없이 아무것도 고치지 않는다', async () => {
	answer('saveAsIs');

	expect(await confirmRoleTierFix(high, [low], base)).toEqual({ caps: [], lowered: [] });
	expect(mocks.actions).toHaveBeenCalledTimes(1);
});

test('조건을 고치고 권한도 복사하면 둘 다 돌려준다', async () => {
	answer('fix', 'copy');

	const fix = await confirmRoleTierFix(high, [low], base);

	expect(mocks.actions).toHaveBeenCalledTimes(2);
	expect(fix?.caps.map(cap => [cap.role.name, cap.upper])).toEqual([['낮음', 49999]]);
	expect(fix?.lowered.map(item => [item.role.name, item.key, item.to])).toEqual([['높음', 'driveCapacityMb', 20480]]);
});

test('권한을 복사하지 않으면 조건만 고친다', async () => {
	answer('fix', 'skip');

	const fix = await confirmRoleTierFix(high, [low], base);

	expect(fix?.caps).toHaveLength(1);
	expect(fix?.lowered).toEqual([]);
});

test('권한 안내를 바깥을 눌러 닫으면 조건 수정까지 취소한다', async () => {
	answer('fix', null);

	expect(await confirmRoleTierFix(high, [low], base)).toBeNull();
});

test('이미 겹치지 않는 역할에서도 권한이 낮아지면 권한 안내만 띄운다', async () => {
	answer('copy');
	const capped: RoleTierRole = {
		...low,
		condFormula: {
			id: 'a',
			type: 'and',
			values: [{ id: 'b', type: 'notesMoreThanOrEq', value: 30000 }, { id: 'c', type: 'notesLessThanOrEq', value: 49999 }],
		},
	};

	const fix = await confirmRoleTierFix(high, [capped], base);

	expect(mocks.actions).toHaveBeenCalledTimes(1);
	expect(fix?.caps).toEqual([]);
	expect(fix?.lowered).toHaveLength(1);
});

test('안내창에 바뀔 값을 보여주고, 역할 이름은 MFM으로 해석하지 않는다', async () => {
	answer('fix', 'skip');
	const name = '**$[spin 굵게]** @mention :emoji:';

	await confirmRoleTierFix(tierRole('높음', 50000), [tierRole(name, 30000, 20480)], base);

	const overlapText: string = mocks.actions.mock.calls[0][0].text;
	expect(overlapText).toContain('30,000');
	expect(overlapText).toContain('49,999');
	expect(JSON.stringify(mfm.parse(overlapText))).toContain(JSON.stringify(name));
	expect(mfm.extract(mfm.parse(overlapText), node => node.type === 'mention' || node.type === 'emojiCode' || node.type === 'fn')).toEqual([]);

	const loweredText: string = mocks.actions.mock.calls[1][0].text;
	expect(loweredText).toContain('1024MB');
	expect(loweredText).toContain('20480MB');
});

test.each<[number, () => string]>([
	[31536000, () => `365${i18n.ts._time.day}`],
	[7200, () => `2${i18n.ts._time.hour}`],
	[120, () => `2${i18n.ts._time.minute}`],
	[90, () => `90${i18n.ts._time.second}`],
])('가입 기간 %i초는 읽기 쉬운 단위로 보여준다', async (sec, expected) => {
	answer('saveAsIs');
	const ageRole = (name: string, value: number): RoleTierRole => ({
		...tierRole(name, 0),
		condFormula: { id: `${name}-lower`, type: 'createdMoreThan', sec: value },
	});

	await confirmRoleTierFix(ageRole('높음', sec * 2), [ageRole('낮음', sec)], base);

	expect(mocks.actions.mock.calls[0][0].text).toContain(expected());
});

test('역할 이름에 닫는 plain 태그가 있어도 뒷부분을 MFM으로 해석하지 않는다', async () => {
	answer('saveAsIs');

	await confirmRoleTierFix(tierRole('높음', 50000), [tierRole('x</plain> $[spin boom] @admin', 30000)], base);

	const nodes = mfm.parse(mocks.actions.mock.calls[0][0].text);
	expect(mfm.extract(nodes, node => node.type === 'mention' || node.type === 'fn')).toEqual([]);
});
