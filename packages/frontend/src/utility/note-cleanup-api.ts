/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Endpoints } from 'cherrypick-js';
import type { NoteCleanupDefaultName, NoteCleanupCondition } from 'cherrypick-js/entities.js';
import { misskeyApi } from '@/utility/misskey-api.js';

export type CleanupRule = Endpoints['i/note-cleanup/list']['res']['rules'][number];
export type CleanupPreview = Endpoints['i/note-cleanup/preview']['res'];
export type CleanupDraft = { name: string; defaultName?: NoteCleanupDefaultName | null; action: 'keep' | 'delete'; condition: NoteCleanupCondition };

function storedInput(rule: Pick<CleanupRule, 'id' | 'action' | 'condition'>) {
	return { ruleId: rule.id, action: rule.action, condition: rule.condition };
}

export const cleanupApi = {
	clips: (untilId?: string) => misskeyApi('clips/list', { limit: 100, untilId }),
	channels: (query: string, untilId?: string) => misskeyApi('channels/search', { query, limit: 100, untilId }),
	list: () => misskeyApi('i/note-cleanup/list'),
	save: (input: CleanupDraft, ruleId?: string) => ruleId
		? misskeyApi('i/note-cleanup/update', { name: input.defaultName ? undefined : input.name, action: input.action, condition: input.condition, ruleId, ...(input.action === 'keep' ? { automatic: false } : {}) })
		// misskeyApi가 요청 객체에 i 토큰을 써넣으므로 호출자의 초안 대신 복사본을 넘긴다
		: misskeyApi('i/note-cleanup/create', { name: input.name, action: input.action, condition: input.condition }),
	delete: (ruleId: string) => misskeyApi('i/note-cleanup/delete', { ruleId }),
	preview: (ruleIds: string[], afterId?: string) => misskeyApi('i/note-cleanup/preview', { ruleIds, afterId, limit: 100 }),
	// 화면이 먼저 확인창을 거치므로 항상 confirmed를 붙여 요청한다.
	setEnabled: (rule: Pick<CleanupRule, 'id' | 'action' | 'condition'>, enabled: boolean) => misskeyApi('i/note-cleanup/update', { ...storedInput(rule), enabled, confirmed: true }),
	setAutomatic: (rule: Pick<CleanupRule, 'id' | 'action' | 'condition'>, automatic: boolean, confirmed = false) => misskeyApi('i/note-cleanup/update', { ...storedInput(rule), automatic, ...(confirmed ? { confirmed: true } : {}) }),
	request: (ruleIds: string[]) => misskeyApi('i/note-cleanup/request', { ruleIds }),
};
