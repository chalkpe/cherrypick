/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import { computed, ref } from 'vue';
import type { Ref, WritableComputedRef } from 'vue';

export type FakePrefer = {
	s: Record<string, any>;
	r: Record<string, Ref<any>>;
	commit: ReturnType<typeof vi.fn<(key: string, value: unknown) => void>>;
	model: (key: string) => WritableComputedRef<any>;
	/** テストごとに値を入れ直す。commit の呼び出し記録も消す */
	reset: (values: Record<string, unknown>) => void;
};

/**
 * 本物の PreferencesManager と同じ形の prefer を作る。
 * s は素のオブジェクトなので読んでも変更を追えず、変更を追えるのは r[key] の ref だけ。
 * commit は rewriteRawState と同じく s と r の両方を書き換える。
 * s をリアクティブにすると、prefer.s を computed や watch で読む不具合をテストが見逃す。
 */
export function createFakePrefer(values: Record<string, unknown> = {}): FakePrefer {
	const s: Record<string, any> = {};
	const r: Record<string, Ref<any>> = {};

	function write(key: string, value: unknown) {
		const v = JSON.parse(JSON.stringify(value ?? null)); // 本物と同じく複製してから入れる
		s[key] = v;
		if (key in r) {
			r[key].value = v;
		} else {
			r[key] = ref(v);
		}
	}

	const commit = vi.fn((key: string, value: unknown) => {
		write(key, value);
	});

	const prefer: FakePrefer = {
		s,
		r,
		commit,
		model: (key: string) => computed({
			get: () => r[key].value,
			set: value => commit(key, value),
		}),
		reset: (next: Record<string, unknown>) => {
			for (const key of Object.keys(s)) delete s[key];
			for (const [key, value] of Object.entries(next)) write(key, value);
			commit.mockClear();
		},
	};
	prefer.reset(values);
	return prefer;
}
