<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<section :data-condition-path="path.join('.')" :class="[$style.block, { [$style.invalid]: invalid }]" tabindex="-1">
	<div :class="$style.header">
		<MkSelect v-select-label="i18n.ts._noteCleanup.condition" :modelValue="typeValue" :items="typeOptions" :class="$style.typeSelect" @update:modelValue="changeType"/>
		<button v-if="removable" class="_button" :class="$style.dragHandle" :draggable="true" :aria-label="i18n.ts._noteCleanup.move" @dragstart.stop="dragStartCallback"><i class="ti ti-menu-2"></i></button>
		<button v-if="removable" ref="menuButtonEl" class="_button" :class="$style.menuButton" :aria-label="i18n.ts.menu" @click="menu"><i class="ti ti-dots"></i></button>
		<button v-if="removable" class="_button" :class="$style.remove" :aria-label="i18n.ts.remove" @click="emit('remove', path)"><i class="ti ti-x"></i></button>
	</div>
	<div v-if="condition.type === 'all' || condition.type === 'any'" class="_gaps">
		<MkDraggable :modelValue="draggableChildren" direction="vertical" withGaps manualDragStart @update:modelValue="reorder">
			<template #default="{ item, index, dragStart }">
				<div :class="$style.item">
					<ConditionEditor
						:condition="item.condition" :path="[...path, index]" :dragStartCallback="dragStart" removable :siblingIndex="index" :siblingCount="draggableChildren.length"
						@change="(p: number[], c: Condition, key?: string) => emit('change', p, c, key)" @remove="(p: number[]) => emit('remove', p)" @duplicate="(p: number[]) => emit('duplicate', p)" @shift="(p: number[], delta: number) => emit('shift', p, delta)" @move="(p: number[], anchor: HTMLElement | null) => emit('move', p, anchor)"
					/>
				</div>
			</template>
		</MkDraggable>
		<MkButton rounded style="margin: 0 auto;" @click="add"><i class="ti ti-plus"></i> {{ i18n.ts._noteCleanup.addCondition }}</MkButton>
	</div>
	<ConditionFields v-else :key="condition.type" :condition="condition" @update="emit('change', path, $event, path.join('.'))"/>
</section>
</template>
<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import { conditionNames, flagNames } from './labels.js';
import ConditionFields from './ConditionFields.vue';
import { vSelectLabel } from './select-label.js';
import type { NoteCleanupCondition as Condition, NoteCleanupFlag } from 'cherrypick-js/entities.js';
import MkButton from '@/components/MkButton.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkDraggable from '@/components/MkDraggable.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { childrenOf, conditionId, createCondition, incompletePaths } from '@/utility/note-cleanup-editor.js';
const props = withDefaults(defineProps<{ condition: Condition; path: number[]; removable?: boolean; siblingIndex?: number; siblingCount?: number; dragStartCallback?: (ev: DragEvent) => void }>(), { removable: false, siblingIndex: 0, siblingCount: 1 });
const emit = defineEmits<{
	(ev: 'change', path: number[], value: Condition, key?: string): void;
	(ev: 'remove', path: number[]): void;
	(ev: 'duplicate', path: number[]): void;
	(ev: 'shift', path: number[], delta: number): void;
	(ev: 'move', path: number[], anchor: HTMLElement | null): void;
}>();
const menuButtonEl = useTemplateRef<HTMLElement>('menuButtonEl');
const invalid = computed(() => incompletePaths(props.condition).some(path => path.length === 0));
const typeOptions = [
	{ value: 'keyword', label: conditionNames.keyword },
	{ value: 'age', label: conditionNames.age },
	{ value: 'count', label: conditionNames.count },
	...(Object.keys(flagNames) as NoteCleanupFlag[]).map(field => ({ value: `flag:${field}`, label: flagNames[field] })),
	{ value: 'visibility', label: conditionNames.visibility },
	{ value: 'channel', label: conditionNames.channel },
	{ value: 'clip', label: conditionNames.clip },
	{ value: 'hashtag', label: conditionNames.hashtag },
	{ value: 'all', label: conditionNames.all },
	{ value: 'any', label: conditionNames.any },
];
const typeValue = computed(() => props.condition.type === 'flag' ? `flag:${props.condition.field}` : props.condition.type);
const draggableChildren = computed(() => childrenOf(props.condition).map(condition => ({ id: conditionId(condition), condition })));

function changeType(value: string) {
	// 유형을 바꾸면 하위 조건은 새 유형의 기본값으로 다시 시작한다.
	const next = value.startsWith('flag:') ? { type: 'flag' as const, field: value.slice(5) as NoteCleanupFlag, value: true } : createCondition(value as Condition['type']);
	emit('change', props.path, next);
}

function add() {
	if (props.condition.type !== 'all' && props.condition.type !== 'any') return;
	emit('change', props.path, { ...props.condition, children: [...props.condition.children, createCondition('keyword')] });
}

function reorder(items: { id: string; condition: Condition }[]) {
	if (props.condition.type !== 'all' && props.condition.type !== 'any') return;
	// 다른 묶음의 드롭은 허용하지 않고 명시적인 이동 메뉴로 처리한다.
	if (items.length !== draggableChildren.value.length || items.some(item => !draggableChildren.value.some(current => current.id === item.id))) return;
	emit('change', props.path, { ...props.condition, children: items.map(item => item.condition) });
}

function menu() {
	os.popupMenu([{
		icon: 'ti ti-copy', text: i18n.ts._noteCleanup.duplicate, action: () => emit('duplicate', props.path),
	}, ...(props.siblingIndex > 0 ? [{
		icon: 'ti ti-arrow-up', text: i18n.ts._noteCleanup.up, action: () => emit('shift', props.path, -1),
	}] : []), ...(props.siblingIndex < props.siblingCount - 1 ? [{
		icon: 'ti ti-arrow-down', text: i18n.ts._noteCleanup.down, action: () => emit('shift', props.path, 1),
	}] : []), {
		icon: 'ti ti-arrows-move', text: i18n.ts._noteCleanup.move, action: () => emit('move', props.path, menuButtonEl.value),
	}], menuButtonEl.value);
}
</script>
<style lang="scss" module>
.block { min-width: 0; outline: none; }
// 상위 .item이 :has()로 이 클래스를 감지해 테두리 색을 바꾸는 상태 표시용 클래스다.
.invalid {}
.header { display: flex; align-items: center; margin-block: 8px; }
.typeSelect { flex: 1; min-width: 0; }
.dragHandle { cursor: move; margin-left: 10px; }
.menuButton { margin-left: 10px; }
.remove { margin-left: 10px; }
.item {
	border: solid 2px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	padding: 12px;

	&:hover { border-color: var(--MI_THEME-accent); }
	&:has(> .invalid) { border-color: var(--MI_THEME-warn); }
	&:focus-within { border-color: var(--MI_THEME-accent); }
}
</style>
