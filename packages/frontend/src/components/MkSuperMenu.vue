<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" class="rrevdjwu" :class="{ grid, draggable }">
	<MkInput
		v-if="searchIndex && searchIndex.length > 0"
		v-model="searchQuery"
		:placeholder="i18n.ts.search"
		type="search"
		style="margin-bottom: 16px;"
		@input.passive="searchOnInput"
		@keydown="searchOnKeyDown"
	>
		<template #prefix><i class="ti ti-search"></i></template>
	</MkInput>

	<template v-if="rawSearchQuery == ''">
		<!-- 제목 묶음 순서 끌기: 모든 묶음을 바깥 목록으로 그린다. 제목 없는 묶음은 손잡이가 없어 끌 수 없다. -->
		<MkDraggable
			v-if="draggable && draggableGroups && hasTitledGroups"
			class="groupList"
			:modelValue="groupEntries"
			direction="vertical"
			manualDragStart
			canNest
			:group="`${dragGroup}-groups`"
			@update:modelValue="entries => emit('reorderGroups', entries.map(entry => entry.index))"
		>
			<template #default="{ item: entry, dragStart }">
				<div class="group" :class="entry.group.title ? 'titled' : 'untitled'" :data-chat-section-id="entry.group.id">
					<div v-if="entry.group.title" class="titleRow">
						<button class="_button dragHandle" draggable="true" tabindex="-1" :aria-label="i18n.ts.dragToReorder" @dragstart.stop="dragStart"><i class="ti ti-grip-vertical" aria-hidden="true"></i></button>
						<button v-if="collapsibleTitles && entry.group.foldable" class="_button titleButton" :aria-expanded="entry.group.expanded !== false" @click="emit('toggleGroup', entry.index)">
							<span class="titleText">{{ entry.group.title }}</span>
							<span v-if="entry.group.indicated" class="itemIndicator titleIndicator" :class="{ _blink: entry.group.pulsing !== false }"><i class="_indicatorCircle"></i></span>
							<span class="titleDivider"></span>
							<i class="ti" :class="entry.group.expanded !== false ? 'ti-chevron-up' : 'ti-chevron-down'" aria-hidden="true"></i>
						</button>
						<div v-else class="title">{{ entry.group.title }}</div>
					</div>
					<!-- 접힌 묶음은 끌어 놓을 수 없다. 지금 보는 채널만 일반 항목으로 남긴다. -->
					<div v-if="isFolded(entry.group)" class="items">
						<template v-for="(item, i) in entry.group.items">
							<a v-if="item.type === 'a'" :href="item.href" :target="item.target" :aria-current="item.ariaCurrent" class="_button item" :class="{ danger: item.danger, active: item.active }">
								<span>
									<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
									<span class="text">{{ item.text }}</span>
								</span>
								<span v-if="'indicated' in item && item.indicated" class="itemIndicator" :class="{ _blink: item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
							</a>
							<button v-else-if="item.type === 'button'" class="_button item" :class="{ danger: item.danger, active: item.active }" :disabled="item.active" :aria-current="item.ariaCurrent" @click="ev => item.action(ev)">
								<span>
									<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
									<span class="text">{{ item.text }}</span>
								</span>
								<span v-if="item.indicated" class="itemIndicator" :class="{ _blink: item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
							</button>
							<MkA v-else :to="item.to" :aria-current="item.ariaCurrent" class="_button item" :class="{ danger: item.danger, active: item.active }">
								<span>
									<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
									<span class="text">{{ item.text }}</span>
								</span>
								<span v-if="item.indicated" class="itemIndicator" :class="{ _blink: item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
							</MkA>
						</template>
					</div>
					<MkDraggable
						v-else
						class="items"
						:modelValue="draggableItems(entry.group.items)"
						direction="vertical"
						manualDragStart
						:group="dragGroup"
						@update:modelValue="entries => emit('reorder', entry.index, entries.map(itemEntry => itemEntry.item))"
					>
						<template #default="{ item: itemEntry, dragStart: itemDragStart }">
							<div class="dragRow">
								<button class="_button dragHandle" draggable="true" tabindex="-1" :aria-label="i18n.ts.dragToReorder" @dragstart.stop="itemDragStart"><i class="ti ti-grip-vertical" aria-hidden="true"></i></button>
								<a v-if="itemEntry.item.type === 'a'" :href="itemEntry.item.href" :target="itemEntry.item.target" :draggable="false" :aria-current="itemEntry.item.ariaCurrent" class="_button item" :class="{ danger: itemEntry.item.danger, active: itemEntry.item.active }">
									<span>
										<span v-if="itemEntry.item.icon" class="icon"><i :class="itemEntry.item.icon" class="ti-fw"></i></span>
										<span class="text">{{ itemEntry.item.text }}</span>
									</span>
									<span v-if="'indicated' in itemEntry.item && itemEntry.item.indicated" class="itemIndicator" :class="{ _blink: itemEntry.item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
								</a>
								<button v-else-if="itemEntry.item.type === 'button'" class="_button item" :class="{ danger: itemEntry.item.danger, active: itemEntry.item.active }" :disabled="itemEntry.item.active" :aria-current="itemEntry.item.ariaCurrent" @click="ev => invokeAction(itemEntry.item, ev)">
									<span>
										<span v-if="itemEntry.item.icon" class="icon"><i :class="itemEntry.item.icon" class="ti-fw"></i></span>
										<span class="text">{{ itemEntry.item.text }}</span>
									</span>
									<span v-if="itemEntry.item.indicated" class="itemIndicator" :class="{ _blink: itemEntry.item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
								</button>
								<MkA v-else :to="itemEntry.item.to" :draggable="false" :aria-current="itemEntry.item.ariaCurrent" class="_button item" :class="{ danger: itemEntry.item.danger, active: itemEntry.item.active }">
									<span>
										<span v-if="itemEntry.item.icon" class="icon"><i :class="itemEntry.item.icon" class="ti-fw"></i></span>
										<span class="text">{{ itemEntry.item.text }}</span>
									</span>
									<span v-if="itemEntry.item.indicated" class="itemIndicator" :class="{ _blink: itemEntry.item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
								</MkA>
							</div>
						</template>
					</MkDraggable>
				</div>
			</template>
		</MkDraggable>
		<template v-else>
		<div v-for="(group, groupIndex) in def" :key="group.id ?? groupIndex" class="group" :data-chat-section-id="group.id">
			<button v-if="group.title && collapsibleTitles && group.foldable" class="_button titleButton" :aria-expanded="group.expanded !== false" @click="emit('toggleGroup', groupIndex)">
				<span class="titleText">{{ group.title }}</span>
				<span v-if="group.indicated" class="itemIndicator titleIndicator" :class="{ _blink: group.pulsing !== false }"><i class="_indicatorCircle"></i></span>
				<span class="titleDivider"></span>
				<i class="ti" :class="group.expanded !== false ? 'ti-chevron-up' : 'ti-chevron-down'" aria-hidden="true"></i>
			</button>
			<div v-else-if="group.title" class="title">{{ group.title }}</div>

			<div v-if="!draggable || isFolded(group)" class="items">
				<template v-for="(item, i) in group.items">
					<a v-if="item.type === 'a'" :href="item.href" :target="item.target" :aria-current="item.ariaCurrent" class="_button item" :class="{ danger: item.danger, active: item.active }">
						<span>
							<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
							<span class="text">{{ item.text }}</span>
						</span>
						<span v-if="'indicated' in item && item.indicated" class="itemIndicator" :class="{ _blink: item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
					</a>
					<button v-else-if="item.type === 'button'" class="_button item" :class="{ danger: item.danger, active: item.active }" :disabled="item.active" :aria-current="item.ariaCurrent" @click="ev => item.action(ev)">
						<span>
							<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
							<span class="text">{{ item.text }}</span>
						</span>
						<span v-if="item.indicated" class="itemIndicator" :class="{ _blink: item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
					</button>
					<MkA v-else :to="item.to" :aria-current="item.ariaCurrent" class="_button item" :class="{ danger: item.danger, active: item.active }">
						<span>
							<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
							<span class="text">{{ item.text }}</span>
						</span>
						<span v-if="item.indicated" class="itemIndicator" :class="{ _blink: item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
					</MkA>
				</template>
			</div>
			<MkDraggable
				v-else
				class="items"
				:modelValue="draggableItems(group.items)"
				direction="vertical"
				manualDragStart
				:group="dragGroup"
				@update:modelValue="entries => emit('reorder', groupIndex, entries.map(entry => entry.item))"
			>
				<template #default="{ item: entry, dragStart }">
					<div class="dragRow">
						<button class="_button dragHandle" draggable="true" tabindex="-1" :aria-label="i18n.ts.dragToReorder" @dragstart.stop="dragStart"><i class="ti ti-grip-vertical" aria-hidden="true"></i></button>
						<a v-if="entry.item.type === 'a'" :href="entry.item.href" :target="entry.item.target" :draggable="false" :aria-current="entry.item.ariaCurrent" class="_button item" :class="{ danger: entry.item.danger, active: entry.item.active }">
							<span>
								<span v-if="entry.item.icon" class="icon"><i :class="entry.item.icon" class="ti-fw"></i></span>
								<span class="text">{{ entry.item.text }}</span>
							</span>
							<span v-if="'indicated' in entry.item && entry.item.indicated" class="itemIndicator" :class="{ _blink: entry.item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
						</a>
						<button v-else-if="entry.item.type === 'button'" class="_button item" :class="{ danger: entry.item.danger, active: entry.item.active }" :disabled="entry.item.active" :aria-current="entry.item.ariaCurrent" @click="ev => invokeAction(entry.item, ev)">
							<span>
								<span v-if="entry.item.icon" class="icon"><i :class="entry.item.icon" class="ti-fw"></i></span>
								<span class="text">{{ entry.item.text }}</span>
							</span>
							<span v-if="entry.item.indicated" class="itemIndicator" :class="{ _blink: entry.item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
						</button>
						<MkA v-else :to="entry.item.to" :draggable="false" :aria-current="entry.item.ariaCurrent" class="_button item" :class="{ danger: entry.item.danger, active: entry.item.active }">
							<span>
								<span v-if="entry.item.icon" class="icon"><i :class="entry.item.icon" class="ti-fw"></i></span>
								<span class="text">{{ entry.item.text }}</span>
							</span>
							<span v-if="entry.item.indicated" class="itemIndicator" :class="{ _blink: entry.item.pulsing !== false }"><i class="_indicatorCircle"></i></span>
						</MkA>
					</div>
				</template>
			</MkDraggable>
		</div>
		</template>
	</template>
	<template v-else>
		<div v-for="item, index in searchResult">
			<MkA
				:to="item.path + '#' + item.id"
				class="_button searchResultItem"
				:class="{ selected: searchSelectedIndex !== null && searchSelectedIndex === index }"
			>
				<span v-if="item.icon" class="icon"><i :class="item.icon" class="ti-fw"></i></span>
				<span class="text">
					<template v-if="item.isRoot">
						{{ item.label }}
					</template>
					<template v-else>
						<span style="opacity: 0.7; font-size: 90%; word-break: break-word;">{{ item.parentLabels.join(' > ') }}</span>
						<br>
						<span style="word-break: break-word;">{{ item.label }}</span>
					</template>
				</span>
				<span v-if="'indicated' in item && item.indicated" class="itemIndicator _blink"><i class="_indicatorCircle"></i></span>
			</MkA>
		</div>
	</template>
</div>
</template>

<script lang="ts">
import type { Awaitable } from '@/types/misc.js';

export type SuperMenuDef = {
	title?: string;
	// 묶음 식별자. 끌기 순서 바꾸기와 화면 시험에서 쓴다.
	id?: string;
	// collapsibleTitles를 켠 화면에서 묶음 제목을 접고 펴는 단추로 그린다.
	foldable?: boolean;
	expanded?: boolean;
	// 접힌 묶음 머리글의 미읽음 점. 채널 점과 같은 규칙이다.
	indicated?: boolean;
	pulsing?: boolean;
	items: ({
		type: 'a';
		id?: string;
		href: string;
		target?: string;
		icon?: string;
		text: string;
		danger?: boolean;
		active?: boolean;
		indicated?: boolean;
		pulsing?: boolean;
		ariaCurrent?: 'page' | 'step' | 'location' | 'date' | 'time' | boolean;
	} | {
		type: 'button';
		id?: string;
		icon?: string;
		text: string;
		danger?: boolean;
		active?: boolean;
		action: (ev: PointerEvent) => Awaitable<void>;
		indicated?: boolean;
		pulsing?: boolean;
		ariaCurrent?: 'page' | 'step' | 'location' | 'date' | 'time' | boolean;
	} | {
		type?: 'link';
		id?: string;
		to: string;
		icon?: string;
		text: string;
		danger?: boolean;
		active?: boolean;
		indicated?: boolean;
		pulsing?: boolean;
		ariaCurrent?: 'page' | 'step' | 'location' | 'date' | 'time' | boolean;
	})[];
};
</script>

<script lang="ts" setup>
import { useTemplateRef, ref, watch, nextTick, computed, onUnmounted } from 'vue';
import { throttle } from 'throttle-debounce';
import { getScrollContainer } from '@@/js/scroll.js';
import type { SearchIndexItem } from '@/utility/inapp-search.js';
import MkInput from '@/components/MkInput.vue';
import MkDraggable from '@/components/MkDraggable.vue';
import { i18n } from '@/i18n.js';
import { useRouter } from '@/router.js';
import { genId } from '@/utility/id.js';
import { initIntlString, compareStringIncludes } from '@/utility/intl-string.js';

const props = defineProps<{
	def: SuperMenuDef[];
	grid?: boolean;
	searchIndex?: SearchIndexItem[];
	draggable?: boolean;
	// 이 화면에서만 켜는 옵션: 묶음 제목을 접기 단추로 그리고, 제목 묶음 순서를 끈다.
	collapsibleTitles?: boolean;
	draggableGroups?: boolean;
}>();

const emit = defineEmits<{
	(ev: 'reorder', groupIndex: number, items: SuperMenuDef['items']): void;
	(ev: 'reorderGroups', groupIndices: number[]): void;
	(ev: 'toggleGroup', groupIndex: number): void;
}>();

const dragGroup = genId();
const hasTitledGroups = computed(() => props.def.some(group => group.title != null));
const groupEntries = computed(() => props.def.map((group, index) => ({ id: group.id ?? `group-${index}`, index, group })));

function isFolded(group: SuperMenuDef): boolean {
	return group.foldable === true && group.expanded === false;
}

function draggableItems(items: SuperMenuDef['items']): { id: string; item: SuperMenuDef['items'][number] }[] {
	return items.map((item, index) => ({ id: item.id ?? ('to' in item ? item.to : undefined) ?? `${index}`, item }));
}

function invokeAction(item: SuperMenuDef['items'][number], ev: PointerEvent) {
	if (item.type === 'button') void item.action(ev);
}

type SearchResultItem = {
	id: string;
	path: string;
	label: string;
	icon?: string;
	isRoot: boolean;
	parentLabels: string[];
};

initIntlString();

const maxSearchResult = 20;

const router = useRouter();
const rootEl = useTemplateRef('rootEl');

const searchQuery = ref('');
const rawSearchQuery = ref('');

const searchSelectedIndex = ref<null | number>(null);
const searchResult = ref<SearchResultItem[]>([]);
const searchIndexItemByIdComputed = computed(() => props.searchIndex && new Map<string, SearchIndexItem>(props.searchIndex.map(i => [i.id, i])));

watch(searchQuery, (value) => {
	rawSearchQuery.value = value;
});

function execSearch(value: string) {
	const newResult: SearchResultItem[] = [];

	const searchIndexItemById = searchIndexItemByIdComputed.value;
	if (searchIndexItemById != null) {
		const addSearchResult = (item: SearchIndexItem) => {
			let path: string | undefined = item.path;
			let icon: string | undefined = item.icon;
			const parentLabels: string[] = [];

			for (let current = searchIndexItemById.get(item.parentId ?? '');
				current != null;
				current = searchIndexItemById.get(current.parentId ?? '')) {
				path ??= current.path;
				icon ??= current.icon;
				parentLabels.push(current.label);
			}

			if (_DEV_ && path == null) throw new Error('path is null for ' + item.id);

			newResult.push({
				id: item.id,
				path: path ?? '/', // never gets `/`
				label: item.label,
				parentLabels: parentLabels.toReversed(),
				icon,
				isRoot: item.parentId == null,
			});
		};

		// label, keywords, texts の順に優先して表示

		const items = Array.from(searchIndexItemById.values());
		const matchedIds = new Set<string>();

		for (const item of items) {
			if (matchedIds.size >= maxSearchResult) break;
			if (matchedIds.has(item.id)) continue;
			if (compareStringIncludes(item.label, value)) {
				addSearchResult(item);
				matchedIds.add(item.id);
			}
		}

		for (const item of items) {
			if (matchedIds.size >= maxSearchResult) break;
			if (matchedIds.has(item.id)) continue;
			if (item.keywords.some((x) => compareStringIncludes(x, value))) {
				addSearchResult(item);
				matchedIds.add(item.id);
			}
		}

		for (const item of items) {
			if (matchedIds.size >= maxSearchResult) break;
			if (matchedIds.has(item.id)) continue;
			if (item.texts.some((x) => compareStringIncludes(x, value))) {
				addSearchResult(item);
				matchedIds.add(item.id);
			}
		}
	}

	searchResult.value = newResult;
}

const execSearchThrottled = throttle(150, execSearch);

onUnmounted(() => {
	execSearchThrottled.cancel();
});

watch(rawSearchQuery, (value) => {
	searchSelectedIndex.value = null;

	if (value === '') {
		// クリア時は即座にメニュー表示へ戻すため、保留中の検索も破棄する
		execSearchThrottled.cancel({ upcomingOnly: true });
		searchResult.value = [];
		return;
	}

	execSearchThrottled(value);
});

function searchOnInput(ev: InputEvent) {
	searchSelectedIndex.value = null;
	rawSearchQuery.value = (ev.target as HTMLInputElement).value;
}

function searchOnKeyDown(ev: KeyboardEvent) {
	if (ev.isComposing) return;

	if (ev.key === 'Enter' && searchSelectedIndex.value != null) {
		ev.preventDefault();
		router.pushByPath(searchResult.value[searchSelectedIndex.value].path + '#' + searchResult.value[searchSelectedIndex.value].id);
	} else if (ev.key === 'ArrowDown') {
		ev.preventDefault();
		const current = searchSelectedIndex.value ?? -1;
		searchSelectedIndex.value = current + 1 >= searchResult.value.length ? 0 : current + 1;
	} else if (ev.key === 'ArrowUp') {
		ev.preventDefault();
		const current = searchSelectedIndex.value ?? 0;
		searchSelectedIndex.value = current - 1 < 0 ? searchResult.value.length - 1 : current - 1;
	}

	if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
		nextTick(() => {
			if (!rootEl.value) return;
			const selectedEl = rootEl.value.querySelector<HTMLElement>('.searchResultItem.selected');
			if (selectedEl != null) {
				const scrollContainer = getScrollContainer(selectedEl);
				if (!scrollContainer) return;
				scrollContainer.scrollTo({
					top: selectedEl.offsetTop - scrollContainer.clientHeight / 2 + selectedEl.clientHeight / 2,
					behavior: 'instant',
				});
			}
		});
	}
}
</script>

<style lang="scss" scoped>
.rrevdjwu {
	> .group, > .groupList > div > .group {
		& + .group {
			margin-top: 16px;
			padding-top: 16px;
			border-top: solid 0.5px var(--MI_THEME-divider);
		}

		> .title {
			opacity: 0.7;
			margin: 0 0 8px 0;
			font-size: 0.9em;
		}

		> .titleRow {
			display: flex;
			align-items: center;
			gap: 2px;
			margin: 0 0 8px 0;

			> .dragHandle {
				flex-shrink: 0;
				padding: 8px;
				cursor: move;
				opacity: 0.5;
			}

			> .titleButton {
				flex: 1;
				min-width: 0;
				margin: 0;
			}

			> .title {
				flex: 1;
				min-width: 0;
				margin: 0;
			}
		}

		> .titleButton {
			position: relative;
			display: flex;
			align-items: center;
			width: 100%;
			box-sizing: border-box;
			margin: 0 0 8px 0;
			padding: 12px 16px 12px 8px;
			border-radius: 15px;
			font-size: 0.9em;
			opacity: 0.7;

			&:hover {
				background: var(--MI_THEME-panelHighlight);
				opacity: 1;
			}

			&:focus-visible {
				outline-offset: -2px;
			}

			> .titleText {
				padding-left: 34px;
				min-width: 0;
				text-align: left;
				overflow-wrap: anywhere;
			}

			> .titleDivider {
				flex: 1;
				min-width: 8px;
				height: 1px;
				margin: auto 8px;
				background: var(--MI_THEME-divider);
			}

			> .titleIndicator {
				position: absolute;
				top: 6px;
				left: 18px;
				color: var(--MI_THEME-navIndicator);
				font-size: 8px;
			}
		}

		> .items {
			.item {
				position: relative;
				display: flex;
				align-items: center;
				width: 100%;
				box-sizing: border-box;
				padding: 12px 16px 12px 8px;
				border-radius: 15px;
				font-size: 0.9em;
        margin-bottom: 0.3rem;

				&:hover {
					text-decoration: none;
					background: var(--MI_THEME-panelHighlight);
				}

				&:focus-visible {
					outline-offset: -2px;
				}

				&.active {
					color: var(--MI_THEME-accent);
					background: var(--MI_THEME-accentedBg);
				}

				&.danger {
					color: var(--MI_THEME-error);
				}

				> span {
					display: inherit;

					> .icon {
						width: 32px;
						margin-right: 2px;
						flex-shrink: 0;
						text-align: center;
						opacity: 0.8;
					}

					> .text {
						white-space: normal;
						padding-right: 12px;
						flex-shrink: 1;
					}
				}

        > .itemIndicator {
          position: absolute;
					top: 6px;
          left: 18px;
          color: var(--MI_THEME-navIndicator);
          font-size: 8px;
        }
			}
		}
	}

	// 바깥 끌기 목록에서는 묶음이 항목 안에 들어가므로 구분선을 항목 사이에 둔다.
	// 바깥 놓기 영역(위·아래 30px)이 안쪽 채널 행을 덮지 않도록 묶음 아래에 같은 높이의 여백을 둔다.
	> .groupList > div + div > .group {
		padding-top: 16px;
		border-top: solid 0.5px var(--MI_THEME-divider);
	}

	> .groupList > div > .group.titled {
		padding-bottom: 30px;
	}

	// 제목 없는 묶음은 끌 수 없으므로 바깥 놓기 영역을 두지 않는다.
	> .groupList > :deep(div:has(> div > .group.untitled) > div:first-child),
	> .groupList > :deep(div:has(> div > .group.untitled) > div:last-child) {
		display: none;
	}

	&.grid {
		> .group {
			margin-left: 0;
			margin-right: 0;

			& + .group {
				padding-top: 0;
				border-top: none;
			}

			> .title {
				font-size: 1em;
				opacity: 0.7;
				margin: 0 0 8px 16px;
			}

			> .titleButton {
				width: auto;
				margin: 0 0 8px 16px;
				padding: 4px 16px 4px 20px;
				font-size: 1em;

				> .titleText {
					padding-left: 0;
				}

				> .titleIndicator {
					top: calc(50% - 5px);
					left: 2px;
					font-size: 0.8em;
				}
			}

			> .items {
				display: grid;
				grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
				grid-gap: 16px;
				padding: 0 16px;

				> .item {
					flex-direction: column;
					text-align: center;
					padding: 0;
					position: relative;

					&:hover {
						text-decoration: none;
						background: none;
						color: var(--MI_THEME-accent);

						> span {
							> .icon {
								background: var(--MI_THEME-accentedBg);
							}
						}
					}

					> span {
						display: contents;

						> .icon {
							display: grid;
							place-content: center;
							margin-right: 0;
							margin-bottom: 6px;
							font-size: 1.5em;
							width: 60px;
							height: 60px;
							aspect-ratio: 1;
							background: var(--MI_THEME-panel);
							border-radius: 100%;
						}

						> .text {
							padding-right: 0;
							width: 100%;
							font-size: 0.8em;
						}
					}

          > .itemIndicator {
						display: flex;
						top: 0;
            left: calc(50% - 30px);
            font-size: 0.8em;
          }
				}
			}
		}
	}

	&.draggable {
		> .group > .items, > .groupList > div > .group > .items {
			.dragRow {
				display: flex;
				align-items: center;
				gap: 2px;
				min-width: 0;
			}

			.dragHandle {
				flex-shrink: 0;
				padding: 8px;
				cursor: move;
				opacity: 0.5;
			}

			.item {
				flex: 1;
				min-width: 0;
				width: auto;
			}
		}
	}

	.searchResultItem {
		position: relative;
		display: flex;
		align-items: center;
		width: 100%;
		box-sizing: border-box;
		padding: 9px 16px 9px 8px;
		border-radius: 9px;
		font-size: 0.9em;

		&:hover {
			text-decoration: none;
			background: var(--MI_THEME-panelHighlight);
		}

		&.selected {
			outline: 2px solid var(--MI_THEME-focus);
		}

		&:focus-visible,
		&.selected {
			outline-offset: -2px;
		}

		&.active {
			color: var(--MI_THEME-accent);
			background: var(--MI_THEME-accentedBg);
		}

		&.danger {
			color: var(--MI_THEME-error);
		}

		> .icon {
			width: 32px;
			margin-right: 2px;
			flex-shrink: 0;
			text-align: center;
			opacity: 0.8;
		}

		> .text {
			white-space: normal;
			padding-right: 12px;
			flex-shrink: 1;
		}

		> .itemIndicator {
			position: absolute;
			top: 6px;
			left: 18px;
			color: var(--MI_THEME-navIndicator);
			font-size: 8px;
		}
	}
}
</style>
