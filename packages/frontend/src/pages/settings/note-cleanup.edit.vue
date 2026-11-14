<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div class="_gaps_m">
	<MkInput v-model="draft.name" @update:modelValue="draft.defaultName = null">
		<template #label>{{ i18n.ts._noteCleanup.name }}</template>
	</MkInput>
	<MkSelect v-model="draft.action" :items="actions">
		<template #label>{{ i18n.ts._noteCleanup.action }}</template>
	</MkSelect>
	<FormSection>
		<template #label>{{ i18n.ts._noteCleanup.condition }}</template>
		<div class="_gaps_m">
			<MkInfo v-if="activeError" warn role="alert">
				{{ cleanupErrorMessage(activeError.code) }}
				<MkButton v-if="canRevealCleanupError(activeError.code, activeError.path)" small @click="revealError">{{ i18n.ts.edit }}</MkButton>
			</MkInfo>
			<div ref="editorRootEl">
				<ConditionEditor :condition="draft.condition" :path="[]" @change="change" @remove="remove" @duplicate="duplicate" @shift="shift" @move="move"/>
			</div>
		</div>
	</FormSection>
	<div class="_buttons">
		<MkButton primary inline :disabled="busy || !draft.name.trim()" @click="save"><i class="ti ti-device-floppy"></i> {{ i18n.ts.save }}</MkButton>
		<MkButton v-if="rule" inline :disabled="busy || dirty" @click="toggleEnabled"><i :class="rule.enabled ? 'ti ti-player-pause' : 'ti ti-player-play'"></i> {{ rule.enabled ? i18n.ts._noteCleanup.disable : i18n.ts._noteCleanup.enable }}</MkButton>
		<MkButton v-if="rule" danger inline :disabled="busy" @click="del"><i class="ti ti-trash"></i> {{ i18n.ts.delete }}</MkButton>
	</div>
	<FormSection v-if="rule && draft.action === 'delete'">
		<template #label>{{ i18n.ts._noteCleanup.notesToDelete }}</template>
		<fieldset :disabled="dirty || busy" :class="$style.run">
			<div class="_gaps_m">
				<Preview :ruleId="rule.id" :version="previewVersion"/>
				<MkButton :disabled="!rule.enabled" @click="requestNow"><i class="ti ti-player-play"></i> {{ i18n.ts._noteCleanup.request }}</MkButton>
				<MkSwitch :modelValue="rule.automatic" :disabled="dirty || busy || !rule.enabled" @update:modelValue="setAutomatic">{{ i18n.ts._noteCleanup.automatic }}</MkSwitch>
			</div>
		</fieldset>
	</FormSection>
</div>
</template>
<script lang="ts" setup>
import { computed, nextTick, ref, shallowRef, useTemplateRef } from 'vue';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkButton from '@/components/MkButton.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkInfo from '@/components/MkInfo.vue';
import FormSection from '@/components/form/section.vue';
import ConditionEditor from './note-cleanup/ConditionEditor.vue';
import Preview from './note-cleanup/Preview.vue';
import { conditionNames } from './note-cleanup/labels.js';
import type { CleanupDraft, CleanupRule } from '@/utility/note-cleanup-api.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import type { CleanupFailure } from '@/utility/note-cleanup-errors.js';
import { canRevealCleanupError, cleanupErrorMessage, cleanupFailure } from '@/utility/note-cleanup-errors.js';
import { childrenOf, cloneCondition, conditionAt, createCondition, groupPaths, incompletePaths, keywordLines, moveCondition, removeCondition, replaceCondition, serverConditionPath } from '@/utility/note-cleanup-editor.js';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { definePage } from '@/page.js';
import { useRouter } from '@/router.js';
import * as os from '@/os.js';
const props = defineProps<{ ruleId?: string; action?: string }>();
ensureSignin();
const router = useRouter();

let loaded: CleanupRule | undefined;
if (props.ruleId != null) {
	const { rules } = await cleanupApi.list();
	loaded = rules.find(rule => rule.id === props.ruleId);
	if (!loaded) throw new Error('NO_SUCH_RULE');
}

const rule = shallowRef<CleanupRule | null>(loaded ?? null);
const draft = ref<CleanupDraft>(loaded
	? { name: cleanupRuleName(loaded, i18n.ts._noteCleanup), defaultName: loaded.defaultName, action: loaded.action, condition: structuredClone(loaded.condition) as Condition }
	: { name: '', defaultName: null, action: props.action === 'keep' ? 'keep' : 'delete', condition: createCondition('keyword') });
const savedSnapshot = ref(snapshot());
const busy = ref(false);
const error = ref<CleanupFailure | null>(null);
const previewVersion = ref(0);
const editorRootEl = useTemplateRef<HTMLElement>('editorRootEl');
const actions = [
	{ value: 'delete' as const, label: i18n.ts._noteCleanup.delete },
	{ value: 'keep' as const, label: i18n.ts._noteCleanup.keep },
];
const dirty = computed(() => snapshot() !== savedSnapshot.value);
const activeError = computed(() => error.value ?? (rule.value?.lastError ? { code: rule.value.lastError.code, path: rule.value.lastError.path } : null));

function snapshot(): string {
	return JSON.stringify({ name: draft.value.name, defaultName: draft.value.defaultName, action: draft.value.action, condition: draft.value.condition });
}

function applyRule(next: CleanupRule) {
	rule.value = next;
	draft.value = { name: cleanupRuleName(next, i18n.ts._noteCleanup), defaultName: next.defaultName, action: next.action, condition: structuredClone(next.condition) as Condition };
	savedSnapshot.value = snapshot();
	error.value = null;
	previewVersion.value++;
}

function change(path: number[], value: Condition) {
	draft.value = { ...draft.value, condition: replaceCondition(draft.value.condition, path, value) };
	error.value = null;
}

function remove(path: number[]) {
	draft.value = { ...draft.value, condition: removeCondition(draft.value.condition, path) };
	error.value = null;
}

function duplicate(path: number[]) {
	const parentPath = path.slice(0, -1);
	const parent = conditionAt(draft.value.condition, parentPath);
	if (parent.type !== 'all' && parent.type !== 'any') return;
	const children = [...parent.children];
	children.splice(path.at(-1)! + 1, 0, cloneCondition(conditionAt(draft.value.condition, path)));
	change(parentPath, { ...parent, children });
}

function shift(path: number[], delta: number) {
	const parentPath = path.slice(0, -1);
	const parent = conditionAt(draft.value.condition, parentPath);
	if (parent.type !== 'all' && parent.type !== 'any') return;
	const from = path.at(-1)!;
	const to = from + delta;
	if (to < 0 || to >= parent.children.length) return;
	const children = [...parent.children];
	[children[from], children[to]] = [children[to], children[from]];
	change(parentPath, { ...parent, children });
	os.toast(i18n.ts._noteCleanup.moved);
}

function move(path: number[], anchor: HTMLElement | null) {
	// 자기 자신과 하위 묶음으로는 옮길 수 없다.
	const groups = groupPaths(draft.value.condition).filter(group => !(group.length >= path.length && path.every((value, index) => group[index] === value)));
	let sequence = 0;
	const items = groups.map(group => ({
		icon: 'ti ti-folder',
		text: group.length === 0 ? i18n.ts._noteCleanup.root : `${conditionNames[conditionAt(draft.value.condition, group).type]} ${++sequence}`,
		action: () => {
			try {
				draft.value = { ...draft.value, condition: moveCondition(draft.value.condition, path, group) };
				error.value = null;
				os.toast(i18n.ts._noteCleanup.moved);
			} catch {
				error.value = { code: 'LIMIT', path: '' };
			}
		},
	}));
	os.popupMenu(items, anchor);
}

async function focus(path: number[]) {
	await nextTick();
	const element = editorRootEl.value?.querySelector<HTMLElement>(`[data-condition-path="${path.join('.')}"]`);
	if (!element) return;
	element.scrollIntoView({ block: 'center' });
	const scope = element.querySelector<HTMLElement>(':scope > [data-condition-fields]') ?? element;
	const control = scope.querySelector<HTMLElement>('textarea, input:not([type="checkbox"]), [role="button"][aria-haspopup]');
	// 묶음 안의 첫 자식 입력이 아니라 오류 당사자의 입력란으로 이동한다.
	(control && control.closest('[data-condition-path]') === element ? control : element).focus();
}

function revealError() {
	if (activeError.value) focus(serverConditionPath(activeError.value.path));
}

// 서버는 줄마다 RE2로 검사하지만 저장은 브라우저 정규식으로 먼저 걸러 명백한 오류를 바로 알린다.
function hasInvalidRegex(root: Condition): boolean {
	if (root.type === 'keyword' && root.mode === 'regex') {
		for (const line of keywordLines(root.value)) {
			try { new RegExp(line, root.flags); } catch { return true; }
		}
	}
	return childrenOf(root).some(hasInvalidRegex);
}

async function save() {
	const incomplete = incompletePaths(draft.value.condition);
	if (incomplete.length) {
		error.value = { code: 'INCOMPLETE', path: `condition.${incomplete[0].join('.')}` };
		await focus(incomplete[0]);
		return;
	}
	if (hasInvalidRegex(draft.value.condition)) {
		await os.alert({ type: 'error', title: i18n.ts.regexpError, text: i18n.ts._noteCleanup.ruleError });
		return;
	}
	busy.value = true;
	try {
		const res = await cleanupApi.save(draft.value, rule.value?.id);
		if (!rule.value) {
			router.push('/settings/note-cleanup/:ruleId', { params: { ruleId: res.rule.id } });
			return;
		}
		// 저장 뒤 다시 읽어 오류 해제와 기본 이름 유지 여부를 반영한다.
		const { rules } = await cleanupApi.list();
		applyRule(rules.find(item => item.id === res.rule.id) ?? res.rule);
		os.toast(i18n.ts.saved);
	} catch (e) {
		error.value = cleanupFailure(e);
		if (canRevealCleanupError(error.value.code, error.value.path)) await focus(serverConditionPath(error.value.path));
	} finally {
		busy.value = false;
	}
}

async function toggleEnabled() {
	const current = rule.value;
	if (!current) return;
	const enabling = !current.enabled;
	const name = cleanupRuleName(current, i18n.ts._noteCleanup);
	const text = current.action === 'keep'
		? (enabling ? i18n.ts._noteCleanup.enableKeep : i18n.ts._noteCleanup.disableKeep)
		: (enabling ? i18n.ts._noteCleanup.enableDelete : i18n.ts._noteCleanup.disableDelete);
	const { canceled } = await os.confirm({
		type: 'warning',
		title: enabling ? i18n.tsx._noteCleanup.enableConfirm({ name }) : i18n.tsx._noteCleanup.disableConfirm({ name }),
		text,
		okText: enabling ? i18n.ts._noteCleanup.enable : i18n.ts._noteCleanup.disable,
	});
	if (canceled) return;
	busy.value = true;
	try {
		const res = await cleanupApi.setEnabled(current, enabling);
		applyRule(res.rule);
	} catch (e) {
		error.value = cleanupFailure(e);
	} finally {
		busy.value = false;
	}
}

async function setAutomatic(value: boolean) {
	const current = rule.value;
	if (!current) return;
	if (value) {
		const { canceled } = await os.confirm({
			type: 'warning',
			title: i18n.ts._noteCleanup.automaticConfirmTitle,
			text: i18n.ts._noteCleanup.automaticConfirm,
		});
		if (canceled) return;
	}
	busy.value = true;
	try {
		const res = await cleanupApi.setAutomatic(current, value, value);
		applyRule(res.rule);
	} catch (e) {
		error.value = cleanupFailure(e);
	} finally {
		busy.value = false;
	}
}

async function requestNow() {
	const current = rule.value;
	if (!current) return;
	busy.value = true;
	try {
		const { queued } = await cleanupApi.request([current.id]);
		os.toast(queued ? i18n.ts._noteCleanup.queued : i18n.ts._noteCleanup.notQueued);
	} catch (e) {
		error.value = cleanupFailure(e);
	} finally {
		busy.value = false;
	}
}

async function del() {
	const current = rule.value;
	if (!current) return;
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._noteCleanup.removeRule });
	if (canceled) return;
	busy.value = true;
	try {
		await cleanupApi.delete(current.id);
		router.push('/settings/note-cleanup');
	} catch (e) {
		error.value = cleanupFailure(e);
		busy.value = false;
	}
}

definePage(() => ({
	title: rule.value ? cleanupRuleName(rule.value, i18n.ts._noteCleanup) : i18n.ts._noteCleanup.newRule,
	icon: 'ti ti-history',
}));
</script>
<style lang="scss" module>
.run {
	margin: 0;
	padding: 0;
	border: none;
	min-width: 0;
}
</style>
