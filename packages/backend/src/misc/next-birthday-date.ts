/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function getNextBirthdayDate(month: number, day: number, today = new Date()): string {
	const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	for (let year = today.getFullYear(); year < today.getFullYear() + 5; year++) {
		const birthday = new Date(year, month - 1, day);
		if (birthday.getFullYear() !== year || birthday.getMonth() !== month - 1 || birthday.getDate() !== day) continue;
		if (birthday < startOfToday) continue;
		return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}
	throw new Error(`Invalid birthday: ${month}-${day}`);
}
