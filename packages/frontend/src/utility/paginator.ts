/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, shallowRef, triggerRef } from 'vue';
import * as Misskey from 'cherrypick-js';
import type { ComputedRef, Ref, ShallowRef, UnwrapRef } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';

const MAX_ITEMS = 30;
const MAX_QUEUE_ITEMS = 100;
const FIRST_FETCH_LIMIT = 15;
const SECOND_FETCH_LIMIT = 30;

export type MisskeyEntity = {
	id: string;
	createdAt: string;
	_shouldInsertAd_?: boolean;
};

type AbsEndpointType = {
	req: unknown;
	res: unknown;
};

type FilterByEpRes<E extends Record<string, AbsEndpointType>> = {
	[K in keyof E]: E[K]['res'] extends Array<{ id: string }> ? K : never
}[keyof E];
export type PaginatorCompatibleEndpointPaths = FilterByEpRes<Misskey.Endpoints>;
export type PaginatorCompatibleEndpoints = {
	[K in PaginatorCompatibleEndpointPaths]: Misskey.Endpoints[K];
};

export type ExtractorFunction<P extends IPaginator, T> = (item: UnwrapRef<P['items']>[number]) => T;

export interface IPaginator<T = unknown, _T = T & MisskeyEntity> {
	/**
	 * 外部から直接操作しないでください
	 */
	items: Ref<_T[]> | ShallowRef<_T[]>;
	queuedAheadItemsCount: Ref<number>;
	fetching: Ref<boolean>;
	fetchingOlder: Ref<boolean>;
	fetchingNewer: Ref<boolean>;
	canFetchOlder: Ref<boolean>;
	canFetchNewer: Ref<boolean>;
	canSearch: boolean;
	error: Ref<boolean>;
	computedParams: ComputedRef<Misskey.Endpoints[PaginatorCompatibleEndpointPaths]['req'] | null | undefined> | null;
	initialId: MisskeyEntity['id'] | null;
	initialDate: number | null;
	initialDirection: 'newer' | 'older';
	noPaging: boolean;
	searchQuery: Ref<null | string>;
	order: Ref<'newest' | 'oldest'>;

	init(): Promise<void>;
	reload(): Promise<void>;
	fetchOlder(): Promise<void>;
	fetchNewer(options?: { toQueue?: boolean }): Promise<void>;
	trim(trigger?: boolean): void;
	unshiftItems(newItems: (_T)[]): void;
	pushItems(oldItems: (_T)[]): void;
	prepend(item: _T): void;
	enqueue(item: _T): void;
	releaseQueue(): void;
	removeItem(id: string): void;
	updateItem(id: string, updater: (item: _T) => _T): void;
}

export class Paginator<
	Endpoint extends PaginatorCompatibleEndpointPaths,
	E extends PaginatorCompatibleEndpoints[Endpoint] = PaginatorCompatibleEndpoints[Endpoint],
	T extends E['res'][number] & MisskeyEntity = E['res'][number] & MisskeyEntity,
	SRef extends boolean = false,
> implements IPaginator {
	/**
	 * 外部から直接操作しないでください
	 */
	public items: SRef extends true ? ShallowRef<T[]> : Ref<T[]>;

	public queuedAheadItemsCount = ref(0);
	public fetching = ref(true);
	public fetchingOlder = ref(false);
	public fetchingNewer = ref(false);
	public canFetchOlder = ref(false);
	public canFetchNewer = ref(false);
	public canSearch = false;
	public error = ref(false);
	private endpoint: Endpoint;
	private limit: number;
	private params: E['req'] | (() => E['req']);
	public computedParams: ComputedRef<E['req'] | null | undefined> | null;
	public initialId: MisskeyEntity['id'] | null = null;
	public initialDate: number | null = null;

	// 初回読み込み時、initialIdを基準にそれより新しいものを取得するか古いものを取得するか
	// newer: initialIdより新しいものを取得する
	// older: initialIdより古いものを取得する (default)
	public initialDirection: 'newer' | 'older';

	private offsetMode: boolean;
	private olderCursorParams: ((lastItem: T) => Partial<E['req']>) | null;
	public noPaging: boolean;
	public searchQuery = ref<null | string>('');
	private searchParamName: keyof E['req'] | 'search';
	private canFetchDetection: 'safe' | 'limit' | null = null;
	private aheadQueue: T[] = [];
	private pendingOlderItems: T[] = [];
	private useShallowRef: SRef;
	private insertByIdOrder: boolean;

	// 配列内の要素をどのような順序で並べるか
	// newest: 新しいものが先頭 (default)
	// oldest: 古いものが先頭
	// NOTE: このようなプロパティを用意してこっち側で並びを管理せずに、Setで持っておき参照者側が好きに並び変えるような設計の方がすっきりしそうなものの、Vueのレンダリングのたびに並び替え処理が発生することになったりしそうでパフォーマンス上の懸念がある
	public order: Ref<'newest' | 'oldest'>;

	constructor(endpoint: Endpoint, props: {
		limit?: number;
		params?: E['req'] | (() => E['req']);
		computedParams?: ComputedRef<E['req'] | null | undefined>;

		/**
		 * 検索APIのような、ページング不可なエンドポイントを利用する場合
		 * (そのようなAPIをこの関数で使うのは若干矛盾してるけど)
		 */
		noPaging?: boolean;

		offsetMode?: boolean;

		/**
		 * サイズ順・名前順など id 以外で並ぶエンドポイント向け。
		 * 過去方向の読み込みで、最も古い id の代わりに最後に読み込んだ要素から作ったパラメータを渡す
		 */
		olderCursorParams?: (lastItem: T) => Partial<E['req']>;

		initialId?: MisskeyEntity['id'];
		initialDate?: number | null;
		initialDirection?: 'newer' | 'older';

		order?: 'newest' | 'oldest';

		// 一部のAPIはさらに遡れる場合でもパフォーマンス上の理由でlimit以下の結果を返す場合があり、その場合はsafe、それ以外はlimitにすることを推奨
		canFetchDetection?: 'safe' | 'limit';

		useShallowRef?: SRef;

		/**
		 * prepend / releaseQueue で加える要素を、先頭ではなく id 順の位置に差し込む (order が newest のときのみ)。
		 * リモートから遅れて届いたノートのように、表示中の先頭より古い id の要素がストリーミングで流れてくる場合向け
		 */
		insertByIdOrder?: boolean;

		canSearch?: boolean;
		searchParamName?: keyof E['req'];
	}) {
		this.endpoint = endpoint;
		this.useShallowRef = (props.useShallowRef ?? false) as SRef;
		this.insertByIdOrder = props.insertByIdOrder ?? false;
		if (this.useShallowRef) {
			this.items = shallowRef<T[]>([]);
		} else {
			this.items = ref<T[]>([]) as Ref<T[]>;
		}

		this.limit = props.limit ?? FIRST_FETCH_LIMIT;
		this.params = props.params ?? {};
		this.computedParams = props.computedParams ?? null;
		this.order = ref(props.order ?? 'newest');
		this.initialId = props.initialId ?? null;
		this.initialDate = props.initialDate ?? null;
		this.initialDirection = props.initialDirection ?? 'older';
		this.canFetchDetection = props.canFetchDetection ?? null;
		this.noPaging = props.noPaging ?? false;
		this.offsetMode = props.offsetMode ?? false;
		this.olderCursorParams = props.olderCursorParams ?? null;
		this.canSearch = props.canSearch ?? false;
		this.searchParamName = props.searchParamName ?? 'search';

		this.getNewestId = this.getNewestId.bind(this);
		this.getOldestId = this.getOldestId.bind(this);
		this.init = this.init.bind(this);
		this.reload = this.reload.bind(this);
		this.fetchOlder = this.fetchOlder.bind(this);
		this.fetchNewer = this.fetchNewer.bind(this);
		this.unshiftItems = this.unshiftItems.bind(this);
		this.pushItems = this.pushItems.bind(this);
		this.prepend = this.prepend.bind(this);
		this.enqueue = this.enqueue.bind(this);
		this.releaseQueue = this.releaseQueue.bind(this);
		this.removeItem = this.removeItem.bind(this);
		this.updateItem = this.updateItem.bind(this);
	}

	private getNewestId(): string | null | undefined {
		// 様々な要因により並び順は保証されないのでソートが必要
		if (this.aheadQueue.length > 0) {
			return this.aheadQueue.map(x => x.id).sort().at(-1);
		}
		return this.items.value.map(x => x.id).sort().at(-1);
	}

	private getOldestId(): string | null | undefined {
		// 様々な要因により並び順は保証されないのでソートが必要
		return this.items.value.map(x => x.id).sort().at(0);
	}

	private getLastLoadedItem(): T {
		// fetchOlder は items.value.length === 0 のとき呼ばれないので必ず存在する
		return (this.order.value === 'oldest' ? this.items.value.at(0) : this.items.value.at(-1))!;
	}

	public async init(): Promise<void> {
		this.items.value = [];
		this.aheadQueue = [];
		this.pendingOlderItems = [];
		this.queuedAheadItemsCount.value = 0;
		this.fetching.value = true;

		const data: E['req'] = {
			...(typeof this.params === 'function' ? this.params() : this.params),
			...(this.computedParams ? this.computedParams.value : {}),
			...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
			limit: this.limit ?? FIRST_FETCH_LIMIT,
			allowPartial: true,
			...((this.initialId == null && this.initialDate == null) && this.initialDirection === 'newer' ? {
				sinceId: '0',
			} : this.initialDirection === 'newer' ? {
				sinceId: this.initialId ?? undefined,
				sinceDate: this.initialDate ?? undefined,
			} : (this.initialId || this.initialDate) && this.initialDirection === 'older' ? {
				untilId: this.initialId ?? undefined,
				untilDate: this.initialDate ?? undefined,
			} : {}),
		};

		const apiRes = (await misskeyApi(this.endpoint, data).catch(_ => {
			this.error.value = true;
			this.fetching.value = false;
			return null;
		})) as T[] | null;

		if (apiRes == null) {
			return;
		}

		// 逆順で返ってくるので
		if ((this.initialId || this.initialDate) && this.initialDirection === 'newer') {
			apiRes.reverse();
		}

		for (let i = 0; i < apiRes.length; i++) {
			const item = apiRes[i];
			if (i === 3) item._shouldInsertAd_ = true;
		}

		// ロード中のストリーミング分は、応答で読み込み範囲が確定してから差し込む
		const streamedItems = this.shouldInsertByIdOrder() ? this.items.value : [];
		if (streamedItems.length > 0) this.items.value = [];
		this.pushItems(apiRes);

		if (this.canFetchDetection === 'limit') {
			if (apiRes.length < FIRST_FETCH_LIMIT) {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = false;
			} else {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (apiRes.length === 0 || this.noPaging) {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = false;
			} else {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = true;
			}
		}

		if (streamedItems.length > 0) {
			this.insertItemsByIdOrder(streamedItems);
			if (this.useShallowRef) triggerRef(this.items);
		}

		this.error.value = false;
		this.fetching.value = false;
	}

	public reload(): Promise<void> {
		return this.init();
	}

	public async fetchOlder(): Promise<void> {
		if (!this.canFetchOlder.value || this.fetching.value || this.fetchingOlder.value || this.items.value.length === 0) return;
		this.fetchingOlder.value = true;

		const data: E['req'] = {
			...(typeof this.params === 'function' ? this.params() : this.params),
			...(this.computedParams ? this.computedParams.value : {}),
			...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
			limit: SECOND_FETCH_LIMIT,
			...(this.offsetMode ? {
				offset: this.items.value.length,
			} : this.olderCursorParams ? this.olderCursorParams(this.getLastLoadedItem()) : {
				untilId: this.getOldestId(),
			}),
		};

		const apiRes = (await misskeyApi<T[]>(this.endpoint, data).catch(_ => {
			return null;
		})) as T[] | null;

		this.fetchingOlder.value = false;

		if (apiRes == null) {
			return;
		}

		for (let i = 0; i < apiRes.length; i++) {
			const item = apiRes[i];
			if (i === 10) item._shouldInsertAd_ = true;
		}

		if (this.order.value === 'oldest') {
			this.unshiftItems(apiRes.toReversed(), false);
		} else {
			this.pushItems(apiRes);
		}

		if (this.canFetchDetection === 'limit') {
			if (apiRes.length < FIRST_FETCH_LIMIT) {
				this.canFetchOlder.value = false;
			} else {
				this.canFetchOlder.value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (apiRes.length === 0) {
				this.canFetchOlder.value = false;
			} else {
				this.canFetchOlder.value = true;
			}
		}

		// 応答に含まれなかった遅着ノートも確定した読み込み範囲に差し込み、失敗時は次の成功まで保持する
		if (this.pendingOlderItems.length > 0) {
			const pendingItems = this.pendingOlderItems;
			this.pendingOlderItems = [];
			this.insertItemsByIdOrder(pendingItems);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}

	public async fetchNewer(options: {
		toQueue?: boolean;
	} = {}): Promise<void> {
		this.fetchingNewer.value = true;

		const data: E['req'] = {
			...(typeof this.params === 'function' ? this.params() : this.params),
			...(this.computedParams ? this.computedParams.value : {}),
			...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
			limit: SECOND_FETCH_LIMIT,
			...(this.offsetMode ? {
				offset: this.items.value.length,
			} : {
				sinceId: this.getNewestId(),
			}),
		};

		const apiRes = (await misskeyApi<T[]>(this.endpoint, data).catch(_ => {
			return null;
		})) as T[] | null;

		this.fetchingNewer.value = false;

		if (apiRes == null || apiRes.length === 0) {
			this.canFetchNewer.value = false;
			// 余計なre-renderを防止するためここで終了
			return;
		}

		if (options.toQueue) {
			this.aheadQueue.unshift(...apiRes.toReversed());
			if (this.aheadQueue.length > MAX_QUEUE_ITEMS) {
				this.aheadQueue = this.aheadQueue.slice(0, MAX_QUEUE_ITEMS);
			}
			this.queuedAheadItemsCount.value = this.aheadQueue.length;
		} else {
			if (this.order.value === 'oldest') {
				this.pushItems(apiRes);
			} else {
				this.unshiftItems(apiRes.toReversed(), false);
			}
		}

		if (this.canFetchDetection === 'limit') {
			if (apiRes.length < FIRST_FETCH_LIMIT) {
				this.canFetchNewer.value = false;
			} else {
				this.canFetchNewer.value = true;
			}
		}
		// canFetchDetectionが'safe'の場合・apiRes.length === 0 の場合は apiRes.length === 0 の場合に canFetchNewer.value = false になるが、
		// 余計な re-render を防ぐために上部で処理している。そのため、ここでは何もしない
	}

	public trim(trigger = true): void {
		if (this.items.value.length >= MAX_ITEMS) this.canFetchOlder.value = true;
		this.items.value = this.items.value.slice(0, MAX_ITEMS);
		if (this.useShallowRef && trigger) triggerRef(this.items);
	}

	public unshiftItems(newItems: T[], trim = true): void {
		if (newItems.length === 0) return; // これやらないと余計なre-renderが走る
		this.items.value.unshift(...newItems.filter(x => !this.items.value.some(y => y.id === x.id))); // ストリーミングやポーリングのタイミングによっては重複することがあるため
		if (trim) this.trim(true);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public pushItems(oldItems: T[]): void {
		if (oldItems.length === 0) return; // これやらないと余計なre-renderが走る
		this.items.value.push(...oldItems.filter(x => !this.items.value.some(y => y.id === x.id))); // 再読み込み中にストリーミングで届いたものが応答にも含まれることがあるため
		if (this.useShallowRef) triggerRef(this.items);
	}

	public prepend(item: T): void {
		if (this.items.value.some(x => x.id === item.id)) return;
		if (this.shouldInsertByIdOrder()) {
			this.insertItemsByIdOrder([item], this.fetching.value);
		} else {
			this.items.value.unshift(item);
		}
		this.trim(false);
		if (this.useShallowRef) triggerRef(this.items);
	}

	private shouldInsertByIdOrder(): boolean {
		return this.insertByIdOrder && this.order.value === 'newest';
	}

	private insertItemsByIdOrder(newItems: T[], keepOlder = false): void {
		// 古いものから順に差し込むと、新しいものほど前に来る
		for (const item of newItems.toSorted((a, b) => a.id < b.id ? -1 : 1)) {
			if (this.items.value.some(x => x.id === item.id)) continue;
			const index = this.items.value.findIndex(x => x.id < item.id);
			if (index !== -1) {
				this.items.value.splice(index, 0, item);
			} else if (keepOlder || this.items.value.length === 0 || !this.canFetchOlder.value) {
				this.items.value.push(item);
			} else if (this.fetchingOlder.value) {
				// 取得中のページがこのノートを含むとは限らず、応答前に末尾へ追加するとページングの基準もずれるため別に保持する
				this.pendingOlderItems.push(item);
			}
			// ロード中は範囲が未確定なので保持し、それ以外で最古より古く、まだ遡れるものは過去方向の読み込みに任せる
		}
	}

	public enqueue(item: T): void {
		this.aheadQueue.unshift(item);
		if (this.aheadQueue.length > MAX_QUEUE_ITEMS) {
			this.aheadQueue.pop();
		}
		this.queuedAheadItemsCount.value = this.aheadQueue.length;
	}

	public releaseQueue(): void {
		if (this.aheadQueue.length === 0) return; // これやらないと余計なre-renderが走る
		if (this.shouldInsertByIdOrder()) {
			this.insertItemsByIdOrder(this.aheadQueue, this.fetching.value);
			this.trim(true);
			if (this.useShallowRef) triggerRef(this.items);
		} else {
			this.unshiftItems(this.aheadQueue);
		}
		this.aheadQueue = [];
		this.queuedAheadItemsCount.value = 0;
	}

	public removeItem(id: string): void {
		// TODO: queueからも消す
		this.pendingOlderItems = this.pendingOlderItems.filter(item => item.id !== id);

		const index = this.items.value.findIndex(x => x.id === id);
		if (index !== -1) {
			this.items.value.splice(index, 1);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}

	public updateItem(id: string, updater: (item: T) => T): void {
		// TODO: queueのも更新

		const index = this.items.value.findIndex(x => x.id === id);
		if (index !== -1) {
			const item = this.items.value[index]!;
			this.items.value[index] = updater(item);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}
}
