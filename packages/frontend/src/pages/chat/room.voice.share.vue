<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component
	:is="watchable ? 'button' : 'div'"
	v-tooltip="label"
	:type="watchable ? 'button' : undefined"
	:class="[$style.root, { '_button': watchable, [$style.compact]: compact, [$style.watching]: watching }]"
	:role="watchable ? undefined : 'img'"
	:aria-label="watchable ? label : i18n.ts._voiceCall.sharingScreen"
	:aria-pressed="watchable ? watching : undefined"
	:data-voice-call-watch-toggle="watchable ? participant.identity : undefined"
	@click="watchable && emit('toggleWatch')"
>
	<XPreview v-if="watchable" :identity="participant.identity" :class="$style.preview"/>
	<div v-else :class="[$style.preview, $style.placeholder]"><i class="ti ti-screen-share" aria-hidden="true"></i></div>
	<div :class="$style.caption">
		<i class="ti ti-screen-share" aria-hidden="true"></i>
		<MkUserName :user="participant.user" :class="$style.name"/>
	</div>
</component>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type * as Misskey from 'cherrypick-js';
import XPreview from './room.voice.preview.vue';
import { i18n } from '@/i18n.js';
import { userName } from '@/filters/user.js';

const props = withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	watchable?: boolean;
	watching?: boolean;
	compact?: boolean;
}>(), { watchable: false, watching: false, compact: false });

const emit = defineEmits<{ (ev: 'toggleWatch'): void }>();
const label = computed(() => i18n.tsx._voiceCall.watchScreenOf({ name: userName(props.participant.user) }));
</script>

<style lang="scss" module>
.root:is(button, div) {
	display: grid;
	flex-shrink: 0;
	grid-template-rows: minmax(0, 1fr) auto;
	box-sizing: border-box;
	width: 240px;
	max-width: 100%;
	padding: 4px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
	color: var(--MI_THEME-fg);
	text-align: left;

	&.watching {
		border-color: var(--MI_THEME-accent);
		background: var(--MI_THEME-accentedBg);
	}

	&:is(button):hover {
		background: var(--MI_THEME-panelHighlight);
	}

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-accent);
		outline-offset: 2px;
	}

	&.compact {
		grid-template-columns: 56px minmax(0, 1fr);
		grid-template-rows: auto;
		align-items: center;
		width: 192px;
	}
}

.root .preview {
	width: 100%;
	border-radius: calc(var(--MI-radius) - 5px);
}

.placeholder {
	display: grid;
	place-items: center;
	aspect-ratio: 16 / 9;
	background: var(--MI_THEME-bg);
}

.caption {
	display: grid;
	grid-template-columns: 16px minmax(0, 1fr);
	align-items: center;
	gap: 6px;
	min-width: 0;
	padding: 6px;
	font-size: 0.8em;
}

.name {
	display: block;
	min-width: 0;
	max-height: 1.4em;
	overflow: hidden;
	line-height: 1.4;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
