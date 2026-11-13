<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div class="_gaps_s">
	<MkInput v-model="query" type="search"><template #label>{{ i18n.ts._noteCleanup.searchCondition }}</template></MkInput>
	<MkSelect v-model="selection" v-select-label="label ?? i18n.ts._noteCleanup.chooseCondition" :items="items"><template #label>{{ label ?? i18n.ts._noteCleanup.chooseCondition }}</template></MkSelect>
	<MkButton :disabled="!items.some(item => item.value === selection)" @click="choose">{{ label ?? i18n.ts.add }}</MkButton>
</div>
</template>
<script lang="ts" setup>
import { computed, ref } from 'vue';
import { conditionNames, flagNames } from './labels.js';
import { vSelectLabel } from './select-label.js';
import type { NoteCleanupCondition as Condition, NoteCleanupFlag } from 'cherrypick-js/entities.js';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { createCondition } from '@/utility/note-cleanup-editor.js';

defineProps<{ label?: string }>();
const emit = defineEmits<{ (ev: 'choose', condition: Condition): void }>();
const query = ref('');
const selection = ref('keyword');
const options = [
	...Object.entries(conditionNames).filter(([type]) => type !== 'flag').map(([value, label]) => ({ value, label })),
	...Object.entries(flagNames).map(([field, label]) => ({ value: `flag:${field}`, label })),
];
const items = computed(() => options.filter(item => item.label.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));

function choose() {
	if (!items.value.some(item => item.value === selection.value)) return;
	const [type, field] = selection.value.split(':');
	const node = createCondition(type as Condition['type']);
	if (node.type === 'flag') node.field = field as NoteCleanupFlag;
	emit('choose', node);
}
</script>
