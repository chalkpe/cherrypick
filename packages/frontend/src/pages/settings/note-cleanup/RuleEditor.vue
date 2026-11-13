<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<section ref="root" class="_gaps_m" :aria-busy="busy">
	<div :class="$style.tools">
		<MkButton :disabled="busy || !canUndo" @click="undo">{{ i18n.ts._noteCleanup.undo }}</MkButton>
		<MkButton :disabled="busy || !canRedo" @click="redo">{{ i18n.ts._noteCleanup.redo }}</MkButton>
		<MkButton v-if="rule" :disabled="busy || dirty" @click="menu">{{ i18n.ts.menu }}</MkButton>
	</div>
	<MkInfo>{{ i18n.ts._noteCleanup.draftOnly }}</MkInfo>
	<MkInput :modelValue="cleanupRuleName(draft, i18n.ts._noteCleanup)" @update:modelValue="edit({ ...draft, name: $event, defaultName: null }, 'name')"><template #label>{{ i18n.ts._noteCleanup.name }}</template></MkInput>
	<MkSelect v-select-label="i18n.ts._noteCleanup.action" :modelValue="draft.action" :items="actions" @update:modelValue="edit({ ...draft, action: $event })"><template #label>{{ i18n.ts._noteCleanup.action }}</template></MkSelect>
	<p v-if="rule">{{ rule.enabled ? i18n.ts._noteCleanup.enabled : i18n.ts._noteCleanup.disabled }} · {{ rule.automatic ? i18n.ts._noteCleanup.automatic : i18n.ts._noteCleanup.request }}</p>
	<MkInfo v-if="error || rule?.lastError" warn role="alert">
		{{ cleanupErrorMessage(activeError?.code ?? '', error ? undefined : rule?.action) }}
		<MkButton v-if="activeError && canRevealCleanupError(activeError.code, activeError.path)" small @click="revealError">{{ i18n.ts._noteCleanup.references }}</MkButton>
	</MkInfo>
	<div v-if="message" role="status">{{ message }}</div>
	<p>{{ i18n.ts._noteCleanup.limits }}</p>
	<fieldset :disabled="busy" :class="$style.fields">
		<legend>{{ i18n.ts._noteCleanup.condition }}</legend>
		<ConditionEditor :condition="draft.condition" :path="[]" :reveal="reveal" @change="change" @remove="remove" @duplicate="duplicate" @shift="shift" @move="move"/>
	</fieldset>
	<MkButton primary :disabled="busy || !draft.name.trim()" @click="save">{{ i18n.ts.save }}</MkButton>
	<MkInfo v-if="dirty">{{ i18n.ts._noteCleanup.saveFirst }}</MkInfo>
	<template v-if="rule && draft.action === 'delete'">
		<label :class="$style.automatic"><input type="checkbox" :checked="rule.automatic" :disabled="busy || dirty || !rule.enabled" @change="automatic"> {{ i18n.ts._noteCleanup.automatic }}</label>
		<MkInfo>{{ i18n.ts._noteCleanup.queueHelp }}</MkInfo>
		<MkButton :disabled="busy || blocked || dirty || !rule.enabled" @click="request">{{ i18n.ts._noteCleanup.request }}</MkButton>
		<MkInfo v-if="!rule.enabled">{{ i18n.ts._noteCleanup.disabled }}</MkInfo>
		<Preview v-if="!dirty" :key="`${rule.id}:${previewVersion}`" :disabled="!rule.enabled" :ruleIds="[rule.id]" :immediate="pendingAutomatic" @loaded="previewLoaded" @invalidated="previewToken = undefined"/>
		<template v-if="pendingAutomatic">
			<MkInfo warn>{{ i18n.ts._noteCleanup.automaticConfirm }}</MkInfo>
			<MkButton primary :disabled="busy || !previewToken" @click="confirmAutomatic">{{ i18n.ts._noteCleanup.automatic }}</MkButton>
			<MkButton @click="pendingAutomatic = false; previewToken = undefined">{{ i18n.ts.cancel }}</MkButton>
		</template>
	</template>
</section>
</template>
<script lang="ts" setup>
import { computed, nextTick, ref, shallowRef, toRaw } from 'vue';
import ConditionEditor from './ConditionEditor.vue';
import Preview from './Preview.vue';
import { vSelectLabel } from './select-label.js';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import type { CleanupDraft, CleanupPreview, CleanupRule } from '@/utility/note-cleanup-api.js';
import { cleanupErrorMessage, cleanupFailure, canRevealCleanupError } from '@/utility/note-cleanup-errors.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import { assertSize, conditionAt, createCondition, createHistory, groupPaths, incompletePaths, moveCondition, removeCondition, replaceCondition, serverConditionPath } from '@/utility/note-cleanup-editor.js';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
const props = defineProps<{ rule?: CleanupRule; blocked?: boolean }>();
const emit = defineEmits<{ (ev: 'saved', id?: string): void; (ev: 'refresh'): void }>();
const root = ref<HTMLElement>();
const initial: CleanupDraft = props.rule ? { name: props.rule.name, defaultName: props.rule.defaultName, action: props.rule.action, condition: toRaw(props.rule.condition) as Condition } : { name: '', action: 'delete', condition: createCondition('keyword') };
const history = createHistory(initial);
const draft = shallowRef(history.current);
const revision = ref(0);
const busy = ref(false);
const reveal = ref(0);
const error = shallowRef<{ code: string; path: string } | null>(null);
const activeError = computed(() => error.value ?? props.rule?.lastError);
const message = ref('');
const pendingAutomatic = ref(false);
const previewToken = ref<string>();
const previewVersion = ref(0);
const canUndo = computed(() => { void revision.value; return history.canUndo; });
const canRedo = computed(() => { void revision.value; return history.canRedo; });
const hasChanges = computed(() => JSON.stringify(draft.value) !== JSON.stringify(initial));
const dirty = computed(() => !props.rule || hasChanges.value);
defineExpose({ dirty: hasChanges });
const actions = [{ value: 'keep' as const, label: i18n.ts._noteCleanup.keep }, { value: 'delete' as const, label: i18n.ts._noteCleanup.delete }];

function edit(value: CleanupDraft, key?: string) {
	if (busy.value) return;
	try { assertSize(value.condition); } catch { error.value = { code: 'LIMIT', path: '' }; return; }
	history.push(toRaw(value), key);
	draft.value = history.current;
	revision.value++;
	pendingAutomatic.value = false;
	previewToken.value = undefined;
	error.value = null;
}

function undo() { draft.value = history.undo(); revision.value++; previewToken.value = undefined; pendingAutomatic.value = false; }

function redo() { draft.value = history.redo(); revision.value++; previewToken.value = undefined; pendingAutomatic.value = false; }

function change(path: number[], value: Condition, key?: string) { edit({ ...draft.value, condition: replaceCondition(draft.value.condition, path, value) }, key); }

function remove(path: number[]) { edit({ ...draft.value, condition: removeCondition(draft.value.condition, path) }); }

function duplicate(path: number[]) {
	const parentPath = path.slice(0, -1);
	const parent = conditionAt(draft.value.condition, parentPath);
	if (parent.type !== 'all' && parent.type !== 'any') return;
	const children = [...parent.children];
	children.splice(path.at(-1)! + 1, 0, structuredClone(conditionAt(draft.value.condition, path)));
	change(parentPath, { ...parent, children });
}

async function focus(path: number[]) {
	// 열린 폴더를 다시 만들지 않고 목적지의 조상만 펼친다.
	for (let depth = 0; depth <= path.length; depth++) {
		const section = root.value?.querySelector<HTMLElement>(`[data-condition-path="${path.slice(0, depth).join('.')}"]`);
		const folder = section?.querySelector<HTMLElement>(':scope > [role="group"]');
		if (folder?.getAttribute('aria-expanded') === 'false') {
			folder.querySelector<HTMLButtonElement>('[data-testid="folder-header"]')?.click();
			await nextTick();
			await nextTick();
		}
	}
	const element = root.value?.querySelector<HTMLElement>(`[data-condition-path="${path.join('.')}"]`);
	const control = element?.querySelector<HTMLElement>('input, textarea, [role="button"][aria-haspopup]');
	(control?.closest('[data-condition-path]') === element ? control : element)?.focus();
	element?.scrollIntoView?.({ block: 'nearest' });
}

function shift(path: number[], delta: number) {
	const parentPath = path.slice(0, -1);
	const parent = conditionAt(draft.value.condition, parentPath);
	if (parent.type !== 'all' && parent.type !== 'any') return;
	const index = path.at(-1)!;
	const target = index + delta;
	if (target < 0 || target >= parent.children.length) return;
	const children = [...parent.children];
	[children[index], children[target]] = [children[target], children[index]];
	change(parentPath, { ...parent, children });
	message.value = i18n.ts._noteCleanup.moved;
	void focus([...parentPath, target]);
}

function move(path: number[], event: MouseEvent) {
	// 자기 자신·하위 묶음이나 깊이 제한을 넘는 묶음처럼 moveCondition이 거부할 대상은 후보에서 뺀다.
	const targets = groupPaths(draft.value.condition).filter(target => {
		try { moveCondition(draft.value.condition, path, target); return true; } catch { return false; }
	});
	os.popupMenu(targets.map(target => ({ text: target.length ? target.map(i => i + 1).join(' › ') : i18n.ts._noteCleanup.root, action: () => {
		try {
			const result = moveCondition(draft.value.condition, path, target);
			edit({ ...draft.value, condition: result });
			message.value = i18n.ts._noteCleanup.moved;
			void focus([]);
		} catch { error.value = { code: 'LIMIT', path: `condition.${path.join('.')}` }; }
	} })), event.currentTarget as HTMLElement);
}

function revealError() {
	const value = error.value?.path ?? props.rule?.lastError?.path ?? '';
	const path = serverConditionPath(value);
	void focus(path);
}

async function run(operation: () => Promise<unknown>) {
	if (busy.value) return;
	busy.value = true;
	error.value = null;
	try { await operation(); } catch (caught) {
		error.value = cleanupFailure(caught);
		previewToken.value = undefined;
		if (canRevealCleanupError(error.value.code, error.value.path)) void revealError();
		emit('refresh');
	} finally { busy.value = false; }
}

async function save() {
	const incomplete = incompletePaths(draft.value.condition);
	if (incomplete.length) { error.value = { code: 'INCOMPLETE', path: `condition.${incomplete[0].join('.')}` }; await focus(incomplete[0]); return; }
	await run(async () => { const result = await cleanupApi.save(draft.value, props.rule?.id); emit('saved', result.rule.id); });
}

async function request() {
	if (props.blocked || !props.rule || dirty.value || !props.rule.enabled) return;
	await run(async () => { const result = await cleanupApi.request([props.rule!.id]); message.value = result.queued ? i18n.ts._noteCleanup.queued : i18n.ts._noteCleanup.notQueued; });
}

async function automatic(event: Event) {
	(event.target as HTMLInputElement).checked = props.rule?.automatic ?? false;
	if (!props.rule || dirty.value || !props.rule.enabled) return;
	if (props.rule.automatic) await run(async () => { await cleanupApi.setAutomatic(props.rule!, false); emit('saved', props.rule!.id); });
	else if (props.rule.automaticConfirmed) await run(async () => { await cleanupApi.setAutomatic(props.rule!, true); emit('saved', props.rule!.id); });
	else { previewToken.value = undefined; pendingAutomatic.value = true; previewVersion.value++; }
}

function previewLoaded(page: CleanupPreview) { previewToken.value = page.errors.length ? undefined : page.previewToken; }

async function confirmAutomatic() {
	if (!props.rule || !previewToken.value || dirty.value) return;
	const { canceled } = await os.confirm({ type: 'warning', title: cleanupRuleName(props.rule, i18n.ts._noteCleanup), text: i18n.ts._noteCleanup.automaticConfirm, okText: i18n.ts._noteCleanup.automatic });
	if (canceled) return;
	await run(async () => { await cleanupApi.setAutomatic(props.rule!, true, previewToken.value); emit('saved', props.rule!.id); });
}

function menu(event: MouseEvent) {
	if (!props.rule) return;
	const rule = props.rule;
	os.popupMenu([{
		text: rule.enabled ? i18n.ts._noteCleanup.disable : i18n.ts._noteCleanup.enable,
		action: async () => {
			const impact = rule.action === 'keep' ? (rule.enabled ? i18n.ts._noteCleanup.disableKeep : i18n.ts._noteCleanup.enableKeep) : (rule.enabled ? i18n.ts._noteCleanup.disableDelete : i18n.ts._noteCleanup.enableDelete);
			const { canceled } = await os.confirm({ type: 'warning', title: `${cleanupRuleName(rule, i18n.ts._noteCleanup)} · ${rule.action === 'keep' ? i18n.ts._noteCleanup.keep : i18n.ts._noteCleanup.delete}`, text: `${impact}\n${i18n.ts._noteCleanup.queueHelp}`, okText: rule.enabled ? i18n.ts._noteCleanup.disable : i18n.ts._noteCleanup.enable });
			if (canceled) return;
			await run(async () => { await cleanupApi.setEnabled(rule, !rule.enabled, true); emit('saved', rule.id); });
		},
	}, {
		text: i18n.ts.delete, danger: true, action: async () => {
			const { canceled } = await os.confirm({ type: 'warning', title: cleanupRuleName(rule, i18n.ts._noteCleanup), text: i18n.ts._noteCleanup.removeRule });
			if (canceled) return;
			await run(async () => { await cleanupApi.delete(rule.id); emit('saved'); });
		},
	}], event.currentTarget as HTMLElement);
}
</script>
<style lang="scss" module>
.tools { display: flex; flex-wrap: wrap; gap: 8px; }
.fields { margin: 0; padding: 0; border: 0; min-width: 0; }
.automatic { display: flex; align-items: center; gap: 8px; }
</style>
