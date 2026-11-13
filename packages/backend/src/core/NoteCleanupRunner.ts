/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// 일시적인 연결 장애만 재시도한다.
export function isRetryableCleanupFailure(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const value = error as { code?: unknown; message?: unknown; driverError?: unknown; cause?: unknown };
	if (typeof value.code === 'string' && (value.code.startsWith('08') || ['57P01', '57P02', '57P03', '53300', '40001', '40P01', '55P03', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(value.code))) return true;
	if (typeof value.message === 'string' && ['Connection terminated unexpectedly', 'Connection terminated', 'Connection ended unexpectedly'].includes(value.message)) return true;
	return (value.driverError !== error && isRetryableCleanupFailure(value.driverError)) || (value.cause !== error && isRetryableCleanupFailure(value.cause));
}

// budget는 삭제 시도 수(성공+실패)의 상한이다. 이미 없는 노트(remove가 false)는 시도로 세지 않는다.
// 예산이 다 떨어지면 다음 지울 노트 앞에서 멈추므로, 그 앞의 보존 노트까지는 커서가 전진한다.
// onFailure가 없으면 삭제 실패를 그대로 던진다. 있으면 실패를 성공으로 세지 않고 다음 노트로 진행한다.
// 이때 실패한 노트는 커서 뒤로 넘어가므로 다음 순회(커서 초기화 뒤)에서 다시 검사된다.
export async function runCleanupBatch(items: { id: string; decision: string }[], budget: number, remove: (id: string) => Promise<boolean | void>, onFailure?: (id: string, error: unknown) => void) {
	let cursor: string | null = null;
	let deleted = 0;
	let attempts = 0;
	let examined = 0;
	for (const item of items) {
		if (item.decision === 'delete') {
			if (attempts >= budget) break;
			try {
				if (await remove(item.id) !== false) {
					attempts++;
					deleted++;
				}
			} catch (error) {
				if (!onFailure) throw error;
				attempts++;
				onFailure(item.id, error);
			}
		}
		cursor = item.id;
		examined++;
	}
	return { cursor, deleted, examined };
}

export function initialCleanupRules(migrated: boolean, days: number | null, favorite: boolean): { name: string; defaultName: 'pinned' | 'favorite' | 'clip' | 'selfReaction' | 'age'; action: 'keep' | 'delete'; enabled: boolean; automatic: boolean; legacy: 'age' | 'favorite' | null; condition: import('./NoteCleanupCondition.js').CleanupCondition }[] {
	if (migrated) {
		const rules: ReturnType<typeof initialCleanupRules> = [
			{ name: '내가 즐겨찾기한 내 글', defaultName: 'favorite' as const, action: 'keep', enabled: favorite, automatic: false, legacy: 'favorite', condition: { type: 'flag', field: 'favorite', value: true } },
		];
		// 이전 처리기는 기간이 null이거나 0 이하이면 지우지 않았다. 그 비활성 의미를 그대로 둔다.
		if (days !== null && days > 0) rules.unshift({ name: '기간이 지난 내 글', defaultName: 'age' as const, action: 'delete', enabled: true, automatic: true, legacy: 'age', condition: { type: 'age', operator: 'gt', seconds: days * 86400 } });
		return rules;
	}
	// 즐겨찾기 기본 보호는 구 설정의 즐겨찾기 보호(기본값 true)와 같은 규칙이므로 구 API 변경이 이 규칙에 적용되도록 연결한다.
	return [
		{ name: '고정한 내 글', defaultName: 'pinned' as const, legacy: null, condition: { type: 'flag', field: 'pinned', value: true } },
		{ name: '내가 즐겨찾기한 내 글', defaultName: 'favorite' as const, legacy: 'favorite' as const, condition: { type: 'flag', field: 'favorite', value: true } },
		{ name: '내 클립에 담은 내 글', defaultName: 'clip' as const, legacy: null, condition: { type: 'clip', ids: null } },
		{ name: '내가 리액션한 내 글', defaultName: 'selfReaction' as const, legacy: null, condition: { type: 'flag', field: 'selfReaction', value: true } },
	].map(r => ({ ...r, condition: r.condition as import('./NoteCleanupCondition.js').CleanupCondition, action: 'keep', enabled: true, automatic: false }));
}
