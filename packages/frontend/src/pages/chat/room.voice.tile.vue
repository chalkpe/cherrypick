<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- The person keeps the same portrait and name layout, independently of screen sharing. -->
<div ref="rootEl" :class="[small ? $style.compact : $style.root, { [$style.speaking]: speaking }]" :role="small ? undefined : 'group'" :aria-label="small ? undefined : userName(participant.user)">
	<XParticipant
		v-if="small"
		:participant="participant"
		:speaking="speaking"
		:menuable="menuable"
		@openMenu="emit('openMenu', $event)"
	/>
	<template v-else>
		<div :class="$style.actions">
			<button v-if="menuable" v-tooltip="i18n.ts.menu" type="button" class="_button" :class="$style.action" :aria-label="i18n.ts.menu" data-voice-call-action="menu" @click="emit('openMenu', $event)"><i class="ti ti-dots" aria-hidden="true"></i></button>
		</div>
		<div :class="$style.body">
			<div :class="$style.avatarFrame"><MkAvatar :user="participant.user" :link="false" :preview="false" :class="$style.avatar"/></div>
			<div :class="$style.who">
				<div v-if="participant.micMuted || participant.deafened" :class="$style.status">
					<i v-if="participant.micMuted && !participant.deafened" v-tooltip="i18n.ts._voiceCall.micMuted" class="ti ti-microphone-off" role="img" :aria-label="i18n.ts._voiceCall.micMuted"></i>
					<i v-if="participant.deafened" v-tooltip="i18n.ts._voiceCall.deafened" class="ti ti-headphones-off" role="img" :aria-label="i18n.ts._voiceCall.deafened"></i>
				</div>
				<MkUserName :user="participant.user" :class="$style.name"/>
			</div>
		</div>
	</template>
</div>
</template>

<script lang="ts" setup>
import { nextTick, useTemplateRef, watch } from 'vue';
import type * as Misskey from 'cherrypick-js';
import XParticipant from './room.voice.participant.vue';
import { i18n } from '@/i18n.js';
import { userName } from '@/filters/user.js';

const props = withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	speaking: boolean;
	menuable?: boolean;
	small?: boolean;
}>(), { menuable: false, small: false });

const emit = defineEmits<{
	(ev: 'openMenu', event: MouseEvent): void;
}>();

const rootEl = useTemplateRef('rootEl');
watch(() => props.small, async () => {
	const active = window.document.activeElement;
	if (!(active instanceof HTMLElement) || !rootEl.value?.contains(active)) return;
	const action = active.getAttribute('data-voice-call-action');
	if (action == null) return;
	await nextTick();
	// Do not steal focus from a menu or another control opened during this update.
	if (window.document.activeElement !== window.document.body && window.document.activeElement !== active) return;
	rootEl.value?.querySelector<HTMLElement>(`[data-voice-call-action="${action}"]`)?.focus({ preventScroll: true });
});
</script>

<style lang="scss" module>
.compact {
	flex-shrink: 0;
	width: max-content;
	max-width: 100%;
}

.root {
	--voiceCallAvatarSize: 64px;
	position: relative;
	display: block;
	box-sizing: border-box;
	width: 220px;
	max-width: 100%;
	height: 220px;
	padding: 10px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
}

.actions {
	position: absolute;
	z-index: 1;
	top: 10px;
	right: 10px;
	display: flex;
	justify-content: flex-end;
	gap: 4px;
}

.actions .action {
	display: grid;
	place-items: center;
	box-sizing: border-box;
	width: 28px;
	height: 28px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: calc(var(--MI-radius) / 2);
	background: var(--MI_THEME-buttonBg);
	color: var(--MI_THEME-fg);

	&:hover { background: var(--MI_THEME-buttonHoverBg); }
	&:focus-visible { outline: 2px solid var(--MI_THEME-accent); outline-offset: 2px; }
}

.body {
	display: contents;
	min-width: 0;
	min-height: 0;
}

.avatarFrame {
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	display: grid;
	place-items: center;
	width: calc(var(--voiceCallAvatarSize) * 2);
	height: calc(var(--voiceCallAvatarSize) * 2);
	overflow: clip;
}

.avatar {
	flex-shrink: 0;
	width: var(--voiceCallAvatarSize);
	height: var(--voiceCallAvatarSize);
}

.root.speaking {
	outline: 2px solid var(--MI_THEME-success);
	outline-offset: -2px;
}

.who {
	position: absolute;
	left: 10px;
	top: calc(50% + var(--voiceCallAvatarSize) / 2 + 12px);
	display: flex;
	justify-content: center;
	align-items: center;
	gap: 4px;
	width: calc(100% - 20px);
	min-width: 0;
}

.status {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 4px;
	flex: 0 0 auto;
	color: color-mix(in srgb, var(--MI_THEME-fg) 72%, var(--MI_THEME-panel));
	font-size: 12px;
}

.name {
	display: block;
	min-width: 0;
	max-height: 1.4em;
	overflow: hidden;
	font-size: 0.9em;
	font-weight: 600;
	line-height: 1.4;
	text-align: center;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
