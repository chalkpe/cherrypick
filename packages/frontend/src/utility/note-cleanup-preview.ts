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

// 후보가 없는 범위를 자동으로 이어 읽는 최대 요청 수. 요청 한도에 걸리지 않게 작게 둔다.
const MAX_AUTO_REQUESTS = 3;

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
	// 현재 첫 페이지가 성공적으로 읽혔는지. 저장 뒤 다시 읽는 동안에는 거짓이다.
	public ready = ref(false);

	private cursor: string | null = null;
	private generation = 0;
	private appending = false;

	constructor(private ruleIds: string[]) {}

	public async init(): Promise<void> {
		await this.load(false, false);
	}

	public async reload(): Promise<void> {
		// 진행 중인 응답은 세대가 바뀌어 버린다. 첫 페이지 읽는 중이어도 새 첫 페이지를 바로 요청한다.
		this.generation++;
		this.cursor = null;
		this.appending = false;
		this.ready.value = false;
		// 새 응답이 올 때까지 지금 보이는 목록·더 보기·빈 문구를 그대로 둔다. 먼저 비우면 높이가 줄어 스크롤 위치가 잘린다.
		await this.load(false, true);
	}

	private async load(append: boolean, reload = false): Promise<void> {
		if (append) {
			if (this.appending) return;
			this.appending = true;
		}
		const generation = this.generation;
		this.error.value = false;
		if (append) this.fetchingNewer.value = true;
		// 다시 읽기는 로딩으로 바꾸지 않는다. 보이는 목록(빈 문구 포함)을 그대로 둬야 스크롤 위치가 유지된다.
		else this.fetching.value = reload ? false : this.items.value.length === 0;
		try {
			// 후보 없이 끝난 읽기(오류 포함)는 읽은 데까지의 커서에서 이어 읽는다.
			const resume = !append && this.items.value.length === 0 && !this.complete.value;
			let page = await cleanupApi.preview(this.ruleIds, append || resume ? this.cursor ?? undefined : undefined);
			// 저장 뒤 도착한 낡은 응답은 항목·커서·오류 어느 것도 건드리지 않는다.
			if (generation !== this.generation) return;
			// 보이는 후보가 없는 범위는 작은 상한까지만 이어 읽는다. 남은 범위는 더 보기로 이어 읽는다.
			let requests = 1;
			while (page.notes.length === 0 && (append ? this.items.value.length === 0 : true) && !page.complete && page.nextCursor != null && requests < MAX_AUTO_REQUESTS) {
				this.cursor = page.nextCursor;
				page = await cleanupApi.preview(this.ruleIds, this.cursor);
				if (generation !== this.generation) return;
				requests++;
			}
			this.errors.value = page.errors;
			this.rules.value = page.rules;
			this.complete.value = page.complete;
			this.cursor = page.nextCursor;
			this.canFetchNewer.value = !page.complete && page.nextCursor != null;
			this.items.value = append ? [...this.items.value, ...page.notes] : page.notes;
			if (!append) this.ready.value = true;
		} catch {
			if (generation !== this.generation) return;
			this.error.value = true;
			if (!append) this.ready.value = false;
		} finally {
			if (generation === this.generation) {
				this.fetching.value = false;
				this.fetchingNewer.value = false;
				if (append) this.appending = false;
			}
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
