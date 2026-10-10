<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModal ref="modal" v-slot="{ type }" :zPriority="'high'" :anchorElement="anchorElement" @click="modal?.close()" @closed="emit('closed')" @esc="modal?.close()">
	<div :class="{ [$style.root]: true, [$style.asDrawer]: type === 'drawer', _popup: !prefer.s.useBlurEffect || !prefer.s.useBlurEffectForModal || !prefer.s.removeModalBgColorForBlur, _popupAcrylic: prefer.s.useBlurEffect && prefer.s.useBlurEffectForModal && prefer.s.removeModalBgColorForBlur }">
		<div :class="$style.header">
			<div :class="[$style.label, $style.item]">{{ i18n.ts.visibility }}</div>
			<MkA v-if="noteVisibilityLimit !== 'none'" v-tooltip="i18n.ts._noteVisibilityLimit.label" to="/settings/privacy" :class="$style.settings" :aria-label="i18n.ts._noteVisibilityLimit.label" @click="modal?.close()">
				<i class="ti ti-settings" aria-hidden="true"></i>
			</MkA>
		</div>
		<div
			v-for="(option, index) in options"
			:key="option.visibility"
			v-tooltip="option.lockMessage"
			:title="option.lockMessage ?? undefined"
			:tabindex="option.lockMessage ? 0 : undefined"
			:role="option.lockMessage ? 'group' : undefined"
			:aria-label="option.lockMessage ? `${i18n.ts._visibility[option.visibility]}. ${option.lockMessage}` : undefined"
			:class="{ [$style.locked]: option.lockMessage != null }"
		>
			<button
				:disabled="option.lockMessage != null"
				:aria-disabled="option.lockMessage != null"
				:aria-description="option.lockMessage ?? undefined"
				class="_button"
				:class="[$style.item, { [$style.active]: v === option.visibility }]"
				:data-index="index + 1"
				@click="choose(option.visibility)"
			>
				<div :class="$style.icon"><i :class="['ti', option.icon]"></i></div>
				<div :class="$style.body">
					<span :class="$style.itemTitle">{{ i18n.ts._visibility[option.visibility] }}</span>
					<span :class="$style.itemDescription">{{ i18n.ts._visibility[`${option.visibility}Description`] }}</span>
				</div>
				<i v-if="option.lockMessage" class="ti ti-lock" :class="$style.lockIcon" aria-hidden="true"></i>
			</button>
		</div>

		<MkDivider style="margin: 5px 0;"/>

		<div :class="$style.item">
			<MkSwitch v-model="rememberNoteVisibility">{{ i18n.ts.rememberNoteVisibility }}</MkSwitch>
		</div>
	</div>
</MkModal>
</template>

<script lang="ts" setup>
import { computed, nextTick, useTemplateRef, ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import type { NoteVisibilityLimit } from '@/utility/note-visibility-limit.js';
import { getNoteVisibilityLockReason } from '@/utility/note-visibility-limit.js';
import MkModal from '@/components/MkModal.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkDivider from '@/components/MkDivider.vue';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';

const modal = useTemplateRef('modal');

const props = withDefaults(defineProps<{
	currentVisibility: typeof Misskey.noteVisibilities[number];
	isSilenced: boolean;
	noteVisibilityLimit?: NoteVisibilityLimit;
	anchorElement?: HTMLElement | null;
	isReplyVisibilitySpecified?: boolean;
}>(), {
	noteVisibilityLimit: 'none',
});

const emit = defineEmits<{
	(ev: 'changeVisibility', v: typeof Misskey.noteVisibilities[number]): void;
	(ev: 'closed'): void;
}>();

const rememberNoteVisibility = prefer.model('rememberNoteVisibility');

const v = ref(props.currentVisibility);

const options = computed(() => ([
	{ visibility: 'public', icon: 'ti-world' },
	{ visibility: 'home', icon: 'ti-home' },
	{ visibility: 'followers', icon: 'ti-lock' },
	{ visibility: 'specified', icon: 'ti-mail' },
] as const).map(option => {
	const reason = getNoteVisibilityLockReason(option.visibility, props.noteVisibilityLimit, props.isSilenced, props.isReplyVisibilitySpecified);
	return { ...option, lockMessage: reason == null ? null : i18n.ts._noteVisibilityLimit[`${reason}Locked`] };
}));

function choose(visibility: typeof Misskey.noteVisibilities[number]): void {
	if (getNoteVisibilityLockReason(visibility, props.noteVisibilityLimit, props.isSilenced, props.isReplyVisibilitySpecified) != null) return;
	v.value = visibility;
	emit('changeVisibility', visibility);
	nextTick(() => {
		if (modal.value) modal.value.close();
	});
}
</script>

<style lang="scss" module>
.root {
	min-width: 240px;
	padding: 8px 0;

	&.asDrawer {
		padding: 12px 0 max(env(safe-area-inset-bottom, 0px), 12px) 0;
		width: 100%;
		border-radius: 24px;
		border-bottom-right-radius: 0;
		border-bottom-left-radius: 0;

		.label {
			pointer-events: none;
			font-size: 12px;
			padding-bottom: 4px;
			opacity: 0.7;
		}

		.item {
			font-size: 14px;
			padding: 10px 24px;
		}
	}
}

.label {
	pointer-events: none;
	font-size: 10px;
	padding-bottom: 4px;
	opacity: 0.7;
}

.header {
	display: flex;
	align-items: center;
}

.settings {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 32px;
	height: 32px;
	margin-right: 8px;
	border-radius: var(--MI-radius);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.item {
	display: flex;
	padding: 8px 14px;
	font-size: 12px;
	text-align: left;
	width: 100%;
	box-sizing: border-box;

	&:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	&:active {
		background: rgba(0, 0, 0, 0.1);
	}

	&.active {
		color: var(--MI_THEME-accent);
	}
}

.locked {
	cursor: not-allowed;
	background: var(--MI_THEME-buttonBg);

	button {
		opacity: 0.5;
		pointer-events: none;
	}
}

.locked:focus-within {
	outline: 2px solid var(--MI_THEME-focus);
}

.lockIcon {
	align-self: center;
	margin-left: 12px;
}

.icon {
	display: flex;
	justify-content: center;
	align-items: center;
	margin-right: 10px;
	width: 16px;
	top: 0;
	bottom: 0;
	margin-top: auto;
	margin-bottom: auto;
}

.body {
	flex: 1 1 auto;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.itemTitle {
	display: block;
	font-weight: bold;
}

.itemDescription {
	opacity: 0.6;
}
</style>
