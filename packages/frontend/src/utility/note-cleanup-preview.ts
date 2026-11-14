/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ref, shallowRef } from 'vue';
import type { Ref, ShallowRef } from 'vue';
import type * as Misskey from 'cherrypick-js';
import type { IPaginator } from '@/utility/paginator.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import type { CleanupPreview } from '@/utility/note-cleanup-api.js';

// 저장된 규칙의 미리 보기를 기존 노트 타임라인 페이지네이션에 연결한다.
// 서버는 오래된 노트부터 지워질 노트만 돌려주며, 다음 페이지는 nextCursor로 잇는다.
export class CleanupPreviewPaginator implements IPaginator<Misskey.entities.Note> {
	public items: ShallowRef<Misskey.entities.Note[]> = shallowRef([]);
	public queuedAheadItemsCount = ref(0);
	public fetching = ref(true);
	public fetchingOlder = ref(false);
	public fetchingNewer = ref(false);
	public canFetchOlder = ref(false);
	public canFetchNewer = ref(false);
	public canSearch = false;
	public error = ref(false);
	public computedParams = null;
	public initialId: string | null = null;
	public initialDate: number | null = null;
	public initialDirection: 'newer' | 'older' = 'older';
	public noPaging = false;
	public searchQuery: Ref<null | string> = ref(null);
	public order: Ref<'newest' | 'oldest'> = ref('oldest');

	public errors: Ref<CleanupPreview['errors']> = ref([]);
	public rules: Ref<CleanupPreview['rules']> = ref([]);
	public complete = ref(false);

	private cursor: string | null = null;
	private loading = false;

	constructor(private ruleIds: string[]) {}

	public async init(): Promise<void> {
		await this.load(false);
	}

	public async reload(): Promise<void> {
		this.cursor = null;
		this.complete.value = false;
		this.canFetchNewer.value = false;
		await this.load(false);
	}

	private async load(append: boolean): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.error.value = false;
		if (append) this.fetchingNewer.value = true;
		else this.fetching.value = true;
		try {
			const page = await cleanupApi.preview(this.ruleIds, append ? this.cursor ?? undefined : undefined);
			this.errors.value = page.errors;
			this.rules.value = page.rules;
			this.complete.value = page.complete;
			this.cursor = page.nextCursor;
			this.canFetchNewer.value = !page.complete && page.nextCursor != null;
			this.items.value = append ? [...this.items.value, ...page.notes] : page.notes;
		} catch {
			this.error.value = true;
		} finally {
			this.fetching.value = false;
			this.fetchingNewer.value = false;
			this.loading = false;
		}
	}

	public async fetchOlder(): Promise<void> {}

	public async fetchNewer(): Promise<void> {
		if (this.canFetchNewer.value) await this.load(true);
	}

	public trim(): void {}

	public unshiftItems(items: Misskey.entities.Note[]): void {
		this.items.value = [...items, ...this.items.value];
	}

	public pushItems(items: Misskey.entities.Note[]): void {
		this.items.value = [...this.items.value, ...items];
	}

	public prepend(item: Misskey.entities.Note): void {
		this.items.value = [item, ...this.items.value];
	}

	public enqueue(): void {}

	public releaseQueue(): void {}

	public removeItem(id: string): void {
		this.items.value = this.items.value.filter(note => note.id !== id);
	}

	public updateItem(id: string, updater: (item: Misskey.entities.Note) => Misskey.entities.Note): void {
		this.items.value = this.items.value.map(note => note.id === id ? updater(note) : note);
	}
}
