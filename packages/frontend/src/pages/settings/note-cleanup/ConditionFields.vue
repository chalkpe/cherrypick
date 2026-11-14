<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div class="_gaps_m" data-condition-fields>
	<template v-if="condition.type === 'keyword'">
		<MkTextarea :modelValue="condition.value" @update:modelValue="patch({ value: $event })"><template #label>{{ i18n.ts._noteCleanup.keyword }}</template><template #caption>{{ i18n.ts._noteCleanup.keywordHelp }}</template></MkTextarea>
		<fieldset :class="$style.checks">
			<legend>{{ i18n.ts._noteCleanup.targets }}</legend>
			<label v-for="(label, target) in targetNames" :key="target"><input type="checkbox" :checked="condition.targets.includes(target)" @change="patch({ targets: toggle(condition.targets, target) })"> {{ label }}</label>
		</fieldset>
		<MkFolder :defaultOpen="false" :canPage="false" accessible>
			<template #label>{{ i18n.ts._noteCleanup.advanced }}</template>
			<div class="_gaps_m">
				<MkSwitch :modelValue="condition.mode === 'regex'" @update:modelValue="patch({ mode: $event ? 'regex' : 'literal', flags: $event ? condition.flags : '' })">{{ i18n.ts._noteCleanup.useRegex }}</MkSwitch>
				<MkInput v-if="condition.mode === 'regex'" :modelValue="condition.flags" @update:modelValue="patch({ flags: $event })"><template #label>{{ i18n.ts._noteCleanup.flags }}</template></MkInput>
			</div>
		</MkFolder>
	</template>
	<template v-else-if="condition.type === 'age'">
		<MkInput :modelValue="condition.seconds / unit" type="number" step="any" :min="0" @update:modelValue="patch({ seconds: $event == null ? NaN : $event * unit })"><template #label>{{ i18n.ts._noteCleanup.amount }}</template></MkInput>
		<MkSelect v-select-label="i18n.ts._noteCleanup.unit" :modelValue="unit" :items="units" @update:modelValue="changeUnit"><template #label>{{ i18n.ts._noteCleanup.unit }}</template></MkSelect>
		<MkSelect v-select-label="i18n.ts._noteCleanup.operator" :modelValue="condition.operator" :items="operators" @update:modelValue="patch({ operator: $event })"><template #label>{{ i18n.ts._noteCleanup.operator }}</template></MkSelect>
	</template>
	<template v-else-if="condition.type === 'count'">
		<MkSelect v-select-label="i18n.ts._noteCleanup.count" :modelValue="condition.field" :items="counts" @update:modelValue="patch({ field: $event })"><template #label>{{ i18n.ts._noteCleanup.count }}</template></MkSelect>
		<MkInput :modelValue="condition.value" type="number" :min="0" :step="1" @update:modelValue="patch({ value: $event ?? NaN })"><template #label>{{ i18n.ts._noteCleanup.amount }}</template></MkInput>
		<MkSelect v-select-label="i18n.ts._noteCleanup.operator" :modelValue="condition.operator" :items="operators" @update:modelValue="patch({ operator: $event })"><template #label>{{ i18n.ts._noteCleanup.operator }}</template></MkSelect>
	</template>
	<MkSelect v-else-if="condition.type === 'flag'" v-select-label="flagNames[condition.field]" :modelValue="condition.value ? 'yes' : 'no'" :items="booleans" @update:modelValue="patch({ value: $event === 'yes' })"><template #label>{{ flagNames[condition.field] }}</template></MkSelect>
	<fieldset v-else-if="condition.type === 'visibility'" :class="$style.checks">
		<legend>{{ i18n.ts._noteCleanup.visibility }}</legend>
		<label v-for="value in visibilities" :key="value"><input type="checkbox" :checked="condition.values.includes(value)" @change="patch({ values: toggle(condition.values, value) })"> {{ i18n.ts._visibility[value] }}</label>
	</fieldset>
	<template v-else-if="condition.type === 'clip'">
		<MkSelect v-select-label="i18n.ts._noteCleanup.clip" :modelValue="condition.ids === null ? 'all' : 'selected'" :items="clipModes" @update:modelValue="patch({ ids: $event === 'all' ? null : [] })"><template #label>{{ i18n.ts._noteCleanup.clip }}</template></MkSelect>
		<ReferencePicker v-if="condition.ids !== null" kind="clip" :modelValue="condition.ids" @update:modelValue="patch({ ids: $event })"/>
	</template>
	<ReferencePicker v-else-if="condition.type === 'channel'" kind="channel" :modelValue="condition.ids" @update:modelValue="patch({ ids: $event })"/>
	<MkInput v-else-if="condition.type === 'hashtag'" :modelValue="condition.value" @update:modelValue="patch({ value: $event })"><template #label>{{ i18n.ts._noteCleanup.hashtag }}</template></MkInput>
</div>
</template>
<script lang="ts" setup>
import { ref } from 'vue';
import { ageUnit, flagNames, targetNames } from './labels.js';
import ReferencePicker from './ReferencePicker.vue';
import { vSelectLabel } from './select-label.js';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkFolder from '@/components/MkFolder.vue';
import { i18n } from '@/i18n.js';
import { convertAgeSeconds } from '@/utility/note-cleanup-editor.js';
const props = defineProps<{ condition: Condition }>();
const emit = defineEmits<{ (ev: 'update', value: Condition): void }>();
const unit = ref(props.condition.type === 'age' ? ageUnit(props.condition.seconds) : 86400);
const units = [1, 60, 3600, 86400].map((value, i) => ({ value, label: [i18n.ts._noteCleanup.seconds, i18n.ts._noteCleanup.minutes, i18n.ts._noteCleanup.hours, i18n.ts._noteCleanup.days][i] }));
const operators = (['gte', 'gt', 'lte', 'lt'] as const).map(value => ({ value, label: i18n.ts._noteCleanup[value] }));
const counts = (['reactions', 'renotes'] as const).map(value => ({ value, label: i18n.ts._noteCleanup[value] }));
const booleans = [{ value: 'yes', label: i18n.ts._noteCleanup.yes }, { value: 'no', label: i18n.ts._noteCleanup.no }];
const clipModes = [{ value: 'all', label: i18n.ts._noteCleanup.allClips }, { value: 'selected', label: i18n.ts._noteCleanup.selectedClips }];
const visibilities = ['public', 'home', 'followers', 'specified'] as const;

function toggle<T>(values: T[], value: T): T[] { return values.includes(value) ? values.filter(v => v !== value) : [...values, value]; }

function changeUnit(value: number) {
	if (props.condition.type !== 'age') return;
	// 표시 수량은 그대로 두고 저장된 초 값만 새 단위로 변환한다.
	const seconds = convertAgeSeconds(props.condition.seconds, unit.value, value);
	unit.value = value;
	emit('update', { ...props.condition, seconds } as Condition);
}

function patch(value: Record<string, unknown>) { emit('update', { ...props.condition, ...value } as Condition); }
</script>
<style lang="scss" module>
.checks { margin: 0; padding: 0; border: none; display: flex; flex-direction: column; gap: 12px; }
</style>
