/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { LoweredRolePolicy, RoleTierCap, RoleTierFix, RoleTierRole } from '@/utility/role-tier.js';
import { findLoweredRolePolicies, findRoleTierGroups, planRoleTierCaps } from '@/utility/role-tier.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import number from '@/filters/number.js';

/** 권한 이름과 라벨 이름이 다른 항목 */
const POLICY_LABEL_KEYS: Record<string, string | undefined> = {
	mentionLimit: 'mentionMax',
	driveCapacityMb: 'driveCapacity',
	maxFileSizeMb: 'maxFileSize',
	pinLimit: 'pinMax',
	antennaLimit: 'antennaMax',
	wordMuteLimit: 'wordMuteMax',
	webhookLimit: 'webhookMax',
	clipLimit: 'clipMax',
	noteEachClipsLimit: 'noteEachClipsMax',
	userListLimit: 'userListMax',
	userEachUserListsLimit: 'userEachUserListsMax',
};

function roleNameText(name: string): string {
	// MFM에는 이스케이프가 없으므로, 닫는 태그만 빼서 이름 전체가 일반 텍스트로 남게 한다.
	return `**<plain>${name.replaceAll('</plain>', '')}</plain>**`;
}

function durationText(sec: number): string {
	if (sec % 86400 === 0) return `${number(sec / 86400)}${i18n.ts._time.day}`;
	if (sec % 3600 === 0) return `${number(sec / 3600)}${i18n.ts._time.hour}`;
	if (sec % 60 === 0) return `${number(sec / 60)}${i18n.ts._time.minute}`;
	return `${number(sec)}${i18n.ts._time.second}`;
}

function rangeText(cap: RoleTierCap, upper: number | null): string {
	const bound = (value: number) => (cap.valueKey === 'sec' ? durationText(value) : number(value));
	return upper == null
		? i18n.tsx._role._tierFix.rangeFrom({ min: bound(cap.lower) })
		: i18n.tsx._role._tierFix.range({ min: bound(cap.lower), max: bound(upper) });
}

function policyLabel(key: string): string {
	const labels: Record<string, string | undefined> = i18n.ts._role._options;
	return labels[POLICY_LABEL_KEYS[key] ?? key] ?? key;
}

function policyValueText(key: string, value: unknown): string {
	if (typeof value === 'boolean') return value ? i18n.ts.yes : i18n.ts.no;
	if (Array.isArray(value)) return value.join(', ');

	switch (key) {
		case 'rateLimitFactor': return `${Math.floor(Number(value) * 100)}%`;
		case 'driveCapacityMb':
		case 'maxFileSizeMb': return `${value}MB`;
		case 'inviteLimitCycle':
		case 'inviteExpirationTime': return `${value}${i18n.ts._time.minute}`;
		case 'chatAvailability': return value === 'available' ? i18n.ts.yes : value === 'readonly' ? i18n.ts.readonly : i18n.ts.no;
		default: return String(value);
	}
}

function loweredPoliciesText(lowered: LoweredRolePolicy[]): string {
	const roles = new Set(lowered.map(item => item.role));
	return [...roles].map(role => [
		roleNameText(role.name),
		...lowered
			.filter(item => item.role === role)
			.map(item => `${policyLabel(item.key)} ${policyValueText(item.key, item.from)} → ${policyValueText(item.key, item.to)}`),
	].join('\n')).join('\n\n');
}

/**
 * 저장하려는 역할과 다른 등급 역할이 겹치거나 권한이 낮아지면 고칠지 묻는다.
 * @returns 적용할 수정 내용. 안내창을 닫아 저장을 취소하면 null
 */
export async function confirmRoleTierFix(
	current: RoleTierRole,
	others: RoleTierRole[],
	basePolicies: Record<string, unknown>,
): Promise<RoleTierFix | null> {
	const groups = findRoleTierGroups(current, others);
	const caps = planRoleTierCaps(groups);

	if (caps.length > 0) {
		const lines = caps.map(cap => `${roleNameText(cap.role.name)} ${rangeText(cap, cap.previousUpper)} → ${rangeText(cap, cap.upper)}`);
		const { canceled, result } = await os.actions({
			type: 'question',
			title: i18n.ts._role._tierFix.overlapTitle,
			text: `${i18n.ts._role._tierFix.overlapText}\n\n${lines.join('\n')}`,
			actions: [
				{ value: 'fix', text: i18n.ts._role._tierFix.fixConditions, primary: true },
				{ value: 'saveAsIs', text: i18n.ts._role._tierFix.saveAsIs },
			],
		});
		if (canceled) return null;
		// 겹침을 그대로 두면 아래 등급의 권한도 계속 함께 적용되므로 낮아지는 권한이 없다.
		if (result === 'saveAsIs') return { caps: [], lowered: [] };
	}

	const lowered = findLoweredRolePolicies(groups, basePolicies);
	if (lowered.length === 0) return { caps, lowered };

	const { canceled, result } = await os.actions({
		type: 'warning',
		title: i18n.ts._role._tierFix.loweredTitle,
		text: `${i18n.ts._role._tierFix.loweredText}\n\n${loweredPoliciesText(lowered)}`,
		actions: [
			{ value: 'copy', text: i18n.ts._role._tierFix.copyLowered, primary: true },
			{ value: 'skip', text: i18n.ts._role._tierFix.doNotCopy },
		],
	});
	if (canceled) return null;

	return { caps, lowered: result === 'copy' ? lowered : [] };
}
