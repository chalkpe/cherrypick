<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- Identity and reported settings are passive; all controls share one separate action area. -->
<component
	:is="summary ? 'button' : 'div'"
	:type="summary ? 'button' : undefined"
	:class="[$style.root, { '_button': summary, [$style.summary]: summary, [$style.squareAvatar]: squareAvatar, [$style.speaking]: speaking }]"
	:role="summary ? undefined : 'group'" :aria-label="userName(participant.user)"
	:aria-haspopup="summary && menuable ? 'menu' : undefined"
	:disabled="summary && !menuable ? true : undefined"
	@click="summary && menuable && emit('openMenu', $event)"
	@contextmenu="onContextMenu"
>
	<div :class="$style.avatarFrame"><MkAvatar :user="participant.user" :link="false" :preview="false" :class="$style.avatar"/></div>
	<div :class="$style.identity">
		<div :class="$style.status">
			<i v-if="participant.micMuted && !participant.deafened" v-tooltip="i18n.ts._voiceCall.micMuted" class="ti ti-microphone-off" role="img" :aria-label="i18n.ts._voiceCall.micMuted"></i>
			<i v-if="participant.deafened" v-tooltip="i18n.ts._voiceCall.deafened" class="ti ti-headphones-off" role="img" :aria-label="i18n.ts._voiceCall.deafened"></i>
			<i v-if="participant.screenSharing" v-tooltip="i18n.ts._voiceCall.sharingScreen" class="ti ti-screen-share" role="img" :aria-label="i18n.ts._voiceCall.sharingScreen"></i>
		</div>
		<MkUserName :user="participant.user" :class="$style.name"/>
	</div>
	<div v-if="!summary && menuable" :class="$style.actions">
		<button
			v-if="menuable"
			v-tooltip="i18n.ts.menu" type="button" class="_button"
			:class="$style.action" :aria-label="i18n.ts.menu"
			data-voice-call-action="menu"
			@click="emit('openMenu', $event)"
		>
			<i class="ti ti-dots" aria-hidden="true"></i>
		</button>
	</div>
</component>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import { i18n } from '@/i18n.js';
import { userName } from '@/filters/user.js';
import { isSquareAvatar } from '@/utility/avatar-shape.js';

const props = withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	speaking: boolean;
	menuable?: boolean;
	volumable?: boolean;
	summary?: boolean;
}>(), {
	menuable: false,
	volumable: false,
	summary: false,
});

const emit = defineEmits<{
	(ev: 'openMenu', event: MouseEvent): void;
	(ev: 'openVolume', event: MouseEvent): void;
}>();

function onContextMenu(event: MouseEvent) {
	if (!props.summary || !props.menuable) return;
	event.preventDefault();
	emit('openMenu', event);
}

const squareAvatar = computed(() => isSquareAvatar(props.participant.user));
</script>

<style lang="scss" module>
.root.summary {
	display: grid;
	grid-template-columns: 48px minmax(0, 1fr);
	gap: 6px;
	min-height: 54px;
	padding: 2px 6px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: calc(var(--MI-radius) * 0.75);
	background: var(--MI_THEME-panelHighlight);
	text-align: left;

	.avatar { width: 24px; height: 24px; }
	&:focus-visible { outline: 2px solid var(--MI_THEME-accent); outline-offset: 2px; }
	&:not(:disabled):hover { background: var(--MI_THEME-buttonHoverBg); }
}

.root {
	display: grid;
	grid-template-columns: 48px minmax(0, 1fr) auto;
	flex-shrink: 0;
	align-items: center;
	gap: 8px;
	box-sizing: border-box;
	width: max-content;
	max-width: 100%;
	min-width: 0;
	min-height: 54px;
	padding: 2px 6px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
}

.avatarFrame {
	display: grid;
	place-items: center;
	width: 48px;
	height: 48px;
	overflow: clip;
}

.avatar {
	flex-shrink: 0;
	width: 24px;
	height: 24px;
	border-radius: 50%;
}

.squareAvatar .avatar {
	border-radius: 20%;
}

.speaking .avatar {
	outline: 2px solid var(--MI_THEME-success);
	outline-offset: 3px;
}

.identity {
	display: grid;
	grid-template-columns: auto minmax(0, 96px);
	align-items: center;
	gap: 6px;
	min-width: 0;
}

.name {
	display: block;
	grid-column: 2;
	max-height: 1.4em;
	min-width: 0;
	max-width: 96px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.9em;
	font-weight: 600;
	line-height: 1.4;
}

.status {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: 4px;
	color: color-mix(in srgb, var(--MI_THEME-fg) 72%, var(--MI_THEME-panel));
	font-size: 12px;
}

.actions {
	display: flex;
	align-items: center;
	flex-shrink: 0;
	gap: 4px;
	padding-left: 6px;
	border-left: 1px solid var(--MI_THEME-divider);
}

.actions .action {
	position: relative;
	display: grid;
	place-items: center;
	box-sizing: border-box;
	width: 28px;
	height: 28px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: calc(var(--MI-radius) / 2);
	background: var(--MI_THEME-buttonBg);
	color: var(--MI_THEME-fg);
	font-size: 16px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-accent);
		outline-offset: 2px;
	}

	&[aria-pressed="true"] {
		border-color: var(--MI_THEME-accent);
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
	}
}

</style>
