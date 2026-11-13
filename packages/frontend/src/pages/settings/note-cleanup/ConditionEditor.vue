<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<section :data-condition-path="path.join('.')" :class="$style.block" tabindex="-1">
	<div :class="$style.tools">
		<MkButton small @click="replacing = !replacing">{{ i18n.ts._noteCleanup.replace }}</MkButton>
		<MkButton small @click="invert">{{ i18n.ts._noteCleanup.not }}</MkButton>
		<template v-if="removable">
			<MkButton small @click="emit('duplicate', path)">{{ i18n.ts._noteCleanup.duplicate }}</MkButton>
			<MkButton small :disabled="siblingIndex === 0" @click="emit('shift', path, -1)">{{ i18n.ts._noteCleanup.up }}</MkButton>
			<MkButton small :disabled="siblingIndex === siblingCount - 1" @click="emit('shift', path, 1)">{{ i18n.ts._noteCleanup.down }}</MkButton>
			<MkButton small @click="emit('move', path, $event)">{{ i18n.ts._noteCleanup.move }}</MkButton>
			<MkButton small danger @click="emit('remove', path)">{{ i18n.ts.remove }}</MkButton>
		</template>
	</div>
	<MkFolder accessible :canPage="false" :withSpacer="false" :defaultOpen="true">
		<template #label>{{ conditionNames[condition.type] }}</template>
		<template #caption>{{ summary(condition) }}</template>
		<div class="_gaps_m">
			<div>{{ i18n.ts._noteCleanup.condition }}: {{ path.length ? path.map(i => i + 1).join(' › ') : i18n.ts._noteCleanup.root }}</div>
			<MkInfo v-if="invalid" warn>{{ i18n.ts._noteCleanup.incomplete }}</MkInfo>
			<ConditionPicker v-if="replacing" :label="i18n.ts._noteCleanup.replace" @choose="replace"/>
			<template v-if="condition.type === 'all' || condition.type === 'any'">
				<MkSelect v-select-label="i18n.ts._noteCleanup.condition" :modelValue="condition.type" :items="groups" @update:modelValue="emit('change', path, { ...condition, type: $event })"><template #label>{{ i18n.ts._noteCleanup.condition }}</template></MkSelect>
				<MkDraggable :modelValue="draggableChildren" direction="vertical" withGaps manualDragStart @update:modelValue="reorder">
					<template #default="{ item, index, dragStart }">
						<button class="_button" draggable="true" :aria-label="i18n.ts._noteCleanup.move" @dragstart="dragStart"><i class="ti ti-grip-vertical"></i> {{ i18n.ts._noteCleanup.move }}</button>
						<ConditionEditor
							:condition="item.condition" :path="[...path, index]" :reveal="reveal" removable :siblingIndex="index" :siblingCount="draggableChildren.length"
							@change="(p, c, key) => emit('change', p, c, key)" @remove="p => emit('remove', p)" @duplicate="p => emit('duplicate', p)" @shift="(p, delta) => emit('shift', p, delta)" @move="(p, ev) => emit('move', p, ev)"
						/>
					</template>
				</MkDraggable>
				<MkButton small @click="adding = !adding">{{ i18n.ts.add }}</MkButton>
				<ConditionPicker v-if="adding" @choose="add"/>
			</template>
			<ConditionEditor
				v-else-if="condition.type === 'not'" :condition="condition.child" :path="[...path, 0]" :reveal="reveal"
				@change="(p, c, key) => emit('change', p, c, key)" @remove="p => emit('remove', p)" @duplicate="p => emit('duplicate', p)" @shift="(p, delta) => emit('shift', p, delta)" @move="(p, ev) => emit('move', p, ev)"
			/>
			<ConditionFields v-else :condition="condition" @update="emit('change', path, $event, path.join('.'))"/>
		</div>
	</MkFolder>
	<div :class="$style.summary">{{ fullSummary(condition) }}</div>
</section>
</template>
<script lang="ts" setup>
import { computed, ref } from 'vue';
import { conditionNames, summary, fullSummary } from './labels.js';
import ConditionFields from './ConditionFields.vue';
import ConditionPicker from './ConditionPicker.vue';
import { vSelectLabel } from './select-label.js';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import MkFolder from '@/components/MkFolder.vue';
import MkButton from '@/components/MkButton.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkDraggable from '@/components/MkDraggable.vue';
import MkInfo from '@/components/MkInfo.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { childrenOf, conditionId, incompletePaths } from '@/utility/note-cleanup-editor.js';
const props = withDefaults(defineProps<{ condition: Condition; path: number[]; reveal: number; removable?: boolean; siblingIndex?: number; siblingCount?: number }>(), { removable: false, siblingIndex: 0, siblingCount: 1 });
const emit = defineEmits<{
	(ev: 'change', path: number[], value: Condition, key?: string): void;
	(ev: 'remove', path: number[]): void;
	(ev: 'duplicate', path: number[]): void;
	(ev: 'shift', path: number[], delta: number): void;
	(ev: 'move', path: number[], event: MouseEvent): void;
}>();
const replacing = ref(false);
const adding = ref(false);
const invalid = computed(() => incompletePaths(props.condition).some(path => path.length === 0));
const groups = [{ value: 'all' as const, label: conditionNames.all }, { value: 'any' as const, label: conditionNames.any }];
const draggableChildren = computed(() => childrenOf(props.condition).map(condition => ({ id: conditionId(condition), condition })));

function invert() { emit('change', props.path, { type: 'not', child: structuredClone(props.condition) }); }

async function replace(value: Condition) {
	if (childrenOf(props.condition).length) {
		const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._noteCleanup.replaceWarning });
		if (canceled) return;
	}
	emit('change', props.path, value);
	replacing.value = false;
}

function add(value: Condition) {
	if (props.condition.type !== 'all' && props.condition.type !== 'any') return;
	emit('change', props.path, { ...props.condition, children: [...props.condition.children, value] });
	adding.value = false;
}

function reorder(items: { id: string; condition: Condition }[]) {
	if (props.condition.type !== 'all' && props.condition.type !== 'any') return;
	// 다른 묶음의 드롭은 허용하지 않고 명시적인 이동 메뉴로 처리한다.
	if (items.length !== draggableChildren.value.length || items.some(item => !draggableChildren.value.some(current => current.id === item.id))) return;
	emit('change', props.path, { ...props.condition, children: items.map(item => item.condition) });
}
</script>
<style lang="scss" module>
.block:focus-within { border-inline-start-color: var(--MI_THEME-accent); }
.block { min-width: 0; border-inline-start: 2px solid var(--MI_THEME-divider); padding-inline-start: 5px; }
.tools { display: flex; flex-wrap: wrap; gap: 6px; margin-block: 8px; }
.summary { overflow-wrap: anywhere; white-space: pre-wrap; padding: 8px; font-size: 0.85em; }
</style>
